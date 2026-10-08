import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { executable, fakePlugin, git, installGate, makeRepo, runNode, tempDir, write } from './helpers.mjs';

const ZERO = '0'.repeat(40);
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

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

test('passes when the panel passes, runs it on the pushed range in the repo root, and streams its output', () => {
  const repo = makeRepo('repo', { 'src/a.js': 'a\n' });
  const sub = join(repo, 'src');
  const r = runRunner({ cwd: sub });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.calls.map((c) => [c.cwd, c.args, c.required]), [[repo, ['--range', EMPTY_TREE, r.sha], '1']]);
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

test('a child of the panel that keeps the pipes open cannot hang the runner, and it is killed', async () => {
  const started = Date.now();
  // The panel exits at once, but its child holds stdout open: 'close' never fires.
  const r = runRunner({ env: { FAKE_PANEL_GRANDCHILD: '1', AI_REVIEW_GATE_TIMEOUT_MS: '800' } });
  assert.equal(r.code, 1);
  assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
  assert.match(r.stderr, /did not finish in 800 ms/);
  const pid = Number(readFileSync(join(r.home, 'panel-calls.jsonl.child'), 'utf8'));
  await new Promise((res) => setTimeout(res, 300));
  assert.throws(() => process.kill(pid, 0), 'the grandchild was killed with the process group');
});

test('a hanging panel with a child is killed within the timeout plus a margin', () => {
  const started = Date.now();
  const r = runRunner({ env: { FAKE_PANEL_GRANDCHILD: '1', FAKE_PANEL_HANG: '1', AI_REVIEW_GATE_TIMEOUT_MS: '800' } });
  assert.equal(r.code, 1);
  assert.ok(Date.now() - started < 5000);
});

test('a stdin that never ends does not short-circuit as a deletion', async () => {
  const cwd = makeRepo('repo');
  const home = tempDir('home');
  const plugin = fakePlugin();
  const child = spawn(process.execPath, [join(plugin, 'scripts', 'git-pre-push.mjs')], {
    cwd,
    env: { ...process.env, HOME: home, FAKE_PANEL_LOG: join(home, 'calls'), FAKE_PANEL_EXIT: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // A deletion line, but the stream is never closed: the runner's read limit (5 s) expires.
  child.stdin.write(`(delete) ${ZERO} refs/heads/old ${'a'.repeat(40)}\n`);
  const status = await new Promise((res) => child.on('close', res));
  child.stdin.destroy();
  assert.equal(status, 1, 'the panel ran and its failure blocked');
  assert.ok(existsSync(join(home, 'calls')), 'the panel ran');
});

test('SIGTERM to the runner kills the panel and its child', async () => {
  const cwd = makeRepo('repo');
  const home = tempDir('home');
  const plugin = fakePlugin();
  const calls = join(home, 'calls');
  const child = spawn(process.execPath, [join(plugin, 'scripts', 'git-pre-push.mjs')], {
    cwd,
    env: { ...process.env, HOME: home, FAKE_PANEL_LOG: calls, FAKE_PANEL_GRANDCHILD: '1', FAKE_PANEL_HANG: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end(`refs/heads/main ${git(cwd, 'rev-parse', 'HEAD')} refs/heads/main ${ZERO}\n`);
  for (let i = 0; i < 100 && !existsSync(`${calls}.child`); i += 1) await new Promise((r) => setTimeout(r, 50));
  child.kill('SIGTERM');
  const status = await new Promise((res) => child.on('close', res));
  assert.equal(status, 1);
  const pid = Number(readFileSync(`${calls}.child`, 'utf8'));
  await new Promise((res) => setTimeout(res, 300));
  assert.throws(() => process.kill(pid, 0), 'the grandchild is gone');
});

test('mixed refs (a deletion and a real push) are reviewed', () => {
  const sha = git(makeRepo('x'), 'rev-parse', 'HEAD');
  const r = runRunner({ input: `(delete) ${ZERO} refs/heads/old ${sha}\nrefs/heads/main ${sha} refs/heads/main ${ZERO}\n` });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.calls.length, 1);
});

test('the cache directory is private (0700) and the log is 0600', () => {
  const r = runRunner();
  const dir = join(r.home, '.cache', 'git-ai-review');
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, `review-${r.sha}.log`)).mode & 0o777, 0o600);
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

function pushSetup({ husky = false, withPanel = true } = {}) {
  const plugin = fakePlugin({ withPanel });
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

  const missing = pushSetup({ withPanel: false });
  const r = missing.push({});
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /panel is missing/);
  assert.equal(missing.remoteHasMain(), false);
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

// --- Exactly what is pushed: the range comes from git's ref list, not from HEAD ---------------

/** A repo with a bare remote holding `main`, plus a local branch `feat` with one more commit. */
function repoWithRemote() {
  const repo = makeRepo('pushed', { 'a.js': 'a\n' });
  const remote = tempDir('remote');
  git(remote, 'init', '-q', '--bare');
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-q', '--no-verify', 'origin', 'main');
  const mainSha = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'switch', '-q', '-c', 'feat');
  write(repo, { 'b.js': 'b\n' });
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'feat');
  const featSha = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'switch', '-q', 'main');
  return { repo, mainSha, featSha };
}

function runWithArgs(cwd, input, args = ['origin', 'url']) {
  const home = tempDir('home');
  const log = join(home, 'panel-calls.jsonl');
  const r = runNode(join(fakePlugin(), 'scripts', 'git-pre-push.mjs'), {
    cwd,
    args,
    input,
    env: { HOME: home, FAKE_PANEL_LOG: log },
  });
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  return { ...r, calls };
}

test('first push to an empty remote reviews every commit, from the empty tree', () => {
  const repo = makeRepo('fresh', { 'a.js': 'a\n' });
  write(repo, { 'b.js': 'b\n' });
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'second');
  const sha = git(repo, 'rev-parse', 'HEAD');
  const r = runWithArgs(repo, `refs/heads/main ${sha} refs/heads/main ${ZERO}\n`, ['origin', '/nowhere']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.calls.map((c) => c.args), [['--range', EMPTY_TREE, sha]]);
});

test('a branch that is not checked out is reviewed, not HEAD', () => {
  const { repo, mainSha, featSha } = repoWithRemote();
  assert.equal(git(repo, 'rev-parse', 'HEAD'), mainSha, 'HEAD is main');
  const r = runWithArgs(repo, `refs/heads/feat ${featSha} refs/heads/feat ${ZERO}\n`);
  assert.equal(r.code, 0, r.stderr);
  // feat is new to the remote: its own commit only, based on what the remote already has.
  assert.deepEqual(r.calls.map((c) => c.args), [['--range', mainSha, featSha]]);
});

test('an existing remote ref is reviewed from the remote tip to the pushed tip', () => {
  const { repo, mainSha, featSha } = repoWithRemote();
  const r = runWithArgs(repo, `refs/heads/feat ${featSha} refs/heads/main ${mainSha}\n`);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.calls.map((c) => c.args), [['--range', mainSha, featSha]]);
});

test('pushing commits the remote already has (a new name for them) runs no review', () => {
  const { repo, mainSha } = repoWithRemote();
  const r = runWithArgs(repo, `refs/heads/copy ${mainSha} refs/heads/copy ${ZERO}\n`);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.calls.length, 0);
  assert.match(r.stderr, /already has every pushed commit/);
});

test('two refs are each reviewed once', () => {
  const { repo, mainSha, featSha } = repoWithRemote();
  git(repo, 'switch', '-q', '-c', 'other', mainSha);
  write(repo, { 'c.js': 'c\n' });
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'other');
  const otherSha = git(repo, 'rev-parse', 'HEAD');
  const input =
    `refs/heads/feat ${featSha} refs/heads/feat ${ZERO}\n` +
    `refs/heads/other ${otherSha} refs/heads/other ${ZERO}\n` +
    `refs/heads/feat ${featSha} refs/heads/feat2 ${ZERO}\n`;
  const r = runWithArgs(repo, input);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.calls.map((c) => c.args), [
    ['--range', mainSha, featSha],
    ['--range', mainSha, otherSha],
  ]);
});

test('one blocking range blocks the whole push', () => {
  const { repo, featSha } = repoWithRemote();
  const home = tempDir('home');
  const r = runNode(join(fakePlugin(), 'scripts', 'git-pre-push.mjs'), {
    cwd: repo,
    args: ['origin', 'url'],
    input: `refs/heads/feat ${featSha} refs/heads/feat ${ZERO}\n`,
    env: { HOME: home, FAKE_PANEL_LOG: join(home, 'l'), FAKE_PANEL_EXIT: '1', FAKE_PANEL_OUT: '[CRITICAL] b.js:1 - x\n' },
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /PUSH BLOCKED/);
});

test('a pushed sha this repository does not have blocks instead of skipping', () => {
  const repo = makeRepo('repo');
  const r = runWithArgs(repo, `refs/heads/main ${'b'.repeat(40)} refs/heads/main ${ZERO}\n`);
  assert.equal(r.code, 1);
  assert.equal(r.calls.length, 0);
  assert.match(r.stderr, /cannot list the commits/);
});

test('a ref list that is not usable falls back to the panel\'s own --branch guess', () => {
  const repo = makeRepo('repo');
  const r = runWithArgs(repo, 'garbage line here\n');
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.calls.map((c) => c.args), [['--branch']]);
});

test('real git push of a branch that is not checked out sends the panel that branch', () => {
  const { repo, mainSha, featSha } = repoWithRemote();
  const home = installGate(fakePlugin());
  const log = join(home, 'panel-calls.jsonl');
  const env = { ...process.env, HOME: home, FAKE_PANEL_LOG: log };
  for (const name of Object.keys(env)) if (/^(GIT_CONFIG|AI_REVIEW_|PREPUSH_REVIEW_)/.test(name)) delete env[name];
  const r = spawnSync('git', ['push', 'origin', 'feat'], { cwd: repo, encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  const calls = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(calls.map((c) => c.args), [['--range', mainSha, featSha]]);
});

test('only the second of two ranges blocks: the whole push is blocked, and both were reviewed', () => {
  const { repo, mainSha, featSha } = repoWithRemote();
  git(repo, 'switch', '-q', '-c', 'other', mainSha);
  write(repo, { 'c.js': 'c\n' });
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'other');
  const otherSha = git(repo, 'rev-parse', 'HEAD');
  const home = tempDir('home');
  const log = join(home, 'l');
  const r = runNode(join(fakePlugin(), 'scripts', 'git-pre-push.mjs'), {
    cwd: repo,
    args: ['origin', 'url'],
    input: `refs/heads/feat ${featSha} refs/heads/feat ${ZERO}\nrefs/heads/other ${otherSha} refs/heads/other ${ZERO}\n`,
    env: { HOME: home, FAKE_PANEL_LOG: log, FAKE_PANEL_FAIL_HEAD: otherSha },
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /broken on this range/);
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 2);
});

test('only the first of two ranges blocks: a later pass does not undo the block', () => {
  const { repo, mainSha, featSha } = repoWithRemote();
  git(repo, 'switch', '-q', '-c', 'other', mainSha);
  write(repo, { 'c.js': 'c\n' });
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'other');
  const otherSha = git(repo, 'rev-parse', 'HEAD');
  const home = tempDir('home');
  const r = runNode(join(fakePlugin(), 'scripts', 'git-pre-push.mjs'), {
    cwd: repo,
    args: ['origin', 'url'],
    input: `refs/heads/feat ${featSha} refs/heads/feat ${ZERO}\nrefs/heads/other ${otherSha} refs/heads/other ${ZERO}\n`,
    env: { HOME: home, FAKE_PANEL_LOG: join(home, 'l'), FAKE_PANEL_FAIL_HEAD: featSha },
  });
  assert.equal(r.code, 1);
});

test('a commit that is on another remote but not on the pushed one is still reviewed', () => {
  const { repo, mainSha, featSha } = repoWithRemote();
  const other = tempDir('other');
  git(other, 'init', '-q', '--bare');
  git(repo, 'remote', 'add', 'mirror', other);
  git(repo, 'push', '-q', '--no-verify', 'mirror', 'feat');
  const r = runWithArgs(repo, `refs/heads/feat ${featSha} refs/heads/feat ${ZERO}\n`, ['origin', 'url']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.calls.map((c) => c.args), [['--range', mainSha, featSha]]);
});

test('a remote tip this repository does not have falls back to "not on that remote"', () => {
  const { repo, mainSha, featSha } = repoWithRemote();
  const r = runWithArgs(repo, `refs/heads/feat ${featSha} refs/heads/feat ${'c'.repeat(40)}\n`);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.calls.map((c) => c.args), [['--range', mainSha, featSha]]);
});

test('clock skew plus a merge does not hide pushed commits (base is the merge base, not "parent of the last listed")', () => {
  const { repo, mainSha } = repoWithRemote();
  const at = (date, ...args) => {
    const r = spawnSync('git', args, {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    });
    assert.equal(r.status, 0, r.stderr);
  };
  git(repo, 'switch', '-q', '-c', 'work', mainSha);
  write(repo, { 'f.js': 'f\n' });
  git(repo, 'add', '-A');
  at('2005-01-01T00:00:00Z', 'commit', '-q', '-m', 'F');
  const f = git(repo, 'rev-parse', 'HEAD');
  write(repo, { 'b.js': 'b\n' });
  git(repo, 'add', '-A');
  at('2020-01-01T00:00:00Z', 'commit', '-q', '-m', 'B');
  git(repo, 'switch', '-q', '-c', 'g', f);
  write(repo, { 'g.js': 'g\n' });
  git(repo, 'add', '-A');
  at('2001-01-01T00:00:00Z', 'commit', '-q', '-m', 'G');
  git(repo, 'switch', '-q', 'work');
  at('2021-01-01T00:00:00Z', 'merge', '-q', '--no-edit', 'g');
  const head = git(repo, 'rev-parse', 'HEAD');
  const listed = git(repo, 'rev-list', head, '--not', '--remotes=origin').split('\n');
  const parentOfLast = git(repo, 'rev-parse', `${listed.at(-1)}^`);
  assert.equal(parentOfLast, f, 'precondition: the old rule would have used F as the base');
  const r = runWithArgs(repo, `refs/heads/work ${head} refs/heads/work ${ZERO}\n`);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.calls.map((c) => c.args), [['--range', mainSha, head]]);
});

test('a pushed merge of two new branches is reviewed from where they left the remote', () => {
  const { repo, mainSha } = repoWithRemote();
  git(repo, 'switch', '-q', '-c', 'side', mainSha);
  write(repo, { 'side.js': 's\n' });
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'side');
  git(repo, 'switch', '-q', 'feat');
  git(repo, 'merge', '-q', '--no-edit', 'side');
  const head = git(repo, 'rev-parse', 'HEAD');
  const r = runWithArgs(repo, `refs/heads/feat ${head} refs/heads/feat ${ZERO}\n`);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.calls.map((c) => c.args), [['--range', mainSha, head]]);
});

test('pushing to a URL: a commit already on a configured remote is still reviewed (never an empty range)', () => {
  const { repo, featSha } = repoWithRemote();
  // origin already has feat, but the push goes to a bare URL that has nothing.
  git(repo, 'push', '-q', '--no-verify', 'origin', 'feat');
  git(repo, 'fetch', '-q', 'origin');
  const url = tempDir('url-remote');
  git(url, 'init', '-q', '--bare');
  const r = runWithArgs(repo, `refs/heads/feat ${featSha} refs/heads/feat ${ZERO}\n`, [url, url]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.calls.map((c) => c.args), [['--range', EMPTY_TREE, featSha]]);
});

test('several tips on the target remote: the base is their common attachment point', () => {
  const { repo, mainSha, featSha } = repoWithRemote();
  // origin also has `rel`, one commit ahead of main; feat forked from main and does not contain rel.
  git(repo, 'switch', '-q', '-c', 'rel', mainSha);
  write(repo, { 'rel.js': 'r\n' });
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'rel');
  git(repo, 'push', '-q', '--no-verify', 'origin', 'rel');
  git(repo, 'fetch', '-q', 'origin');
  // An update of an existing remote ref, with the remote's tip known locally.
  git(repo, 'push', '-q', '--no-verify', 'origin', `${mainSha}:refs/heads/feat`);
  git(repo, 'fetch', '-q', 'origin');
  const r = runWithArgs(repo, `refs/heads/feat ${featSha} refs/heads/feat ${mainSha}\n`);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.calls.map((c) => c.args), [['--range', mainSha, featSha]]);
});
