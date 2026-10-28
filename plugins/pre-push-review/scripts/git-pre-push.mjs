#!/usr/bin/env node
/**
 * pre-push-review — the single review runner, invoked by git itself as a pre-push hook.
 *
 * It is installed once per machine as a git config hook (see ./install-git-hook.mjs):
 *
 *   hook.ai-review.event   = pre-push
 *   hook.ai-review.command = node <plugin>/scripts/git-pre-push.mjs
 *
 * Config hooks run in every repository, also when a repository sets its own core.hooksPath
 * (husky and friends), so the review applies to every `git push`, by Claude or by a human.
 *
 * It reviews exactly what git says is being pushed. For every ref on stdin it computes the
 * commits that are new to the remote: `<remote sha>..<local sha>` when the remote already has
 * the ref, otherwise the commits not on any ref of that remote (a new branch, or the first
 * push to an empty remote, where the review starts from the empty tree). Each range is passed
 * to the bundled panel (./ai-review-panel.mjs --range <base> <head>), so pushing a branch that
 * is not checked out reviews that branch, not HEAD; the panel is also told which ref is pushed
 * (AI_REVIEW_PUSH_REF), so it can find that branch's PR and ticket. Without a clean list of refs it falls back
 * to `--branch` (the panel's own guess). It streams the panel output to the terminal, keeps the full log in ~/.cache/git-ai-review/review-<sha>.log
 * and exits 0 only when the review finished and found nothing blocking (or there is nothing to
 * review, e.g. a branch deletion). It fails closed: a missing, killed, timed out or unstartable
 * panel exits 1.
 *
 * Before the panel, a repository that opted in to the quality-kernel gate on push has every pushed
 * range re-verified by it (see qkOptIn below). Any outcome other than verified (exit 0) or verified on
 * a critical surface (exit 3, which still needs the breaker and a human before merge) blocks the
 * push: a failing gate, and also a gate that cannot run (memory pressure, missing, timed out).
 *
 * It honors no skip switch: AI_REVIEW_SKIP, PREPUSH_REVIEW_SKIP and AI_REVIEW_REQUIRED are
 * removed or forced in the environment given to the panel. The only way past it is the human
 * typing `git push --no-verify`, which git itself implements and no hook can see.
 *
 * Run log: the panel records each run it finishes in ~/.cache/git-ai-review/runs.jsonl. This
 * runner records only the pushes the panel never got to finish: blocked by the quality gate, or a
 * panel that could not start, was killed or timed out. A --no-verify push runs no hook, so it
 * leaves no row: the log cannot count overrides.
 */
import { spawn, spawnSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { recordRun } from './run-log.mjs';

const TIMEOUT_MS = Number(process.env.AI_REVIEW_GATE_TIMEOUT_MS || 540_000);
const QK_TIMEOUT_MS = Number(process.env.QK_PUSH_TIMEOUT_MS || 1_800_000);
// Node clamps a timer above 2^31-1 ms to 1 ms, so a larger value would kill the gate at once.
const MAX_TIMER_MS = 2_147_483_647;
// The gate's memory guard refuses to start at this macOS pressure level or above. Its own default
// is 2, where a laptop with a local Docker stack sits most of the time, so on push it is 3 unless
// the environment sets QK_MEM_MAX_PRESSURE_LEVEL. A refusal still blocks the push.
const QK_ENV = { QK_MEM_MAX_PRESSURE_LEVEL: '3', ...process.env };
const ZERO = /^0+$/;

const startedAt = Date.now();
const say = (msg) => process.stderr.write(`${msg}\n`);
const fail = (msg) => {
  say(`[pre-push-review] PUSH BLOCKED: ${msg}`);
  process.exit(1);
};

function readStdin() {
  return new Promise((res) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      if (data.length < 1_000_000) data += c;
    });
    process.stdin.on('end', () => res({ data, clean: true }));
    process.stdin.on('error', () => res({ data, clean: false }));
    setTimeout(() => res({ data, clean: false }), 5000).unref?.();
  });
}

// pre-push stdin: "<local ref> <local sha> <remote ref> <remote sha>" per ref being pushed.
// Only a stream that ended cleanly may short-circuit; a partial read reviews as usual.
const stdin = await readStdin();
const refs = stdin.data
  .split('\n')
  .map((l) => l.trim().split(/\s+/))
  .filter((p) => p.length >= 4);
if (stdin.clean && refs.length && refs.every((p) => ZERO.test(p[1]))) {
  say('[pre-push-review] Only deleting refs: nothing to review.');
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const panel = resolve(here, 'ai-review-panel.mjs');
if (!existsSync(panel)) fail(`the review panel is missing (${panel}), so nothing can be reviewed. Reinstall the plugin.`);

const git = (args, input) => spawnSync('git', args, { encoding: 'utf8', cwd: root, input });
const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
const root = top.status === 0 && top.stdout.trim() ? top.stdout.trim() : process.cwd();
const SHA = /^[0-9a-f]{40,64}$/;
const lines = (r) => (r.status === 0 ? r.stdout.split('\n').filter(Boolean) : null);

// git passes the remote name (or the URL when pushing to one) as the first argument.
const remoteArg = process.argv[2] || '';
const remotes = lines(git(['remote'])) || [];
// Tips the target remote is known to have: its remote-tracking refs. Only that remote's: a
// commit on another remote is still being sent to this one. Pushing to a URL has none.
const targetTips = remotes.includes(remoteArg)
  ? lines(git(['for-each-ref', '--format=%(objectname)', `refs/remotes/${remoteArg}/`])) || []
  : [];

/** The [base, head] range of commits a ref push sends that the remote does not have yet. */
function rangeFor(localSha, remoteSha) {
  const knownRemote = !ZERO.test(remoteSha) && git(['cat-file', '-e', `${remoteSha}^{commit}`]).status === 0;
  // One set of "already on the target" tips decides both which commits are pushed and where
  // the review starts, so the base can never land on or past a pushed commit.
  const have = [...new Set([...(knownRemote ? [remoteSha] : []), ...targetTips])];
  const commits = lines(git(['rev-list', localSha, ...(have.length ? ['--not', ...have] : [])]));
  if (commits === null) return { error: `cannot list the commits pushed by ${localSha.slice(0, 7)}` };
  if (!commits.length) return null; // the remote already has every commit (e.g. a new name for them)
  // The base is where the pushed commits attach to what the target has: the merge base of the
  // pushed tip with those tips. Unlike "the parent of the oldest listed commit", this holds with
  // merges and clock skew. It is reachable from `have`, so it is never one of the pushed commits.
  let base = '';
  if (have.length) {
    const mb = git(['merge-base', localSha, ...have]);
    if (mb.status === 0) base = mb.stdout.trim();
  }
  if (!base) {
    // Nothing in common with the target (an empty remote, a URL, or unrelated history): review
    // everything, against the empty tree.
    const empty = git(['hash-object', '-t', 'tree', '--stdin'], '');
    base = empty.status === 0 ? empty.stdout.trim() : '';
  }
  if (!SHA.test(base) || base === localSha) {
    return { error: `cannot find the base of the commits pushed by ${localSha.slice(0, 7)}` };
  }
  return { base, head: localSha };
}

/**
 * Whether this repository opted in to the quality-kernel gate on push, and where it lives:
 * { repo, org } when <org>/.quality-kernel/repos/<name>/tools.json says `"runOnPush": true`, where
 * <org> holds an org guide (.claude/org-workspace/guide.json) and <name> is the MAIN checkout (a push
 * from a linked worktree is gated against it: the commits are in the shared object store). null when
 * it did not opt in; { error } when that cannot be told (fail closed).
 */
function qkOptIn() {
  // Not knowing where the repository lives means not knowing whether it opted in: fail closed.
  const unknown = (why) => ({ error: `cannot tell whether this repository runs the quality gate on push (${why})` });
  // Relative to the repository root when git prints a relative path (no --path-format: older git).
  const common = git(['rev-parse', '--git-common-dir']);
  if (common.status !== 0 || !common.stdout.trim()) {
    return unknown(`git rev-parse --git-common-dir failed: ${(common.stderr || '').trim() || `exit ${common.status}`}`);
  }
  let main;
  try {
    const dir = realpathSync(resolve(root, common.stdout.trim()));
    main = basename(dir) === '.git' ? dirname(dir) : realpathSync(root);
  } catch (e) {
    return unknown(`cannot resolve the git directory: ${e.code || e.message}`);
  }
  const org = dirname(main);
  if (!existsSync(join(org, '.claude', 'org-workspace', 'guide.json'))) return null;
  const toolsPath = join(org, '.quality-kernel', 'repos', basename(main), 'tools.json');
  if (!existsSync(toolsPath)) return null;
  let tools;
  try {
    tools = JSON.parse(readFileSync(toolsPath, 'utf8'));
  } catch (e) {
    return { error: `cannot read ${toolsPath} (${e.message}), so it is unknown whether the quality gate must run` };
  }
  return tools && tools.runOnPush === true ? { repo: main, org } : null;
}

// One panel run per distinct range; a ref list we cannot trust falls back to the panel's guess.
const runs = [];
const usableRefs = stdin.clean && refs.length && refs.every((p) => SHA.test(p[1]) && SHA.test(p[3]));
if (usableRefs) {
  const seen = new Set();
  for (const [localRef, localSha, , remoteSha] of refs) {
    if (ZERO.test(localSha)) continue; // deleting a ref sends no code
    const r = rangeFor(localSha, remoteSha);
    if (r?.error) fail(`${r.error}, so the push cannot be matched to a review.`);
    if (!r || seen.has(`${r.base} ${r.head}`)) continue;
    seen.add(`${r.base} ${r.head}`);
    // The ref tells the panel which branch is pushed, so it can find that branch's PR and ticket.
    runs.push({ args: ['--range', r.base, r.head], head: r.head, base: r.base, ref: localRef });
  }
  if (!runs.length) {
    say('[pre-push-review] The remote already has every pushed commit: nothing new to review.');
    process.exit(0);
  }
} else {
  const head = git(['rev-parse', 'HEAD']);
  runs.push({ args: ['--branch'], head: head.status === 0 ? head.stdout.trim() : 'unknown' });
}

// No skip switch is honored; the review is always required.
const env = { ...process.env, AI_REVIEW_REQUIRED: '1', AI_REVIEW_TRIGGER: 'pre-push' };
delete env.AI_REVIEW_SKIP;
delete env.PREPUSH_REVIEW_SKIP;

// One deadline for the panel runs, however many ranges there are. It starts with the first panel
// run, so the quality gate before it does not use up the panel's time.
let deadline = null;

// Interrupts are passed on to whichever panel is running. Registered once: a handler per run
// would pile up, and the first (stale) one would exit before the live panel was killed.
let activeChild = null;
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    if (activeChild) {
      try {
        process.kill(-activeChild.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    process.exit(1);
  });
}

// Runs a node script as the leader of its own process group, streaming its stderr (and, with
// echoStdout, its stdout) to the terminal; the whole group is killed at the deadline.
function runChild(script, args, { label, deadline, timeoutMs, childEnv, echoStdout = true }) {
  return new Promise((done) => {
    const result = { out: '', stdout: '', code: null, failure: '' };
    const finish = () => {
      activeChild = null;
      done(result);
    };
    let child;
    try {
      // Detached: the panel leads its own process group, so the whole tree (its `claude`
      // children included) can be killed together.
      child = spawn(process.execPath, [script, ...args], {
        cwd: root,
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (e) {
      result.failure = `${label} could not run (${e.code || e.message})`;
      return finish();
    }
    activeChild = child;
    const forward = (chunk) => {
      if (result.out.length < 32 * 1024 * 1024) result.out += chunk;
      process.stderr.write(chunk);
    };
    child.stdout.on('data', (chunk) => {
      if (result.stdout.length < 32 * 1024 * 1024) result.stdout += chunk;
      if (echoStdout) forward(chunk);
    });
    child.stderr.on('data', forward);
    const timer = setTimeout(() => {
      result.failure = `${label} did not finish in ${timeoutMs} ms`;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
      // Grandchildren may hold the pipes open, so 'close' may never fire: do not wait for it.
      child.stdout.destroy();
      child.stderr.destroy();
      finish();
    }, Math.max(0, deadline - Date.now()));
    child.on('error', (e) => {
      result.failure ||= `${label} could not run (${e.code || e.message})`;
      clearTimeout(timer);
      finish();
    });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      if (!result.failure && signal) result.failure = `${label} was killed by ${signal}`;
      result.code = status;
      finish();
    });
  });
}

const runPanel = ({ args, ref }) => {
  deadline ??= Date.now() + TIMEOUT_MS;
  const childEnv = ref ? { ...env, AI_REVIEW_PUSH_REF: ref } : env;
  return runChild(panel, args, { label: 'the panel', deadline, timeoutMs: TIMEOUT_MS, childEnv });
};

/** The last JSON line a child printed on stdout, or null. */
function lastJson(text) {
  for (const line of text.trim().split('\n').reverse()) {
    try {
      return JSON.parse(line);
    } catch {
      /* not the verdict line */
    }
  }
  return null;
}

let out = '';

// The quality-kernel gate, for a repository that opted in. It returns why the push must be
// blocked, or '' to go on to the panel.
async function qualityGate() {
  const optIn = qkOptIn();
  if (!optIn) return '';
  if (optIn.error) return optIn.error;
  const qkGate = resolve(here, '..', '..', 'quality-kernel', 'scripts', 'qk-gate.mjs');
  if (!existsSync(qkGate)) {
    return `this repository runs the quality gate on push, but the quality gate is missing (${qkGate}). Install the quality-kernel plugin next to pre-push-review.`;
  }
  if (!runs.every((run) => run.base)) return 'cannot tell which commits are pushed, so the quality gate cannot verify them';
  if (!Number.isInteger(QK_TIMEOUT_MS) || QK_TIMEOUT_MS <= 0 || QK_TIMEOUT_MS > MAX_TIMER_MS) {
    return `QK_PUSH_TIMEOUT_MS must be a whole number of milliseconds between 1 and ${MAX_TIMER_MS}`;
  }
  const qkDeadline = Date.now() + QK_TIMEOUT_MS;
  for (const run of runs) {
    if (git(['cat-file', '-e', `${run.base}^{commit}`]).status !== 0) {
      return `the push of ${run.head.slice(0, 7)} shares no history with the remote (no base commit), so the quality gate has nothing to verify it against`;
    }
    // --no-ledger: the referee must not write its audit rows into the product repo on every push.
    const args = ['--repo', optIn.repo, '--base', run.base, '--head', run.head, '--org', optIn.org, '--no-ledger'];
    say(`[pre-push-review] quality gate: ${run.base.slice(0, 7)}..${run.head.slice(0, 7)}`);
    const r = await runChild(qkGate, args, {
      label: 'the quality gate',
      deadline: qkDeadline,
      timeoutMs: QK_TIMEOUT_MS,
      childEnv: QK_ENV,
      echoStdout: false,
    });
    out += `\n$ qk-gate ${args.join(' ')}\n${r.out}\n${r.stdout}`;
    if (r.failure) return `${r.failure}; the push was NOT verified`;
    const verdict = lastJson(r.stdout) || {};
    const why = verdict.referee?.reason || (verdict.notes || []).join(' ') || 'no reason given';
    if (r.code === 0) say('[pre-push-review] quality gate: verified green.');
    else if (r.code === 3) {
      say('[pre-push-review] quality gate: verified green on a critical surface: the live breaker and a human review are required before merge (not before push).');
    } else if (r.code === 1) return `the quality gate failed: ${why}`;
    else if (r.code === 2) return `the quality gate could not verify the push (indeterminate): ${why}`;
    else return `the quality gate ended with exit ${r.code}: ${why}`;
  }
  return '';
}

let code = 0;
let failure = '';
const qkBlock = await qualityGate();
for (const run of qkBlock ? [] : runs) {
  const r = await runPanel(run);
  out += `\n$ ai-review-panel ${run.args.join(' ')}\n${r.out}`;
  if (r.failure) {
    failure = r.failure;
    code = null;
    break;
  }
  // Keep the worst outcome: 1 (blocking findings) is reported, any other non-zero is "not reviewed".
  if (r.code !== 0 && (code === 0 || r.code !== 1)) code = r.code;
  if (code !== 0 && code !== 1) break;
}

// Keep the full output: the terminal scrolls away.
try {
  const sha = runs[runs.length - 1].head;
  const cacheDir = join(homedir(), '.cache', 'git-ai-review');
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  chmodSync(cacheDir, 0o700);
  const logFile = join(cacheDir, `review-${sha}.log`);
  const outcome = qkBlock ? `blocked by the quality gate (${qkBlock})` : `${code}${failure ? ` (${failure})` : ''}`;
  writeFileSync(logFile, `repository: ${root}\nexit: ${outcome}\n\n${out}`, {
    mode: 0o600,
  });
  chmodSync(logFile, 0o600);
  say(`[pre-push-review] Full output: ${join(cacheDir, `review-${sha}.log`)}`);
} catch {
  /* the log is best-effort */
}

// The panel writes its own row when it finishes; these are the pushes where it did not.
const unreviewed = (outcome, reason) => {
  for (const run of runs) {
    recordRun({ trigger: 'pre-push', repo: root, mode: run.base ? 'range' : 'branch', base: run.base || '', head: run.head, outcome, reason, exit: 1, durationMs: Date.now() - startedAt });
  }
};
if (qkBlock) {
  unreviewed('blocked', `quality gate: ${qkBlock}`);
  fail(qkBlock);
}
if (failure) {
  unreviewed('not-reviewed', failure);
  fail(`${failure}; the change was NOT reviewed.`);
}
if (code === 0) process.exit(0);
if (code === 1) fail('blocking issue(s) found by the expert panel (critical findings or a contradicted ticket line). Fix them and push again.');
fail(`no reviewer could run (panel exit ${code}). Check that the \`claude\` CLI is installed and signed in.`);
