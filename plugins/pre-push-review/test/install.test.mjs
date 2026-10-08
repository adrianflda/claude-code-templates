import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { executable, fakePlugin, runNode, tempDir } from './helpers.mjs';

function installer(plugin) {
  const script = join(plugin, 'scripts', 'install-git-hook.mjs');
  return (env, ...args) => runNode(script, { args, env });
}

test('installs the global config hook and is idempotent', () => {
  const plugin = fakePlugin();
  const run = installer(plugin);
  const cfg = join(tempDir('cfg'), 'gitconfig');
  const env = { GIT_CONFIG_GLOBAL: cfg };
  writeFileSync(cfg, '');

  const first = run(env);
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /set global hook\.ai-review\.event = pre-push/);
  assert.match(first.stdout, /Repository-local git config was not touched/);
  const written = readFileSync(cfg, 'utf8');
  assert.match(written, /event = pre-push/);
  assert.ok(written.includes(`command = node ${join(plugin, 'scripts', 'git-pre-push.mjs')}`), written);

  const second = run(env);
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /Already installed: nothing changed/);
  assert.equal(readFileSync(cfg, 'utf8'), written, 'the file is byte-identical after a second run');
  assert.equal(readFileSync(cfg, 'utf8').match(/\[hook "ai-review"\]/g).length, 1);
});

test('--check reports the state', () => {
  const plugin = fakePlugin();
  const run = installer(plugin);
  const cfg = join(tempDir('cfg'), 'gitconfig');
  writeFileSync(cfg, '');
  const env = { GIT_CONFIG_GLOBAL: cfg };

  const missing = run(env, '--check');
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /NOT installed correctly/);
  assert.match(missing.stderr, /hook\.ai-review\.event/);

  run(env);
  const ok = run(env, '--check');
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /installed/);

  // The plugin moved (new version): the stored command is stale.
  const moved = installer(fakePlugin())(env, '--check');
  assert.equal(moved.code, 1);
  assert.match(moved.stderr, /expected/);
});

function legacyHooksDir(content) {
  const dir = tempDir('hooks');
  executable(join(dir, 'pre-push'), content);
  return dir;
}

test('migrates a global core.hooksPath that runs the old git-ai-review harness', () => {
  const plugin = fakePlugin();
  const run = installer(plugin);
  const dir = legacyHooksDir('#!/bin/sh\nexec node "$HOME/.config/git-ai-review/ai-review-panel.mjs" --branch\n');
  const cfg = join(tempDir('cfg'), 'gitconfig');
  writeFileSync(cfg, `[core]\n\thooksPath = ${dir}\n[user]\n\tname = Keep Me\n`);
  const env = { GIT_CONFIG_GLOBAL: cfg };

  const check = run(env, '--check');
  assert.equal(check.code, 1);
  assert.match(check.stderr, /old git-ai-review harness/);

  const r = run(env);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`unset global core\\.hooksPath \\(was ${dir}`));
  const after = readFileSync(cfg, 'utf8');
  assert.doesNotMatch(after, /hooksPath/);
  assert.match(after, /name = Keep Me/, 'unrelated config is kept');
  assert.equal(run(env, '--check').code, 0);
});

test('collapses duplicate hook.ai-review entries to one, and warns about other hooks in the old directory', () => {
  const plugin = fakePlugin();
  const run = installer(plugin);
  const dir = legacyHooksDir('#!/bin/sh\nexec node "$HOME/.config/git-ai-review/x.mjs"\n');
  executable(join(dir, 'commit-msg'), '#!/bin/sh\n');
  const cfg = join(tempDir('cfg'), 'gitconfig');
  writeFileSync(
    cfg,
    `[core]\n\thooksPath = ${dir}\n[hook "ai-review"]\n\tevent = pre-commit\n\tevent = pre-push\n\tcommand = a\n\tcommand = b\n`,
  );
  const env = { GIT_CONFIG_GLOBAL: cfg };
  const r = run(env);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /WARNING: .*commit-msg/);
  const after = readFileSync(cfg, 'utf8');
  assert.equal(after.match(/command =/g).length, 1);
  assert.equal(after.match(/event =/g).length, 1);
  assert.equal(run(env, '--check').code, 0);
});

test('keeps a global core.hooksPath that is not the old harness', () => {
  const plugin = fakePlugin();
  const run = installer(plugin);
  const dir = legacyHooksDir('#!/bin/sh\necho my own hook\n');
  const cfg = join(tempDir('cfg'), 'gitconfig');
  writeFileSync(cfg, `[core]\n\thooksPath = ${dir}\n`);
  const r = run({ GIT_CONFIG_GLOBAL: cfg });
  assert.equal(r.code, 0, r.stderr);
  assert.match(readFileSync(cfg, 'utf8'), /hooksPath/);
  assert.doesNotMatch(r.stdout, /unset global core\.hooksPath/);
});

test('never touches repository-local config', () => {
  const plugin = fakePlugin();
  const run = installer(plugin);
  const cfg = join(tempDir('cfg'), 'gitconfig');
  writeFileSync(cfg, '');
  const repo = tempDir('repo');
  mkdirSync(join(repo, '.git'));
  const local = join(repo, '.git', 'config');
  writeFileSync(local, '[core]\n\thooksPath = .husky\n');
  const r = runNode(join(plugin, 'scripts', 'install-git-hook.mjs'), { cwd: repo, env: { GIT_CONFIG_GLOBAL: cfg } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(readFileSync(local, 'utf8'), '[core]\n\thooksPath = .husky\n');
});
