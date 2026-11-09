// The quality-kernel gate on push: a repo that opts in (`"runOnPush": true` in its org tools.json)
// has its pushed range re-verified by qk-gate before the panel runs, and the push is blocked when the
// gate fails OR cannot run (memory pressure, missing gate, timeout, unreadable config).
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { fakePlugin, git, executable, runNode, tempDir, write } from './helpers.mjs';

const ZERO = '0'.repeat(40);

/** An org folder holding one repo with two commits; `tools` is its org tools.json (null = none). */
function makeOrg({ tools = { verify: 'true', runOnPush: true }, guide = true, name = 'app' } = {}) {
  const org = tempDir('org');
  if (guide) write(org, { '.claude/org-workspace/guide.json': '{"repos":{}}\n' });
  if (tools !== null) {
    write(org, { [`.quality-kernel/repos/${name}/tools.json`]: typeof tools === 'string' ? tools : JSON.stringify(tools) });
  }
  const repo = join(org, name);
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  write(repo, { 'a.txt': 'one\n' });
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'one');
  const base = git(repo, 'rev-parse', 'HEAD');
  write(repo, { 'a.txt': 'two\n' });
  git(repo, 'commit', '-q', '-am', 'two');
  return { org, repo, base, head: git(repo, 'rev-parse', 'HEAD') };
}

function push({ cwd, input, plugin = fakePlugin({ qkGate: true }), env = {} }) {
  const home = tempDir('home');
  const panelLog = join(home, 'panel.jsonl');
  const qkLog = join(home, 'qk.jsonl');
  const r = runNode(join(plugin, 'scripts', 'git-pre-push.mjs'), {
    cwd,
    input,
    env: { HOME: home, FAKE_PANEL_LOG: panelLog, FAKE_QK_LOG: qkLog, ...env },
  });
  const read = (f) => (existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  return { ...r, panel: read(panelLog), qk: read(qkLog), home };
}

const update = (o) => `refs/heads/main ${o.head} refs/heads/main ${o.base}\n`;

test('an opted-in repo is gated on the pushed range, with the org, before the panel; green passes', () => {
  const o = makeOrg();
  const r = push({ cwd: o.repo, input: update(o) });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.qk.map((c) => c.args), [['--repo', o.repo, '--base', o.base, '--head', o.head, '--org', o.org, '--no-ledger']]);
  assert.equal(r.panel.length, 1, 'the panel still runs after a green gate');
  assert.match(r.stderr, /quality gate: verified green/);
  assert.match(r.stderr, /\[fake-qk\] running/, 'the gate output reaches the terminal');
  assert.ok(r.stderr.indexOf('quality gate') < r.stderr.indexOf('Passed. No blocking'), 'gate runs before the panel');
});

test('the gate runs with memory-pressure threshold 3 unless the environment sets one', () => {
  const o = makeOrg();
  assert.deepEqual(push({ cwd: o.repo, input: update(o) }).qk.map((c) => c.memLevel), ['3']);
  const own = push({ cwd: o.repo, input: update(o), env: { QK_MEM_MAX_PRESSURE_LEVEL: '2' } });
  assert.deepEqual(own.qk.map((c) => c.memLevel), ['2']);
});

test('every distinct pushed range is gated, and a failure in any of them blocks', () => {
  const o = makeOrg();
  git(o.repo, 'switch', '-q', '-c', 'other', o.base);
  write(o.repo, { 'c.txt': 'c\n' });
  git(o.repo, 'add', '-A');
  git(o.repo, 'commit', '-q', '-m', 'other');
  const other = git(o.repo, 'rev-parse', 'HEAD');
  const input = update(o) + `refs/heads/other ${other} refs/heads/other ${o.base}\n`;
  const r = push({ cwd: o.repo, input, env: { FAKE_QK_FAIL_HEAD: other } });
  assert.deepEqual(r.qk.map((c) => c.args[5]), [o.head, other]);
  assert.equal(r.code, 1);
  assert.equal(r.panel.length, 0);
});

test('the panel gets its whole time budget after a slow gate', () => {
  const o = makeOrg();
  const r = push({ cwd: o.repo, input: update(o), env: { FAKE_QK_SLEEP_MS: '2500', AI_REVIEW_GATE_TIMEOUT_MS: '2000' } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.panel.length, 1);
});

test('an unusable QK_PUSH_TIMEOUT_MS blocks with a clear message', () => {
  const o = makeOrg();
  for (const bad of ['abc', '0', '-5', '1e12']) {
    const r = push({ cwd: o.repo, input: update(o), env: { QK_PUSH_TIMEOUT_MS: bad } });
    assert.equal(r.code, 1, bad);
    assert.match(r.stderr, /QK_PUSH_TIMEOUT_MS/, bad);
    assert.equal(r.qk.length, 0, bad);
  }
});

test('when git cannot say where the repository lives, the push is blocked, not let through ungated', () => {
  // A git that works for everything except `rev-parse --git-common-dir`: whether the repo opted in
  // cannot be told, so the hook must fail closed instead of treating it as "not opted in".
  const o = makeOrg();
  const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const bin = tempDir('bin');
  executable(join(bin, 'git'), `#!/bin/sh\nfor a in "$@"; do [ "$a" = "--git-common-dir" ] && exit 128; done\nexec "${realGit}" "$@"\n`);
  const r = push({ cwd: o.repo, input: update(o), env: { PATH: `${bin}:${process.env.PATH}` } });
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /cannot tell whether this repository runs the quality gate/);
  assert.equal(r.panel.length, 0);
});

test('the hook started from a subdirectory still finds the opt-in', () => {
  const o = makeOrg();
  const sub = join(o.repo, 'pkg');
  mkdirSync(sub);
  const r = push({ cwd: sub, input: update(o) });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.qk.length, 1);
});

test('a failing gate blocks the push and the panel does not run', () => {
  const o = makeOrg();
  const r = push({ cwd: o.repo, input: update(o), env: { FAKE_QK_EXIT: '1', FAKE_QK_REASON: 'base tests fail on head' } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /PUSH BLOCKED/);
  assert.match(r.stderr, /base tests fail on head/);
  assert.equal(r.panel.length, 0);
});

test('a gate that cannot run (memory pressure, exit 2) blocks the push', () => {
  const o = makeOrg();
  const reason = 'memory pressure too high to start a gate run: kern.memorystatus_vm_pressure_level = 2';
  const r = push({ cwd: o.repo, input: update(o), env: { FAKE_QK_EXIT: '2', FAKE_QK_REASON: reason } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /PUSH BLOCKED: the quality gate could not verify/);
  assert.ok(r.stderr.includes(reason));
  assert.equal(r.panel.length, 0);
});

test('a critical-surface verdict (exit 3) lets the push through with a merge warning', () => {
  const o = makeOrg();
  const r = push({ cwd: o.repo, input: update(o), env: { FAKE_QK_EXIT: '3' } });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /critical surface/);
  assert.match(r.stderr, /before merge/);
  assert.equal(r.panel.length, 1);
});

test('any other gate exit blocks the push', () => {
  const o = makeOrg();
  const r = push({ cwd: o.repo, input: update(o), env: { FAKE_QK_EXIT: '7' } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /PUSH BLOCKED/);
});

test('a gate that does not finish in time blocks the push', () => {
  const o = makeOrg();
  const r = push({ cwd: o.repo, input: update(o), env: { FAKE_QK_HANG: '1', QK_PUSH_TIMEOUT_MS: '1500' } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /quality gate did not finish in 1500 ms/);
  assert.equal(r.panel.length, 0);
});

test('an opted-in repo with no quality-kernel gate next to the plugin is blocked', () => {
  const o = makeOrg();
  const r = push({ cwd: o.repo, input: update(o), plugin: fakePlugin({ qkGate: false }) });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /quality gate is missing/);
  assert.equal(r.panel.length, 0);
});

test('an unreadable org tools.json blocks the push (cannot tell whether the repo opted in)', () => {
  const o = makeOrg({ tools: '{ not json' });
  const r = push({ cwd: o.repo, input: update(o) });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /tools\.json/);
  assert.equal(r.qk.length, 0);
});

test('a repo that did not opt in is not gated (panel only)', () => {
  for (const tools of [{ verify: 'true' }, { verify: 'true', runOnPush: 'yes' }, null]) {
    const o = makeOrg({ tools });
    const r = push({ cwd: o.repo, input: update(o) });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.qk.length, 0, JSON.stringify(tools));
    assert.equal(r.panel.length, 1);
  }
});

test('a folder without an org guide is not an org: not gated', () => {
  const o = makeOrg({ guide: false });
  const r = push({ cwd: o.repo, input: update(o) });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.qk.length, 0);
});

test('a push from a linked worktree of an opted-in repo is gated against the main checkout', () => {
  const o = makeOrg();
  const wt = join(tempDir('wt'), 'feature');
  git(o.repo, 'worktree', 'add', '-q', '-b', 'feat', wt, o.base);
  write(wt, { 'b.txt': 'b\n' });
  git(wt, 'add', '-A');
  git(wt, 'commit', '-q', '-m', 'feat');
  const head = git(wt, 'rev-parse', 'HEAD');
  const r = push({ cwd: wt, input: `refs/heads/feat ${head} refs/heads/feat ${o.base}\n` });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.qk.map((c) => c.args), [['--repo', o.repo, '--base', o.base, '--head', head, '--org', o.org, '--no-ledger']]);
});

test('each pushed range is gated once', () => {
  const o = makeOrg();
  const input = update(o) + `refs/heads/copy ${o.head} refs/heads/copy ${o.base}\n`;
  const r = push({ cwd: o.repo, input });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.qk.length, 1);
});

test('a push with no common history (no base commit) of an opted-in repo is blocked', () => {
  const o = makeOrg();
  const r = push({ cwd: o.repo, input: `refs/heads/main ${o.head} refs/heads/main ${ZERO}\n` });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no base commit/);
  assert.equal(r.qk.length, 0);
});

test('an unreadable ref list on an opted-in repo is blocked (no range to verify)', () => {
  const o = makeOrg();
  const r = push({ cwd: o.repo, input: 'garbage\n' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /cannot tell which commits/);
  assert.equal(r.qk.length, 0);
});

test('a ref deletion needs no gate', () => {
  const o = makeOrg();
  const r = push({ cwd: o.repo, input: `(delete) ${ZERO} refs/heads/old ${o.base}\n` });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.qk.length, 0);
});
