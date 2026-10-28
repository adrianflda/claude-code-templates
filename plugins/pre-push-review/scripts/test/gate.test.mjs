import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findPushes } from '../lib/push.mjs';
import { readJsonl } from '../lib/state.mjs';
import { fakeEnv, makeRepo, remove, tempDir } from './helpers.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), '..', 'gate.mjs');

test('findPushes — real pushes, in any position of the command line', () => {
  assert.deepEqual(findPushes('git push'), [{ dir: null, skip: false }]);
  assert.deepEqual(findPushes('git push origin main --force-with-lease'), [{ dir: null, skip: false }]);
  assert.deepEqual(findPushes('npm test && git push -u origin feat'), [{ dir: null, skip: false }]);
  assert.deepEqual(findPushes('git add . ; git commit -m "x"\ngit push'), [{ dir: null, skip: false }]);
  assert.deepEqual(findPushes('git -C ../other push'), [{ dir: '../other', skip: false }]);
  assert.deepEqual(findPushes('git -c user.name=x -C "/tmp/my repo" push'), [{ dir: '/tmp/my repo', skip: false }]);
  assert.equal(findPushes('git push a && git -C b push').length, 2);
});

test('findPushes — an environment prefix does not hide a push', () => {
  assert.deepEqual(findPushes('GIT_SSH_COMMAND="ssh -i key" git push'), [{ dir: null, skip: false }]);
  assert.deepEqual(findPushes('FOO=1 BAR=2 git push'), [{ dir: null, skip: false }]);
  assert.deepEqual(findPushes('PREPUSH_REVIEW_SKIP=1 git push'), [{ dir: null, skip: true }]);
  assert.deepEqual(findPushes('AI_REVIEW_SKIP=1 git push'), [{ dir: null, skip: true }]);
  assert.deepEqual(findPushes('PREPUSH_REVIEW_SKIP=0 git push'), [{ dir: null, skip: false }]);
  // The switch covers the push it prefixes, not another one in the same line.
  assert.deepEqual(findPushes('PREPUSH_REVIEW_SKIP=1 git push a && git push b').map((p) => p.skip), [true, false]);
});

test('findPushes — things that mention push but send nothing', () => {
  for (const command of [
    'git commit -m "push the limits"',
    'echo "git push"',
    'git stash push -m wip',
    'git push --dry-run',
    'git push -n origin main',
    'git push --help',
    'git log --grep push',
    'gh pr create --title "git push fix"',
    'grep -r "git push" docs',
    'git pushx',
    '',
  ]) {
    assert.deepEqual(findPushes(command), [], command);
  }
  assert.deepEqual(findPushes(null), []);
});

const critical = { severity: 'critical', file: 'src/a.js', line: 2, title: 'Drops the last item', issue: 'Off by one.', evidence: 'src/a.js:2', confidence: 0.9 };

function pushedRepo() {
  const remote = tempDir('ppr-remote-');
  const repo = makeRepo({ 'src/a.js': 'export const a = 1;\n' });
  repo.git('init', '--quiet', '--bare', remote);
  repo.git('remote', 'add', 'origin', remote);
  repo.git('push', '--quiet', '-u', 'origin', 'main');
  repo.commit('local change', { 'src/a.js': 'export const a = 1;\nexport const b = a - 1;\n' });
  return { repo, remote };
}

function gate(payload, env) {
  const r = spawnSync('node', [GATE], { input: typeof payload === 'string' ? payload : JSON.stringify(payload), env, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const bash = (command, cwd) => ({ tool_name: 'Bash', tool_input: { command }, cwd });

test('gate — blocks a push with a confirmed critical finding, and feeds the report back', () => {
  const { repo, remote } = pushedRepo();
  const { env, home, logFile } = fakeEnv({
    'correctness reviewer': { output: { summary: 's', findings: [critical] } },
    'independent verifier': { output: { verdicts: [{ id: 'F1', verdict: 'confirmed', reason: 'r', evidence: 'src/a.js:2' }] } },
    reviewer: { output: { summary: 'LGTM', findings: [] } },
  }, { HOME: tempDir('ppr-userhome-') });
  try {
    const r = gate(bash('git push', repo.root), env);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /pre-push-review BLOCKED this push/);
    assert.match(r.stderr, /\[CRITICAL\] F1 src\/a\.js:2 — Drops the last item/);
    assert.match(r.stderr, /1 commit\(s\) about to be pushed/);
    // The gate does not spend a model call on a summary nobody reads in a hook.
    assert.equal(readJsonl(logFile).filter((c) => c.key === null).length, 0);
    assert.equal(readJsonl(logFile).length, 7);
  } finally {
    remove(repo.root);
    remove(remote);
    remove(home);
    remove(env.HOME);
  }
});

test('gate — allows a clean push and leaves a pass marker for the reviewed commit', () => {
  const { repo, remote } = pushedRepo();
  const { env, home } = fakeEnv({ reviewer: { output: { summary: 'LGTM', findings: [] } } }, { HOME: tempDir('ppr-userhome-') });
  try {
    const r = gate(bash('npm test && git push origin main', repo.root), env);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /SUMMARY: 0 critical, 0 high, 0 medium, 0 low/);
    const sha = repo.git('rev-parse', 'HEAD');
    assert.equal(spawnSync('test', ['-f', join(env.HOME, '.cache', 'git-ai-review', `pass-${sha}`)]).status, 0);
  } finally {
    remove(repo.root);
    remove(remote);
    remove(home);
    remove(env.HOME);
  }
});

test('gate — commands that are not a push never start a review', () => {
  const { repo, remote } = pushedRepo();
  const { env, home, logFile } = fakeEnv({ reviewer: { output: { summary: 's', findings: [critical] } } });
  try {
    assert.equal(gate(bash('git commit -m "push harder"', repo.root), env).code, 0);
    assert.equal(gate(bash('git push --dry-run', repo.root), env).code, 0);
    assert.equal(gate({ tool_name: 'Write', tool_input: { command: 'git push' }, cwd: repo.root }, env).code, 0);
    assert.equal(gate('not json at all', env).code, 0);
    assert.equal(gate(bash('PREPUSH_REVIEW_SKIP=1 git push', repo.root), env).code, 0);
    assert.equal(gate(bash('git push', repo.root), { ...env, PREPUSH_REVIEW_SKIP: '1' }).code, 0);
    assert.equal(readJsonl(logFile).length, 0);
  } finally {
    remove(repo.root);
    remove(remote);
    remove(home);
  }
});

test('gate — an environment prefix is still reviewed; -C reviews the repository it points at', () => {
  const { repo, remote } = pushedRepo();
  const elsewhere = tempDir('ppr-elsewhere-');
  const { env, home, logFile } = fakeEnv({
    'correctness reviewer': { output: { summary: 's', findings: [critical] } },
    'independent verifier': { output: { verdicts: [{ id: 'F1', verdict: 'confirmed', reason: 'r', evidence: 'src/a.js:2' }] } },
    reviewer: { output: { summary: 'LGTM', findings: [] } },
  }, { HOME: tempDir('ppr-userhome-') });
  try {
    assert.equal(gate(bash('GIT_SSH_COMMAND="ssh -i k" git push', repo.root), env).code, 2);
    writeFileSync(logFile, '');
    const r = gate(bash(`git -C "${repo.root}" push`, elsewhere), env);
    assert.equal(r.code, 2, r.stderr);
    assert.ok(readJsonl(logFile).every((c) => c.cwd === repo.root));
  } finally {
    remove(repo.root);
    remove(remote);
    remove(elsewhere);
    remove(home);
    remove(env.HOME);
  }
});

test('gate — an invalid config blocks with the reason; gate.enabled=false turns the gate off', () => {
  const { repo, remote } = pushedRepo();
  const { env, home, logFile } = fakeEnv({ reviewer: { output: { summary: 's', findings: [critical] } } });
  try {
    writeFileSync(join(repo.root, '.pre-push-review.json'), JSON.stringify({ blockOn: 'sometimes' }));
    const bad = gate(bash('git push', repo.root), env);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /configuration is invalid[\s\S]*blockOn/);

    writeFileSync(join(repo.root, '.pre-push-review.json'), JSON.stringify({ gate: { enabled: false } }));
    assert.equal(gate(bash('git push', repo.root), env).code, 0);
    assert.equal(readJsonl(logFile).length, 0);
  } finally {
    remove(repo.root);
    remove(remote);
    remove(home);
  }
});

test('gate — a review that cannot run blocks when required, and says so', () => {
  const { repo, remote } = pushedRepo();
  const { env, home } = fakeEnv({ reviewer: { raw: 'Service unavailable', exit: 1 } }, { PREPUSH_REVIEW_REQUIRED: '1' });
  try {
    const r = gate(bash('git push', repo.root), env);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /The review could not run/);
    assert.match(r.stderr, /Every reviewer failed/);
  } finally {
    remove(repo.root);
    remove(remote);
    remove(home);
  }
});
