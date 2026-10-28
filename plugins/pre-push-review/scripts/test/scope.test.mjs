import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { addDetachedWorktree, readHeadFile, resolveScope, ScopeError } from '../lib/scope.mjs';
import { getReviewed, loadLastResult, saveLastResult, setReviewed, stateDir } from '../lib/state.mjs';
import { makeRepo, remove, tempDir } from './helpers.mjs';

const paths = (scope) => scope.files.map((f) => f.path).sort();

test('scope auto — staged changes win over unstaged ones, which win over commits', () => {
  const repo = makeRepo({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
  try {
    repo.write('a.txt', 'a staged\n');
    repo.git('add', 'a.txt');
    repo.write('b.txt', 'b unstaged\n');

    const staged = resolveScope({ cwd: repo.root });
    assert.equal(staged.mode, 'staged');
    assert.deepEqual(paths(staged), ['a.txt']);
    assert.equal(staged.headKind, 'index');
    assert.equal(staged.headSha, null);

    repo.git('reset', '--quiet');
    const working = resolveScope({ cwd: repo.root });
    assert.equal(working.mode, 'working');
    assert.deepEqual(paths(working), ['a.txt', 'b.txt']);

    repo.git('checkout', '--quiet', '--', '.');
    const branch = resolveScope({ cwd: repo.root });
    assert.equal(branch.mode, 'branch');
  } finally {
    remove(repo.root);
  }
});

test('scope staged — reads file content from the index, not the working tree', () => {
  const repo = makeRepo({ 'a.txt': 'one\n' });
  try {
    repo.write('a.txt', 'one\nSTAGED\n');
    repo.git('add', 'a.txt');
    repo.write('a.txt', 'one\nSTAGED\nNOT STAGED\n');
    const scope = resolveScope({ cwd: repo.root, mode: 'staged' });
    assert.equal(readHeadFile(scope, 'a.txt'), 'one\nSTAGED\n');
    assert.deepEqual(scope.dirtyPaths, ['a.txt']);
    assert.equal(scope.notes.length, 1);
  } finally {
    remove(repo.root);
  }
});

test('scope branch — only commits the remote does not have', () => {
  const remote = tempDir('ppr-remote-');
  const repo = makeRepo({ 'a.txt': 'a\n' });
  try {
    repo.git('init', '--quiet', '--bare', remote);
    repo.git('remote', 'add', 'origin', remote);
    repo.git('push', '--quiet', '-u', 'origin', 'main');
    repo.commit('pushed later', { 'pushed.txt': 'p\n' });
    repo.git('push', '--quiet');
    repo.commit('local 1', { 'l1.txt': '1\n' });
    const head = repo.commit('local 2', { 'l2.txt': '2\n' });

    const scope = resolveScope({ cwd: repo.root, mode: 'branch' });
    assert.deepEqual(paths(scope), ['l1.txt', 'l2.txt']);
    assert.equal(scope.headSha, head);
    assert.match(scope.description, /^2 commit\(s\)/);
    assert.equal(scope.repoCommandsAllowed, true);

    repo.git('push', '--quiet');
    assert.deepEqual(paths(resolveScope({ cwd: repo.root, mode: 'branch' })), []);
  } finally {
    remove(repo.root);
    remove(remote);
  }
});

test('scope branch — a repository with no remote reviews every commit, including the first', () => {
  const repo = makeRepo({ 'a.txt': 'a\n' });
  try {
    repo.commit('second', { 'b.txt': 'b\n' });
    const scope = resolveScope({ cwd: repo.root, mode: 'branch' });
    assert.deepEqual(paths(scope), ['a.txt', 'b.txt']);
  } finally {
    remove(repo.root);
  }
});

test('scope base — diffs from the merge base, so changes made on the base branch are not reviewed', () => {
  const repo = makeRepo({ 'a.txt': 'a\n' });
  try {
    repo.git('switch', '--quiet', '-c', 'feature');
    repo.commit('feature work', { 'f.txt': 'f\n' });
    repo.git('switch', '--quiet', 'main');
    repo.commit('main moved', { 'm.txt': 'm\n' });
    repo.git('switch', '--quiet', 'feature');
    const scope = resolveScope({ cwd: repo.root, mode: 'base', base: 'main' });
    assert.deepEqual(paths(scope), ['f.txt']);
  } finally {
    remove(repo.root);
  }
});

test('scope — excluded files are left out and listed', () => {
  const repo = makeRepo({ 'a.txt': 'a\n' });
  try {
    repo.git('switch', '--quiet', '-c', 'feature');
    repo.commit('deps', { 'src/a.ts': 'x\n', 'package-lock.json': '{}\n', 'dist/out.js': 'y\n', 'pkg/yarn.lock': 'z\n' });
    const scope = resolveScope({ cwd: repo.root, mode: 'base', base: 'main', exclude: ['*-lock.json', '*.lock', 'dist/**'] });
    assert.deepEqual(paths(scope), ['src/a.ts']);
    assert.deepEqual([...scope.excluded].sort(), ['dist/out.js', 'package-lock.json', 'pkg/yarn.lock']);
    assert.deepEqual(scope.stats, { files: 1, additions: 1, deletions: 0 });
  } finally {
    remove(repo.root);
  }
});

test('scope — file names with spaces and glob characters are handled literally', () => {
  const repo = makeRepo({ 'a.txt': 'a\n' });
  try {
    repo.git('switch', '--quiet', '-c', 'feature');
    repo.commit('odd names', { 'my file [v2].txt': 'x\n', 'star*.txt': 'y\n' });
    const scope = resolveScope({ cwd: repo.root, mode: 'base', base: 'main' });
    assert.deepEqual(paths(scope), ['my file [v2].txt', 'star*.txt']);
  } finally {
    remove(repo.root);
  }
});

test('scope incremental — reviews only what came after the last complete review', () => {
  const repo = makeRepo({ 'a.txt': 'a\n' });
  try {
    repo.git('switch', '--quiet', '-c', 'feature');
    const first = repo.commit('one', { 'one.txt': '1\n' });
    const initial = resolveScope({ cwd: repo.root, mode: 'base', base: 'main', incremental: true });
    assert.equal(initial.incremental, false, 'nothing reviewed yet');
    assert.deepEqual(paths(initial), ['one.txt']);
    setReviewed(repo.root, initial.key, { headSha: first, baseSha: initial.baseSha });

    const same = resolveScope({ cwd: repo.root, mode: 'base', base: 'main', incremental: true });
    assert.deepEqual(paths(same), []);
    assert.match(same.notes.join(' '), /nothing new/);

    repo.commit('two', { 'two.txt': '2\n' });
    const next = resolveScope({ cwd: repo.root, mode: 'base', base: 'main', incremental: true });
    assert.equal(next.incremental, true);
    assert.equal(next.baseSha, first);
    assert.deepEqual(paths(next), ['two.txt']);

    const full = resolveScope({ cwd: repo.root, mode: 'base', base: 'main', incremental: true, full: true });
    assert.deepEqual(paths(full), ['one.txt', 'two.txt']);
    const optOut = resolveScope({ cwd: repo.root, mode: 'base', base: 'main' });
    assert.deepEqual(paths(optOut), ['one.txt', 'two.txt']);
  } finally {
    remove(repo.root);
  }
});

test('scope incremental — rewritten history falls back to a full review and says why', () => {
  const repo = makeRepo({ 'a.txt': 'a\n' });
  try {
    repo.git('switch', '--quiet', '-c', 'feature');
    const first = repo.commit('one', { 'one.txt': '1\n' });
    const key = resolveScope({ cwd: repo.root, mode: 'base', base: 'main' }).key;
    setReviewed(repo.root, key, { headSha: first });
    repo.git('commit', '--quiet', '--amend', '-m', 'one, amended');
    repo.commit('two', { 'two.txt': '2\n' });

    const scope = resolveScope({ cwd: repo.root, mode: 'base', base: 'main', incremental: true });
    assert.equal(scope.incremental, false);
    assert.deepEqual(paths(scope), ['one.txt', 'two.txt']);
    assert.match(scope.notes.join(' '), /history changed/);
  } finally {
    remove(repo.root);
  }
});

test('scope — bad input fails with a clear error instead of reviewing something else', () => {
  const repo = makeRepo();
  const notRepo = tempDir();
  try {
    assert.throws(() => resolveScope({ cwd: notRepo }), ScopeError);
    assert.throws(() => resolveScope({ cwd: repo.root, mode: 'base', base: 'no-such-branch' }), /cannot resolve base/);
    assert.throws(() => resolveScope({ cwd: repo.root, mode: 'base', base: '--output=/tmp/x' }), /cannot resolve base/);
    assert.throws(() => resolveScope({ cwd: repo.root, mode: 'everything' }), /unknown mode/);
    assert.throws(() => resolveScope({ cwd: repo.root, mode: 'pr', pr: '12; rm -rf /' }), /pull request number/);
  } finally {
    remove(repo.root);
    remove(notRepo);
  }
});

test('worktree — checking out a commit never runs a hook shipped inside that commit', () => {
  const repo = makeRepo({ 'a.txt': 'a\n' });
  const marker = join(tempDir('ppr-marker-'), 'HOOK_RAN');
  try {
    // What husky sets up: a hooks path relative to the worktree, here committed by the "PR".
    repo.git('config', 'core.hooksPath', '.hooks');
    const hook = `#!/bin/sh\necho ran > "${marker}"\n`;
    const sha = repo.commit('ship a hook', { '.hooks/post-checkout': hook });
    chmodSync(join(repo.root, '.hooks/post-checkout'), 0o755);
    repo.git('update-index', '--chmod=+x', '.hooks/post-checkout');
    const withExecutableHook = repo.commit('make it executable', {});

    // Control: a plain checkout of that commit DOES run the hook, so the test can fail.
    const control = tempDir('ppr-control-');
    repo.git('worktree', 'add', '--quiet', '--detach', join(control, 'wt'), withExecutableHook);
    assert.equal(existsSync(marker), true, 'control: git runs the committed hook on a plain worktree add');
    rmSync(marker);
    repo.git('worktree', 'remove', '--force', join(control, 'wt'));

    const wt = addDetachedWorktree(repo.root, withExecutableHook);
    try {
      assert.equal(existsSync(join(wt.dir, '.hooks/post-checkout')), true);
      assert.equal(existsSync(marker), false, 'the hook from the checked-out commit was executed');
      assert.equal(repo.git('-C', wt.dir, 'rev-parse', 'HEAD'), withExecutableHook);
    } finally {
      wt.cleanup();
    }
    assert.equal(existsSync(wt.dir), false);
    assert.equal(repo.git('worktree', 'list').split('\n').length, 1);
    assert.notEqual(sha, withExecutableHook);
    remove(control);
  } finally {
    remove(repo.root);
    remove(join(marker, '..'));
  }
});

test('state — lives under the git directory and is shared by worktrees', () => {
  const repo = makeRepo();
  const wt = tempDir('ppr-wt-');
  try {
    assert.ok(stateDir(repo.root).startsWith(`${repo.root}/.git/`));
    setReviewed(repo.root, 'pr:o/r#1', { headSha: 'abc' });
    saveLastResult(repo.root, { findings: [{ id: 'F1' }] });
    assert.equal(repo.git('status', '--porcelain'), '', 'state never shows up as a change');

    repo.git('worktree', 'add', '--quiet', '--detach', wt);
    assert.equal(getReviewed(wt, 'pr:o/r#1').headSha, 'abc');
    assert.deepEqual(loadLastResult(wt).findings, [{ id: 'F1' }]);
    assert.equal(getReviewed(repo.root, 'unknown'), null);
  } finally {
    remove(wt);
    remove(repo.root);
  }
});
