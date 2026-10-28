import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { aggregate, percentile, render } from '../scripts/stats.mjs';
import { SCRIPTS, executable, fakePlugin, git, installGate, makeRepo, runNode, tempDir, write } from './helpers.mjs';

const PANEL = join(SCRIPTS, 'ai-review-panel.mjs');
const STATS = join(SCRIPTS, 'stats.mjs');
const LGTM = '{"findings":[],"summary":"LGTM"}';

/** A `claude` stand-in that answers with the `--output-format json` envelope, as the real CLI does. */
function fakeClaude({ reply = LGTM, envelope = true, isError = false, replyByRole = null } = {}) {
  const dir = tempDir('claude');
  return executable(
    join(dir, 'claude'),
    `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('end', () => {
  const argv = process.argv.slice(2);
  const role = argv[argv.indexOf('--append-system-prompt') + 1];
  const byRole = ${JSON.stringify(replyByRole)};
  let reply = ${JSON.stringify(reply)};
  if (byRole) for (const [needle, r] of Object.entries(byRole)) if (role.includes(needle)) reply = r;
  if (!argv.includes('--output-format') || !${envelope}) { process.stdout.write(reply); process.exit(0); }
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: ${isError}, duration_ms: 1200, total_cost_usd: 0.05, usage: { input_tokens: 100, cache_creation_input_tokens: 2000, cache_read_input_tokens: 500, output_tokens: 40 }, result: reply }));
  process.exit(0);
});
`,
  );
}

function featureRepo() {
  const repo = makeRepo('runlog', { 'a.js': 'export const a = 1;\n' });
  git(repo, 'checkout', '-q', '-b', 'feature');
  write(repo, { 'a.js': 'export const a = 2;\n' });
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'change a');
  return repo;
}

const rowsIn = (home) => {
  const path = join(home, '.cache', 'git-ai-review', 'runs.jsonl');
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
};

function runPanel({ repo = featureRepo(), claude = fakeClaude(), env = {}, args = ['--branch', '--base', 'main'] } = {}) {
  const home = tempDir('home');
  const r = runNode(PANEL, { args, cwd: repo, env: { HOME: home, CLAUDE_BIN: claude, ...env } });
  return { ...r, home, repo, rows: rowsIn(home) };
}

test('a passing run appends one row with the reviewers, their findings, usage and cost', () => {
  const r = runPanel();
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.rows.length, 1);
  const row = r.rows[0];
  assert.equal(row.v, 1);
  assert.ok(Date.parse(row.ts) > 0);
  assert.equal(row.trigger, 'cli');
  assert.equal(row.repo, r.repo);
  assert.equal(row.mode, 'branch');
  assert.equal(row.head, git(r.repo, 'rev-parse', 'HEAD'));
  assert.equal(row.outcome, 'passed');
  assert.equal(row.exit, 0);
  assert.equal(row.blocking, 0);
  assert.equal(row.ticket, 'none');
  assert.deepEqual(row.roles.run, ['security', 'correctness', 'reliability', 'performance', 'tests', 'maintainability', 'simplicity']);
  assert.deepEqual(row.roles.skipped, ['ticket']);
  assert.deepEqual(row.roles.failed, []);
  assert.deepEqual(row.findings.security, { critical: 0, high: 0, medium: 0, low: 0 });
  assert.deepEqual(row.counts, { critical: 0, high: 0, medium: 0, low: 0 });
  assert.equal(row.calls, 7);
  assert.equal(row.costUsd, 0.35);
  assert.deepEqual(row.usage, { input: 700, output: 280, cacheRead: 3500, cacheCreation: 14000 });
  assert.ok(row.durationMs >= 0);
  assert.equal(row.verifier, null);
  assert.equal(row.model, 'sonnet');
  assert.equal(row.partial, false);
  assert.ok(row.diffLines > 0);
});

test('a blocked run records the outcome and per-role counts before de-duplication', () => {
  const critical = '{"findings":[{"severity":"critical","file":"a.js","line":1,"issue":"leaks a token","suggestion":"remove"}],"summary":"bad"}';
  const r = runPanel({ claude: fakeClaude({ replyByRole: { 'application-security': critical, 'correctness reviewer': critical } }) });
  assert.equal(r.code, 1, r.stderr);
  const row = r.rows[0];
  assert.equal(row.outcome, 'blocked');
  assert.equal(row.blocking, 1);
  assert.equal(row.findings.security.critical, 1);
  assert.equal(row.findings.correctness.critical, 1);
  assert.equal(row.counts.critical, 1, 'the same file:line from two reviewers is one finding');
});

test('the git runner tags its runs as pre-push', () => {
  const r = runPanel({ env: { AI_REVIEW_TRIGGER: 'pre-push' } });
  assert.equal(r.rows[0].trigger, 'pre-push');
});

test('a reply without the JSON envelope is still parsed, with no usage', () => {
  const r = runPanel({ claude: fakeClaude({ envelope: false }) });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.rows[0].outcome, 'passed');
  assert.equal(r.rows[0].usage, null);
  assert.equal(r.rows[0].costUsd, 0);
});

test('an envelope with is_error counts as a failed reviewer, and its cost is still recorded', () => {
  const r = runPanel({ claude: fakeClaude({ reply: 'rate limited', isError: true }), env: { AI_REVIEW_REQUIRED: '1' } });
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stdout, /FAILED: rate limited/);
  const row = r.rows[0];
  assert.equal(row.outcome, 'not-reviewed');
  assert.equal(row.roles.failed.length, 7);
  assert.equal(row.calls, 14, 'each reviewer was retried once');
  assert.equal(row.costUsd, 0.7, 'both attempts were billed');
});

test('a run with nothing to review still leaves a row', () => {
  const repo = makeRepo('empty');
  const r = runPanel({ repo, args: ['--branch', '--base', 'main'] });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].outcome, 'nothing-to-review');
  assert.equal(r.rows[0].roles, undefined);
});

test('the run log is private (0600 in a 0700 directory)', () => {
  const r = runPanel();
  const dir = join(r.home, '.cache', 'git-ai-review');
  const mode = (p) => spawnSync('stat', ['-f', '%Lp', p], { encoding: 'utf8' }).stdout.trim();
  if (process.platform === 'darwin') {
    assert.equal(mode(dir), '700');
    assert.equal(mode(join(dir, 'runs.jsonl')), '600');
  }
});

// --- through git push ------------------------------------------------------------------------

function pushSetup(pluginOpts = { realPanel: true }) {
  const plugin = fakePlugin(pluginOpts);
  const home = installGate(plugin);
  const remote = tempDir('remote');
  git(remote, 'init', '-q', '--bare', '-b', 'main');
  const repo = makeRepo('work', { 'a.js': 'export const a = 1;\n' });
  git(repo, 'remote', 'add', 'origin', remote);
  const push = (env = {}) =>
    spawnSync('git', ['push', 'origin', 'main'], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, HOME: home, FAKE_PANEL_LOG: join(home, 'panel-calls.jsonl'), ...env },
    });
  return { push, repo, home, rows: () => rowsIn(home) };
}

test('real git push: every push appends exactly one line', () => {
  const s = pushSetup();
  const claude = fakeClaude();
  const first = s.push({ CLAUDE_BIN: claude });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(s.rows().length, 1, 'one row for one push');
  const row = s.rows()[0];
  assert.equal(row.trigger, 'pre-push');
  assert.equal(row.mode, 'range');
  assert.equal(row.head, git(s.repo, 'rev-parse', 'HEAD'));
  assert.equal(row.outcome, 'passed');

  write(s.repo, { 'a.js': 'export const a = 2;\n' });
  git(s.repo, 'add', '-A');
  git(s.repo, 'commit', '-q', '-m', 'second');
  const second = s.push({ CLAUDE_BIN: claude });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(s.rows().length, 2, 'two pushes, two rows');
  assert.equal(s.rows()[1].base, row.head, 'the second range starts where the first ended');
});

test('real git push: a panel that is killed or hangs leaves one "not-reviewed" row from the runner', () => {
  const killed = pushSetup({ realPanel: false });
  assert.notEqual(killed.push({ FAKE_PANEL_KILL: '1' }).status, 0);
  assert.equal(killed.rows().length, 1);
  assert.equal(killed.rows()[0].outcome, 'not-reviewed');
  assert.match(killed.rows()[0].reason, /killed by SIGKILL/);

  const hung = pushSetup({ realPanel: false });
  assert.notEqual(hung.push({ FAKE_PANEL_HANG: '1', AI_REVIEW_GATE_TIMEOUT_MS: '500' }).status, 0);
  assert.equal(hung.rows().length, 1);
  assert.match(hung.rows()[0].reason, /did not finish/);
});

test('real git push: a panel that finishes owns the row; the runner adds none', () => {
  const s = pushSetup({ realPanel: false });
  assert.notEqual(s.push({ FAKE_PANEL_EXIT: '1' }).status, 0);
  assert.equal(s.rows().length, 0, 'the fake panel writes no row, and the runner must not double it');
});

test('a push blocked by the quality gate leaves one "blocked" row naming the gate', () => {
  const plugin = fakePlugin({ qkGate: true, realPanel: false });
  const home = tempDir('home');
  // An opted-in repository: <org>/.claude/org-workspace/guide.json and .quality-kernel/repos/<name>/tools.json.
  const org = tempDir('org');
  mkdirSync(join(org, '.claude', 'org-workspace'), { recursive: true });
  writeFileSync(join(org, '.claude', 'org-workspace', 'guide.json'), '{}');
  const repo = join(org, 'app');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 'T');
  git(repo, 'config', 'commit.gpgsign', 'false');
  write(repo, { 'a.js': 'a\n' });
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  mkdirSync(join(org, '.quality-kernel', 'repos', 'app'), { recursive: true });
  writeFileSync(join(org, '.quality-kernel', 'repos', 'app', 'tools.json'), '{"runOnPush": true}');
  // The remote already has the base commit, so the pushed range has a commit to verify against.
  const remote = tempDir('remote');
  git(remote, 'init', '-q', '--bare', '-b', 'main');
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-q', '--no-verify', 'origin', 'main');
  const base = git(repo, 'rev-parse', 'HEAD');
  write(repo, { 'a.js': 'b\n' });
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'next');
  const head = git(repo, 'rev-parse', 'HEAD');
  const r = runNode(join(plugin, 'scripts', 'git-pre-push.mjs'), {
    cwd: repo,
    args: ['origin'],
    input: `refs/heads/main ${head} refs/heads/main ${base}\n`,
    env: { HOME: home, FAKE_QK_EXIT: '1', FAKE_QK_REASON: 'tests fail on the pushed code' },
  });
  assert.equal(r.code, 1, r.stderr);
  const rows = rowsIn(home);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, 'blocked');
  assert.match(rows[0].reason, /quality gate: .*tests fail on the pushed code/);
  assert.equal(rows[0].head, head);
  assert.equal(rows[0].base, base);
});

// --- stats -----------------------------------------------------------------------------------

const ago = (days) => new Date(Date.now() - days * 86_400_000).toISOString();
const reviewedRow = (over = {}) => ({
  v: 1,
  ts: ago(1),
  trigger: 'pre-push',
  repo: '/r',
  outcome: 'passed',
  roles: { run: ['security', 'correctness'], skipped: ['ticket'], failed: [] },
  findings: { security: { critical: 0, high: 1, medium: 0, low: 0 }, correctness: { critical: 0, high: 0, medium: 2, low: 0 } },
  counts: { critical: 0, high: 1, medium: 2, low: 0 },
  blocking: 0,
  costUsd: 0.4,
  durationMs: 60_000,
  calls: 7,
  ...over,
});

test('percentile picks the nearest-rank value', () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([5], 0.95), 5);
  assert.equal(percentile([3, 1, 2], 0.5), 2);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95), 10);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5), 5);
});

test('aggregate counts outcomes, per-role runs/skips/failures/findings, and cost, time and calls over reviewed runs only', () => {
  const rows = [
    reviewedRow(),
    reviewedRow({ outcome: 'blocked', blocking: 1, costUsd: 0.6, durationMs: 120_000, calls: 9, roles: { run: ['security', 'correctness', 'ticket'], skipped: [], failed: ['correctness'] } }),
    { v: 1, ts: ago(1), outcome: 'not-reviewed', reason: 'killed', durationMs: 5 },
    { v: 1, ts: ago(1), outcome: 'nothing-to-review' },
  ];
  const a = aggregate(rows);
  assert.equal(a.runs, 4);
  assert.deepEqual(a.outcomes, { passed: 1, blocked: 1, 'not-reviewed': 1, 'nothing-to-review': 1, skipped: 0 });
  assert.deepEqual(a.roles.security, { run: 2, skipped: 0, failed: 0, critical: 0, high: 2, medium: 0, low: 0 });
  assert.deepEqual(a.roles.correctness, { run: 2, skipped: 0, failed: 1, critical: 0, high: 0, medium: 4, low: 0 });
  assert.deepEqual(a.roles.ticket, { run: 1, skipped: 1, failed: 0, critical: 0, high: 0, medium: 0, low: 0 });
  assert.equal(a.costUsd.total, 1);
  assert.equal(a.costUsd.p50, 0.4);
  assert.equal(a.costUsd.p95, 0.6);
  assert.equal(a.durationMs.p50, 60_000);
  assert.equal(a.calls.total, 16);
});

test('stats --days N reads the log in HOME, skips older and corrupt rows, and prints per-role counts and cost', () => {
  const home = tempDir('home');
  const dir = join(home, '.cache', 'git-ai-review');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'runs.jsonl'),
    [JSON.stringify(reviewedRow()), 'not json at all', JSON.stringify(reviewedRow({ ts: ago(10), costUsd: 100 })), ''].join('\n'),
  );
  const r = runNode(STATS, { args: ['--days', '7'], env: { HOME: home } });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /last 7 day\(s\): 1 run\(s\)/);
  assert.match(r.stdout, /1 passed · 0 blocked/);
  assert.match(r.stdout, /cost\s+\$0\.40 total/);
  assert.match(r.stdout, /Security & Privacy\s+1\s+0\s+0\s+0\s+1\s+0\s+0/);
  assert.match(r.stdout, /Correctness & Logic\s+1\s+0\s+0\s+0\s+0\s+2\s+0/);
  assert.match(r.stdout, /Fit to the ticket\s+0\s+1\s+0/);
  assert.doesNotMatch(r.stdout, /100/, 'the 10-day-old row is outside the window');

  const j = runNode(STATS, { args: ['--days', '7', '--json'], env: { HOME: home } });
  const parsed = JSON.parse(j.stdout);
  assert.equal(parsed.days, 7);
  assert.equal(parsed.runs, 1);

  const bad = runNode(STATS, { args: ['--days', '0'], env: { HOME: home } });
  assert.equal(bad.code, 2);
});

test('stats with no log says so', () => {
  const r = runNode(STATS, { env: { HOME: tempDir('home') } });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /0 run\(s\)/);
  assert.match(r.stdout, /no runs in/);
  assert.match(render(30, aggregate([])), /0 run\(s\)/);
});
