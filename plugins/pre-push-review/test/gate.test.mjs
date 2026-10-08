import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { SCRIPTS, fakePlugin, git, installGate, makeRepo, runNode, tempDir } from './helpers.mjs';

const GUARD = join(SCRIPTS, 'prepush-gate.mjs');

// One installed machine shared by the tests that only read it.
const plugin = fakePlugin();
const home = installGate(plugin);

function guard({ command, cwd, tool = 'Bash', timeout = 600000, input = {}, env = {}, h = home }) {
  const tool_input = { command, ...(timeout === null ? {} : { timeout }), ...input };
  return runNode(GUARD, {
    input: JSON.stringify({ tool_name: tool, tool_input, cwd }),
    env: { HOME: h, ...env },
  });
}

test('an installed gate lets a plain push through, silently, without deciding permission', () => {
  const repo = makeRepo('repo');
  const r = guard({ command: 'git push -u origin main', cwd: repo });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, '', 'no permissionDecision or other output');
});

test('the guard never runs the panel', () => {
  const repo = makeRepo('repo');
  // The installed command points at a plugin whose panel would fail loudly if it ran.
  const r = guard({ command: 'git push', cwd: repo, env: { FAKE_PANEL_LOG: join(tempDir('x'), 'log') } });
  assert.equal(r.code, 0, r.stderr);
});

test('follows cd and -C to the repository being pushed', () => {
  const session = makeRepo('session');
  const other = makeRepo('other');
  assert.equal(guard({ command: `cd ${other} && git push`, cwd: session }).code, 0);
  assert.equal(guard({ command: `git -C ${other} push`, cwd: session }).code, 0);
  // A second home without the gate: every route to a push in it is blocked.
  const bare = tempDir('home');
  assert.equal(guard({ command: `git -C ${other} push`, cwd: session, h: bare }).code, 2);
});

test('stays out of the way when there is no push', () => {
  const repo = makeRepo('repo');
  const bare = tempDir('home'); // no gate installed: irrelevant without a push
  for (const command of ['git status', 'git commit -m "push the button"', 'echo "git push"', 'ls']) {
    assert.equal(guard({ command, cwd: repo, h: bare, timeout: null }).code, 0, command);
  }
  assert.equal(guard({ command: 'git push', cwd: repo, tool: 'Read', h: bare, timeout: null }).code, 0);
  assert.equal(runNode(GUARD, { input: 'not json' }).code, 0);
});

test('blocks a push whose directory cannot be known', () => {
  const repo = makeRepo('repo');
  const r = guard({ command: 'cd "$TARGET" && git push', cwd: repo });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /cannot tell which repository/);
  assert.equal(guard({ command: `cd ${repo} && git push && cd "$X" && git push`, cwd: repo }).code, 2);
});

test('blocks when the target is not a repository or does not exist', () => {
  const repo = makeRepo('repo');
  const notRepo = tempDir('plain');
  for (const command of [`cd ${notRepo} && git push`, `git -C ${notRepo}/missing push`]) {
    const r = guard({ command, cwd: repo });
    assert.equal(r.code, 2, command);
    assert.match(r.stderr, /not a git repository/);
  }
});

test('blocks when the global gate is not installed', () => {
  const repo = makeRepo('repo');
  const r = guard({ command: 'git push', cwd: repo, h: tempDir('home') });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /not active/);
  assert.match(r.stderr, /install-git-hook\.mjs/);
});

test('blocks when the configured command points at a missing runner', () => {
  const repo = makeRepo('repo');
  const h = tempDir('home');
  writeFileSync(join(h, '.gitconfig'), '[hook "ai-review"]\n\tevent = pre-push\n\tcommand = node /nowhere/git-pre-push.mjs\n');
  const r = guard({ command: 'git push', cwd: repo, h });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /does not point at an existing git-pre-push\.mjs/);
});

test('blocks when the gate is disabled or overridden in the repository', () => {
  const disabled = makeRepo('disabled');
  git(disabled, 'config', 'hook.ai-review.enabled', 'false');
  const r1 = guard({ command: 'git push', cwd: disabled });
  assert.equal(r1.code, 2);
  assert.match(r1.stderr, /disabled/);

  const overridden = makeRepo('overridden');
  git(overridden, 'config', 'hook.ai-review.command', 'true');
  const r2 = guard({ command: 'git push', cwd: overridden });
  assert.equal(r2.code, 2);
  assert.match(r2.stderr, /exactly once, in the global git config/);
});

test('blocks bypass attempts on the command', () => {
  const repo = makeRepo('repo');
  const cases = {
    '--no-verify': 'git push --no-verify',
    '--no-verify before the remote': 'git push origin --no-verify main',
    'abbreviated --no-verify': 'git push --no-verif',
    'core.hooksPath': 'git -c core.hooksPath=/dev/null push',
    'core.hooksPath glued': 'git -ccore.hooksPath=/dev/null push',
    'hook override': 'git -c hook.ai-review.command=true push',
    '--config-env': 'git --config-env=core.hooksPath=X push',
    GIT_CONFIG_GLOBAL: 'GIT_CONFIG_GLOBAL=/dev/null git push',
    GIT_CONFIG_NOSYSTEM: 'GIT_CONFIG_NOSYSTEM=1 git push',
    GIT_CONFIG_COUNT: 'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/x git push',
    PREPUSH_REVIEW_SKIP: 'PREPUSH_REVIEW_SKIP=1 git push',
    AI_REVIEW_SKIP: 'AI_REVIEW_SKIP=1 git push',
    AI_REVIEW_REQUIRED: 'AI_REVIEW_REQUIRED=0 git push',
    'exported variable': 'export AI_REVIEW_SKIP=1; git push',
    'env wrapper': 'env AI_REVIEW_SKIP=1 git push',
    'inside bash -c': "bash -c 'git push --no-verify'",
  };
  for (const [name, command] of Object.entries(cases)) {
    const r = guard({ command, cwd: repo });
    assert.equal(r.code, 2, `${name}: ${command}`);
    assert.match(r.stderr, /cannot be skipped|--no-verify|can change or skip|replace the review/, name);
  }
});

test('blocks bypass variables exported in the hook process environment', () => {
  const repo = makeRepo('repo');
  for (const name of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'PREPUSH_REVIEW_SKIP', 'AI_REVIEW_SKIP', 'AI_REVIEW_REQUIRED']) {
    const r = guard({ command: 'git push', cwd: repo, env: { [name]: '1' } });
    assert.equal(r.code, 2, name);
    assert.match(r.stderr, new RegExp(name));
  }
});

test('--no-verify on a command that is not a push is not an objection', () => {
  const repo = makeRepo('repo');
  assert.equal(guard({ command: 'git commit --no-verify -m x', cwd: repo, timeout: null }).code, 0);
});

test('blocks git config commands that change the gate, allows reading it', () => {
  const repo = makeRepo('repo');
  const blocked = [
    'git config --global hook.ai-review.command true',
    'git config --global --unset hook.ai-review.event',
    'git config --global --unset-all core.hooksPath',
    'git config core.hooksPath /tmp/x',
    'git config --global core.hookspath /tmp/x',
    'git config --global --remove-section hook.ai-review',
    'git config set --global hook.ai-review.enabled false',
    'git -C /tmp config hook.ai-review.enabled false',
  ];
  for (const command of blocked) {
    const r = guard({ command, cwd: repo, timeout: null });
    assert.equal(r.code, 2, command);
    assert.match(r.stderr, /Ask the user/);
  }
  for (const command of [
    'git config --get hook.ai-review.command',
    'git config --global --get-all core.hooksPath',
    'git config --list',
    'git config user.name x',
  ]) {
    assert.equal(guard({ command, cwd: repo, timeout: null }).code, 0, command);
  }
});

test('blocks a push whose Bash call would be killed before the review ends', () => {
  const repo = makeRepo('repo');
  for (const timeout of [null, 120000, 599999]) {
    const r = guard({ command: 'git push', cwd: repo, timeout });
    assert.equal(r.code, 2, String(timeout));
    assert.match(r.stderr, /timeout 600000/);
  }
  assert.equal(guard({ command: 'git push', cwd: repo, timeout: 600000 }).code, 0);
  assert.equal(guard({ command: 'git push', cwd: repo, timeout: null, input: { run_in_background: true } }).code, 0);
});

test('a commit and a push in one command are no longer special: git runs the hook at push time', () => {
  const repo = makeRepo('repo');
  assert.equal(guard({ command: 'git commit -am x && git push', cwd: repo }).code, 0);
});

test('several pushes: one block blocks the whole command', () => {
  const repo = makeRepo('repo');
  const plain = tempDir('plain');
  const r = guard({ command: `git push && cd ${plain} && git push`, cwd: repo });
  assert.equal(r.code, 2);
});
