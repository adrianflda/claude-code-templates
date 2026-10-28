#!/usr/bin/env node
/**
 * pre-push-review v2 — review harness (project-agnostic; zero dependencies).
 *
 * Reviews a change with deterministic tools and a panel of read-only reviewer agents that can
 * explore the repository, then has an independent verifier try to refute every finding before
 * it is reported.
 *
 * Usage:
 *   review.mjs [review] [scope] [options]      review a change
 *   review.mjs learn --reject <id> --reason "<why>" [--paths a,b] [--scope repo|user]
 *   review.mjs learn --rule "<text>" [--paths a,b] [--scope repo|user]
 *   review.mjs learnings [--json]              list learnings and how often each was applied
 *   review.mjs forget <learning-id>            remove a learning
 *   review.mjs stats [--days N] [--json]       metrics over past runs
 *   review.mjs doctor                          check the environment
 *
 * Scope (default: staged changes, else uncommitted changes, else commits about to be pushed):
 *   --staged | --working | --branch | --base <ref> | --pr <n>
 *   --incremental      only what changed since the last complete review of this scope
 *   --full             ignore incremental state (pull requests are incremental by default)
 *
 * Options:
 *   --quick            one generalist reviewer instead of the specialist panel
 *   --no-verify        skip the verification pass
 *   --no-summary       skip the change summary
 *   --no-tools         skip deterministic tools
 *   --no-repo-commands skip the repo's own lint/typecheck commands
 *   --format <f>       text (default) | markdown | json | ndjson
 *   --output <file>    also write the report to a file
 *   --post             publish to the pull request (needs --pr); never implied
 *   --dry-run          with --post: print what would be published, publish nothing
 *   --cwd <dir>        run as if started in <dir>
 *
 * Exit codes: 0 = no blocking findings, 1 = blocking findings, 2 = the harness could not run.
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { resolveClaudeBin } from './lib/agent.mjs';
import { CONFIG_FILE, loadConfig } from './lib/config.mjs';
import { repoRoot, shortSha } from './lib/git.mjs';
import { fetchExistingComments, planReview, postReview } from './lib/github.mjs';
import { addLearning, loadLearnings, loadUsage, removeLearning } from './lib/learnings.mjs';
import { isComplete, runReview, VERSION } from './lib/pipeline.mjs';
import { completeness, FORMATS, render, toSerializable } from './lib/report.mjs';
import { anchorFiles, resolveScope, ScopeError } from './lib/scope.mjs';
import { loadLastResult, readJsonl, recordRun, runLedgerPath, saveLastResult, setReviewed } from './lib/state.mjs';
import { isInstalled } from './lib/tools.mjs';

const COMMANDS = ['review', 'learn', 'learnings', 'forget', 'stats', 'doctor'];
const VALUE_FLAGS = new Set(['--base', '--pr', '--format', '--output', '--cwd', '--reject', '--reason', '--rule', '--paths', '--scope', '--days']);
const BOOLEAN_FLAGS = new Set([
  '--staged', '--working', '--branch', '--incremental', '--full', '--quick', '--no-verify', '--no-summary',
  '--no-tools', '--no-repo-commands', '--post', '--dry-run', '--json', '--help', '-h',
]);

class UsageError extends Error {}

export function parseArgs(argv) {
  const args = { command: 'review', flags: {}, positional: [] };
  let i = 0;
  if (argv[0] && COMMANDS.includes(argv[0])) {
    args.command = argv[0];
    i = 1;
  }
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE_FLAGS.has(a)) {
      const v = argv[i + 1];
      if (v === undefined || (v.startsWith('--') && a !== '--reason' && a !== '--rule')) throw new UsageError(`${a} needs a value`);
      args.flags[a.slice(2)] = v;
      i += 1;
    } else if (BOOLEAN_FLAGS.has(a)) {
      args.flags[a.replace(/^-+/, '')] = true;
    } else if (a.startsWith('-')) {
      throw new UsageError(`unknown option ${a}`);
    } else {
      args.positional.push(a);
    }
  }
  return args;
}

function scopeMode(flags) {
  const chosen = ['staged', 'working', 'branch'].filter((m) => flags[m]);
  if (flags.base) chosen.push('base');
  if (flags.pr) chosen.push('pr');
  if (chosen.length > 1) throw new UsageError(`choose one scope, not ${chosen.map((c) => `--${c}`).join(' and ')}`);
  return chosen[0] ?? 'auto';
}

function out(text) {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

function info(text) {
  process.stderr.write(`[pre-push-review] ${text}\n`);
}

function listPaths(value) {
  return value ? value.split(',').map((p) => p.trim()).filter(Boolean) : [];
}

// --- review -----------------------------------------------------------------------------------

async function commandReview(flags, cwd, env) {
  if (env.PREPUSH_REVIEW_SKIP === '1' || env.AI_REVIEW_SKIP === '1') {
    info('Skipped (PREPUSH_REVIEW_SKIP=1).');
    return 0;
  }
  const format = flags.format ?? 'text';
  if (!FORMATS.includes(format)) throw new UsageError(`--format must be one of ${FORMATS.join(', ')}`);
  if (flags.post && !flags.pr) throw new UsageError('--post publishes to a pull request and needs --pr <n>');
  if (flags['dry-run'] && !flags.post) throw new UsageError('--dry-run only applies together with --post');

  const root = repoRoot(cwd);
  if (!root) throw new ScopeError(`${cwd} is not inside a git repository`);
  const { config, source, errors } = loadConfig(root, env);
  if (errors.length) {
    for (const e of errors) info(`config: ${e}`);
    info(`Fix ${CONFIG_FILE} (or the environment overrides) and run again.`);
    return 2;
  }
  if (flags.quick) config.profile = 'quick';

  const scope = resolveScope({
    cwd: root,
    mode: scopeMode(flags),
    base: flags.base,
    pr: flags.pr,
    incremental: Boolean(flags.incremental),
    full: Boolean(flags.full),
    exclude: config.exclude,
  });

  try {
    if (scope.files.length === 0) {
      const why = scope.notes.length ? ` (${scope.notes.join('; ')})` : '';
      info(`No code changes to review in ${scope.description}${why}.`);
      return 0;
    }
    info(`Reviewing ${scope.description}: ${scope.stats.files} file(s), +${scope.stats.additions} / -${scope.stats.deletions} [config: ${source}]`);

    const result = await runReview({
      scope,
      config,
      options: {
        verify: config.verify && !flags['no-verify'],
        summary: config.summary && !flags['no-summary'],
        tools: !flags['no-tools'],
        repoCommands: !flags['no-repo-commands'],
      },
      env,
      log: info,
    });

    const report = render(result, format);
    out(report);
    if (flags.output) writeFileSync(resolve(cwd, flags.output), report + '\n');

    saveLastResult(root, toSerializable(result));
    const complete = isComplete(result);
    if (complete && scope.headKind === 'commit') setReviewed(root, scope.key, { headSha: scope.headSha, baseSha: scope.baseSha });
    recordRun(
      {
        ts: result.startedAt,
        version: VERSION,
        repo: root,
        mode: scope.mode,
        key: scope.key,
        headSha: scope.headSha,
        files: scope.stats.files,
        additions: scope.stats.additions,
        deletions: scope.stats.deletions,
        profile: config.profile,
        counts: result.counts,
        blocking: result.blocking.length,
        verification: { ran: result.verification.ran, confirmed: result.verification.confirmed, refuted: result.verification.refuted, unverifiable: result.verification.unverifiable },
        dropped: result.dropped.length,
        complete,
        costUsd: result.costUsd,
        durationMs: result.durationMs,
      },
      env,
    );

    if (flags.post) {
      const anchors = new Map(anchorFiles(scope, config.exclude).map((f) => [f.path, f]));
      const plan = planReview(result, anchors, flags['dry-run'] ? [] : fetchExistingComments(scope.pr, root));
      if (flags['dry-run']) {
        info(`DRY RUN — nothing was published. Would post ${plan.comments.length} inline comment(s) and this summary to ${scope.pr.url}:`);
        out(plan.body);
        for (const c of plan.comments) out(`\n--- inline ${c.path}:${c.start_line ? `${c.start_line}-` : ''}${c.line}\n${c.body}`);
      } else {
        const posted = postReview({ plan, result, cwd: root });
        if (posted.inlineFailed) info(`Inline comments were rejected by GitHub (${posted.inlineFailed}); every finding is listed in the summary comment instead.`);
        if (posted.ok) info(`Posted to ${posted.summaryUrl ?? scope.pr.url}: summary and ${posted.inlinePosted} inline comment(s)${plan.skipped.length ? `, ${plan.skipped.length} already posted earlier` : ''}.`);
        else {
          info(`Could not post the summary: ${posted.error}`);
          return 2;
        }
      }
    }

    if (result.allReviewersFailed) {
      if (config.required) {
        info('Every reviewer failed — blocking (required=true).');
        return 2;
      }
      info('Every reviewer failed — this review found nothing because nothing ran. Not blocking (required=false).');
    }
    const gaps = completeness(result);
    if (gaps.length && !result.allReviewersFailed) info(`Partial review: ${gaps.join('; ')}.`);
    return result.blocking.length > 0 ? 1 : 0;
  } finally {
    scope.cleanup();
  }
}

// --- learnings --------------------------------------------------------------------------------

function commandLearn(flags, cwd, env) {
  const root = repoRoot(cwd);
  if (!root) throw new ScopeError(`${cwd} is not inside a git repository`);
  const scope = flags.scope ?? 'repo';
  let author = null;
  try {
    author = execFileSync('git', ['config', 'user.name'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    /* no configured author */
  }

  if (flags.reject) {
    if (!flags.reason) throw new UsageError('--reject needs --reason "<why the finding is wrong>"');
    const last = loadLastResult(root);
    if (!last) throw new UsageError('no previous review found in this repository; run a review first');
    const finding = [...last.findings, ...last.dropped].find((f) => f.id === flags.reject);
    if (!finding) throw new UsageError(`the last review has no finding ${flags.reject} (it has: ${last.findings.map((f) => f.id).join(', ') || 'none'})`);
    const row = addLearning(
      {
        root,
        scope,
        kind: 'rejection',
        text: `A finding "${finding.title}" was raised on ${finding.file} and rejected by the team: ${flags.reason}`,
        paths: flags.paths ? listPaths(flags.paths) : [finding.file],
        finding,
        author,
      },
      env,
    );
    out(`Recorded ${row.id} (${row.scope} scope, applies to ${row.paths.join(', ')}).`);
    return 0;
  }
  if (flags.rule) {
    const row = addLearning({ root, scope, kind: 'rule', text: flags.rule, paths: listPaths(flags.paths), author }, env);
    out(`Recorded ${row.id} (${row.scope} scope${row.paths.length ? `, applies to ${row.paths.join(', ')}` : ', applies everywhere'}).`);
    return 0;
  }
  throw new UsageError('learn needs --reject <finding-id> --reason "<why>" or --rule "<text>"');
}

function commandLearnings(flags, cwd, env) {
  const root = repoRoot(cwd);
  if (!root) throw new ScopeError(`${cwd} is not inside a git repository`);
  const usage = loadUsage(env);
  const rows = loadLearnings(root, env).map((l) => ({ ...l, used: usage[l.id]?.count ?? 0, lastUsed: usage[l.id]?.lastUsed ?? null }));
  if (flags.json) {
    out(JSON.stringify(rows, null, 2));
    return 0;
  }
  if (rows.length === 0) {
    out('No learnings recorded.');
    return 0;
  }
  for (const l of rows) {
    out(`${l.id}  ${l.kind.padEnd(9)} ${l.scope.padEnd(4)} used ${String(l.used).padStart(3)}x  ${l.paths.length ? l.paths.join(', ') : '(everywhere)'}`);
    out(`    ${l.text}`);
  }
  const never = rows.filter((l) => l.used === 0).length;
  out(`\n${rows.length} learning(s), ${never} never applied.`);
  return 0;
}

function commandForget(positional, cwd, env) {
  const root = repoRoot(cwd);
  if (!root) throw new ScopeError(`${cwd} is not inside a git repository`);
  const id = positional[0];
  if (!id) throw new UsageError('forget needs a learning id');
  const removed = removeLearning(root, id, env);
  if (!removed) {
    info(`No learning with id ${id}.`);
    return 2;
  }
  out(`Removed ${removed.id} (${removed.scope} scope).`);
  return 0;
}

// --- stats ------------------------------------------------------------------------------------

export function aggregateRuns(rows) {
  const total = { runs: rows.length, complete: 0, blocked: 0, costUsd: 0, durationMs: 0, findings: 0, confirmed: 0, refuted: 0, unverifiable: 0 };
  for (const r of rows) {
    if (r.complete) total.complete += 1;
    if (r.blocking > 0) total.blocked += 1;
    total.costUsd += r.costUsd ?? 0;
    total.durationMs += r.durationMs ?? 0;
    total.findings += Object.values(r.counts ?? {}).reduce((a, b) => a + b, 0);
    total.confirmed += r.verification?.confirmed ?? 0;
    total.refuted += r.verification?.refuted ?? 0;
    total.unverifiable += r.verification?.unverifiable ?? 0;
  }
  const judged = total.confirmed + total.refuted + total.unverifiable;
  return {
    ...total,
    avgCostUsd: rows.length ? total.costUsd / rows.length : 0,
    avgDurationMs: rows.length ? total.durationMs / rows.length : 0,
    // Share of reviewer findings the verifier threw out: how noisy the reviewers are.
    refuteRate: judged ? total.refuted / judged : null,
  };
}

function commandStats(flags, env) {
  const days = flags.days ? Number(flags.days) : 30;
  if (!Number.isFinite(days) || days <= 0) throw new UsageError('--days must be a positive number');
  const since = Date.now() - days * 86_400_000;
  const rows = readJsonl(runLedgerPath(env)).filter((r) => Date.parse(r.ts) >= since);
  const byRepo = new Map();
  for (const r of rows) byRepo.set(r.repo, [...(byRepo.get(r.repo) ?? []), r]);
  const report = { days, all: aggregateRuns(rows), repos: Object.fromEntries([...byRepo].map(([repo, rs]) => [repo, aggregateRuns(rs)])) };
  if (flags.json) {
    out(JSON.stringify(report, null, 2));
    return 0;
  }
  const line = (label, a) =>
    `${label}\n  runs ${a.runs} (${a.complete} complete, ${a.blocked} blocked) · findings ${a.findings} · verifier: ${a.confirmed} confirmed, ${a.refuted} refuted, ${a.unverifiable} undecided` +
    `${a.refuteRate == null ? '' : ` (${(a.refuteRate * 100).toFixed(0)}% refuted)`} · avg cost $${a.avgCostUsd.toFixed(2)} · avg time ${(a.avgDurationMs / 1000).toFixed(0)}s`;
  out(line(`Last ${days} day(s), all repositories`, report.all));
  for (const [repo, a] of Object.entries(report.repos)) out(line(repo, a));
  if (rows.length === 0) out('No runs recorded in this period.');
  return 0;
}

// --- doctor -----------------------------------------------------------------------------------

function version(bin, args) {
  try {
    return execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n')[0];
  } catch {
    return null;
  }
}

async function commandDoctor(cwd, env) {
  let problems = 0;
  const check = (ok, label, detail) => {
    if (!ok) problems += 1;
    out(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  };
  const note = (label, detail) => out(`note  ${label}${detail ? ` — ${detail}` : ''}`);

  const bin = resolveClaudeBin(env);
  const claudeVersion = version(bin, ['--version']);
  check(Boolean(claudeVersion), 'claude CLI', claudeVersion ?? `not runnable at ${bin}`);
  const ghVersion = version('gh', ['--version']);
  if (ghVersion) note('gh CLI', `${ghVersion} (needed only for --pr and --post)`);
  else note('gh CLI', 'not installed; --pr and --post are unavailable');
  if (await isInstalled('gitleaks')) note('gitleaks', version('gitleaks', ['version']));
  else note('gitleaks', 'not installed; secret scanning is skipped');

  const root = repoRoot(cwd);
  if (!root) note('repository', `${cwd} is not inside a git repository`);
  else {
    const { source, errors } = loadConfig(root, env);
    check(errors.length === 0, `configuration (${source})`, errors.join('; '));
    note('learnings', `${loadLearnings(root, env).length} visible from this repository`);
    const last = loadLastResult(root);
    note('last review', last ? `${last.scope.description} at ${shortSha(last.scope.headSha) || last.scope.headKind}, ${last.findings.length} finding(s)` : 'none');
  }
  return problems === 0 ? 0 : 2;
}

// --- main -------------------------------------------------------------------------------------

export async function main(argv, env = process.env) {
  let args;
  try {
    args = parseArgs(argv);
    if (args.flags.help || args.flags.h) {
      out('Usage: review.mjs [review|learn|learnings|forget|stats|doctor] [options]  (see the header of this file)');
      return 0;
    }
    const cwd = resolve(args.flags.cwd ?? process.cwd());
    switch (args.command) {
      case 'learn':
        return commandLearn(args.flags, cwd, env);
      case 'learnings':
        return commandLearnings(args.flags, cwd, env);
      case 'forget':
        return commandForget(args.positional, cwd, env);
      case 'stats':
        return commandStats(args.flags, env);
      case 'doctor':
        return await commandDoctor(cwd, env);
      default:
        return await commandReview(args.flags, cwd, env);
    }
  } catch (e) {
    if (e instanceof UsageError || e instanceof ScopeError || e.name === 'GitError') {
      info(e.message);
      return 2;
    }
    info(`unexpected error: ${e.stack || e.message}`);
    return 2;
  }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const code = await main(process.argv.slice(2));
  // Exit explicitly once output is flushed. Leaving it to the event loop would let one stray
  // handle (a child that ignored its kill signal, say) hang a `git push` forever.
  process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
}
