import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { executable, fakePlugin, git, installGate, makeRepo, runNode, tempDir } from './helpers.mjs';

const ZERO = '0'.repeat(40);

function runRunner({ plugin = fakePlugin(), env = {}, input, cwd = makeRepo('repo') } = {}) {
  const home = tempDir('home');
  const log = join(home, 'panel-calls.jsonl');
  const sha = git(cwd, 'rev-parse', 'HEAD');
  const r = runNode(join(plugin, 'scripts', 'git-pre-push.mjs'), {
    cwd,
    input: input ?? `refs/heads/main ${sha} refs/heads/main ${ZERO}\n`,
    env: { HOME: home, FAKE_PANEL_LOG: log, ...env },
  });
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  return { ...r, calls, home, cwd, sha };
}

test('passes when the panel passes, runs it with --branch in the repo root, and streams its output', () => {
  const repo = makeRepo('repo', { 'src/a.js': 'a\n' });
  const sub = join(repo, 'src');
  const r = runRunner({ cwd: sub });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.calls.map((c) => [c.cwd, c.args, c.required]), [[repo, ['--branch'], '1']]);
  assert.match(r.stderr, /Passed\. No blocking issues\./, 'panel output reaches the terminal');
});

test('keeps the full log under ~/.cache/git-ai-review', () => {
  const r = runRunner({ env: { FAKE_PANEL_OUT: 'SUMMARY: 0 critical\n' } });
  const log = readFileSync(join(r.home, '.cache', 'git-ai-review', `review-${r.sha}.log`), 'utf8');
  assert.match(log, /repository: /);
  assert.match(log, /SUMMARY: 0 critical/);
});

test('blocks when the panel reports blocking issues', () => {
  const r = runRunner({ env: { FAKE_PANEL_EXIT: '1', FAKE_PANEL_OUT: '[CRITICAL] a.js:1 - leaks a token\n' } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /leaks a token/);
  assert.match(r.stderr, /PUSH BLOCKED/);
});

test('blocks when no reviewer could run (any other panel exit)', () => {
  const r = runRunner({ env: { FAKE_PANEL_EXIT: '2' } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no reviewer could run/);
});

test('fails closed when the panel is missing', () => {
  const r = runRunner({ plugin: fakePlugin({ withPanel: false }) });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /panel is missing/);
});

test('fails closed when the panel is killed', () => {
  const r = runRunner({ env: { FAKE_PANEL_KILL: '1' } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /killed by SIGKILL/);
});

test('fails closed when the panel does not finish in time', () => {
  const r = runRunner({ env: { FAKE_PANEL_HANG: '1', AI_REVIEW_GATE_TIMEOUT_MS: '500' } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /did not finish in 500 ms/);
});

test('honors no skip switch and forces the review to be required', () => {
  const r = runRunner({
    env: { AI_REVIEW_SKIP: '1', PREPUSH_REVIEW_SKIP: '1', AI_REVIEW_REQUIRED: '0', FAKE_PANEL_EXIT: '1' },
  });
  assert.equal(r.code, 1, 'a failing review still blocks');
  assert.equal(r.calls.length, 1, 'the panel ran despite the skip switches');
  assert.equal(r.calls[0].skip, undefined);
  assert.equal(r.calls[0].prepushSkip, undefined);
  assert.equal(r.calls[0].required, '1');
});

test('a branch deletion has nothing to review', () => {
  const sha = 'a'.repeat(40);
  const r = runRunner({ input: `(delete) ${ZERO} refs/heads/old ${sha}\n`, env: { FAKE_PANEL_EXIT: '1' } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.calls.length, 0);
});

// ---- real `git push` through the installed config hook ----

function pushSetup({ husky = false } = {}) {
  const plugin = fakePlugin();
  const home = installGate(plugin);
  const remote = tempDir('remote');
  git(remote, 'init', '-q', '--bare', '-b', 'main');
  const repo = makeRepo('work');
  git(repo, 'remote', 'add', 'origin', remote);
  const marker = join(repo, 'husky-ran');
  if (husky) {
    mkdirSync(join(repo, '.husky'));
    executable(join(repo, '.husky', 'pre-push'), `#!/bin/sh\ntouch "${marker}"\n`);
    git(repo, 'config', 'core.hooksPath', '.husky');
  }
  const log = join(home, 'panel-calls.jsonl');
  const push = (env = {}, ...args) =>
    spawnSync('git', ['push', ...args, 'origin', 'main'], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, HOME: home, FAKE_PANEL_LOG: log, ...env },
    });
  const remoteHasMain = () => spawnSync('git', ['rev-parse', '--verify', '-q', 'main'], { cwd: remote }).status === 0;
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').length : 0);
  return { push, remoteHasMain, calls, marker };
}

test('real git push: the installed config hook blocks on a failing review and passes on a good one', () => {
  const s = pushSetup();
  const bad = s.push({ FAKE_PANEL_EXIT: '1' });
  assert.notEqual(bad.status, 0, bad.stderr);
  assert.match(bad.stderr, /PUSH BLOCKED/);
  assert.equal(s.remoteHasMain(), false, 'nothing reached the remote');

  const good = s.push({});
  assert.equal(good.status, 0, good.stderr);
  assert.equal(s.remoteHasMain(), true);
  assert.equal(s.calls(), 2, 'one review per push');
});

test('real git push: fails closed when the panel is missing or killed', () => {
  const s = pushSetup();
  assert.notEqual(s.push({ FAKE_PANEL_KILL: '1' }).status, 0);
  assert.equal(s.remoteHasMain(), false);
});

test('real git push: the skip switches do not skip the review', () => {
  const s = pushSetup();
  const r = s.push({ AI_REVIEW_SKIP: '1', PREPUSH_REVIEW_SKIP: '1', FAKE_PANEL_EXIT: '1' });
  assert.notEqual(r.status, 0);
  assert.equal(s.remoteHasMain(), false);
});

test('real git push in a repo with a husky-style local core.hooksPath: still reviewed, and husky still runs', () => {
  const s = pushSetup({ husky: true });
  const bad = s.push({ FAKE_PANEL_EXIT: '1' });
  assert.notEqual(bad.status, 0, bad.stderr);
  assert.equal(s.remoteHasMain(), false, 'the global gate blocked despite the local hooksPath');

  const good = s.push({});
  assert.equal(good.status, 0, good.stderr);
  assert.equal(s.calls(), 2);
  assert.equal(existsSync(s.marker), true, 'the repo-local hook ran too');
});

test('real git push --no-verify is the one way past the gate (documented limit)', () => {
  const s = pushSetup();
  const r = s.push({ FAKE_PANEL_EXIT: '1' }, '--no-verify');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(s.calls(), 0);
});
