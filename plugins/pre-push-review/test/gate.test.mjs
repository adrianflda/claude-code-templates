import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { SCRIPTS, executable, git, makeRepo, runNode, tempDir } from './helpers.mjs';

const GATE = join(SCRIPTS, 'prepush-gate.mjs');
const PASS = 'SUMMARY: 0 critical, 0 high, 0 medium, 0 low\n[pre-push-review] Passed. No blocking issues.\n';

/**
 * A plugin root whose panel records the directory it ran in and then behaves as told:
 * FAKE_PANEL_EXIT is its exit code, FAKE_PANEL_OUT its stdout, FAKE_PANEL_KILL makes it die
 * from a signal, FAKE_PANEL_HANG makes it never finish, and FAKE_PANEL_FAIL_IN makes it report
 * a critical issue in that directory.
 */
function fakePlugin() {
  const root = tempDir('plugin');
  mkdirSync(join(root, 'scripts'));
  executable(
    join(root, 'scripts', 'ai-review-panel.mjs'),
    `import { appendFileSync } from 'node:fs';
appendFileSync(process.env.FAKE_PANEL_LOG, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), required: process.env.AI_REVIEW_REQUIRED }) + '\\n');
if (process.env.FAKE_PANEL_KILL) process.kill(process.pid, 'SIGKILL');
if (process.env.FAKE_PANEL_HANG) await new Promise(() => setInterval(() => {}, 1000));
if (process.env.FAKE_PANEL_FAIL_IN === process.cwd()) {
  process.stdout.write('[CRITICAL] x.js:1 — broken\\n');
  process.exit(1);
}
process.stdout.write(process.env.FAKE_PANEL_OUT ?? ${JSON.stringify(PASS)});
process.exit(Number(process.env.FAKE_PANEL_EXIT ?? 0));
`,
  );
  return root;
}

function markers(home) {
  const cache = join(home, '.cache', 'git-ai-review');
  return existsSync(cache) ? readdirSync(cache).filter((f) => f.startsWith('pass-')) : [];
}

function runGate({ command, cwd, env = {}, tool = 'Bash', plugin = fakePlugin() }) {
  const home = tempDir('home');
  const log = join(home, 'panel-calls.jsonl');
  const result = runNode(GATE, {
    input: JSON.stringify({ tool_name: tool, tool_input: { command }, cwd }),
    env: { HOME: home, CLAUDE_PLUGIN_ROOT: plugin, FAKE_PANEL_LOG: log, ...env },
  });
  const calls = existsSync(log)
    ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    : [];
  return { ...result, calls, home };
}

test('reviews the repository the push leaves from, not the session directory', () => {
  const session = makeRepo('session');
  const pushed = makeRepo('pushed');

  const viaCd = runGate({ command: `cd ${pushed} && git push -u origin main`, cwd: session });
  assert.equal(viaCd.code, 0, viaCd.stderr);
  assert.deepEqual(viaCd.calls.map((c) => c.cwd), [pushed]);

  const viaC = runGate({ command: `git -C ${pushed} push`, cwd: session });
  assert.deepEqual(viaC.calls.map((c) => c.cwd), [pushed]);

  const plain = runGate({ command: 'git push', cwd: session });
  assert.deepEqual(plain.calls.map((c) => c.cwd), [session]);
});

test('reviews from the repository root when the push runs in a subdirectory', () => {
  const repo = makeRepo('nested', { 'src/a.js': 'a\n' });
  const result = runGate({ command: 'cd src && git push', cwd: repo });
  assert.deepEqual(result.calls.map((c) => c.cwd), [repo]);
});

test('marker and log are written for the pushed repository', () => {
  const session = makeRepo('session');
  const pushed = makeRepo('pushed', { 'README.md': 'other\n' });
  const result = runGate({ command: `cd ${pushed} && git push`, cwd: session });

  const cache = join(result.home, '.cache', 'git-ai-review');
  const pushedSha = git(pushed, 'rev-parse', 'HEAD');
  assert.deepEqual(markers(result.home), [`pass-${pushedSha}`]);
  const log = readFileSync(join(cache, `review-${pushedSha}.log`), 'utf8');
  assert.match(log, new RegExp(`repository: ${pushed}`));
  assert.match(log, /SUMMARY: 0 critical/);
});

test('a pass reports the summary as hook JSON and does not approve the push itself', () => {
  const repo = makeRepo('repo');
  const result = runGate({
    command: 'git push',
    cwd: repo,
    env: {
      FAKE_PANEL_OUT:
        '[pre-push-review] 3 deleted file(s): the reviewers see their names, not their content.\n' +
        '[pre-push-review] Reviewing 2 commit(s) being pushed (40 lines) with 6 expert agents [model=sonnet]...\n' +
        '[pre-push-review] Note: 2/6 agent(s) failed; review is partial.\n' +
        'SUMMARY: 0 critical, 1 high, 2 medium, 0 low\n' +
        '[pre-push-review] Passed. No blocking issues.\n',
    },
  });
  assert.equal(result.code, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, undefined, 'the permission flow stays in charge');
  for (const text of [out.systemMessage, out.hookSpecificOutput.additionalContext]) {
    assert.match(text, /SUMMARY: 0 critical, 1 high, 2 medium, 0 low/);
    assert.match(text, /2 commit\(s\) being pushed/);
    assert.match(text, /2\/6 agent\(s\) failed; review is partial/);
    assert.match(text, /3 deleted file\(s\)/);
    assert.match(text, new RegExp(repo));
  }
});

test('blocks on critical findings', () => {
  const repo = makeRepo('repo');
  const result = runGate({
    command: 'git push',
    cwd: repo,
    env: { FAKE_PANEL_EXIT: '1', FAKE_PANEL_OUT: '[CRITICAL] a.js:1 — leaks a token\n' },
  });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /critical issue\(s\) found/);
  assert.match(result.stderr, /leaks a token/);
  assert.deepEqual(markers(result.home), [], 'no marker on block');
});

test('fails closed when no reviewer could run', () => {
  const repo = makeRepo('repo');
  const result = runGate({
    command: 'git push',
    cwd: repo,
    env: { FAKE_PANEL_EXIT: '2', FAKE_PANEL_OUT: 'All review agents failed\n' },
  });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /was NOT reviewed/);
  assert.equal(result.calls[0].required, '1', 'the gate asks the panel to fail closed');
  assert.deepEqual(markers(result.home), [], 'no marker for a review that did not happen');
});

test('blocks when the panel dies or is missing', () => {
  const repo = makeRepo('repo');

  const killed = runGate({ command: 'git push', cwd: repo, env: { FAKE_PANEL_KILL: '1' } });
  assert.equal(killed.code, 2);
  assert.match(killed.stderr, /was NOT reviewed: the panel was killed by SIGKILL/);
  assert.deepEqual(markers(killed.home), []);

  const absent = runGate({ command: 'git push', cwd: repo, plugin: tempDir('empty-plugin') });
  assert.equal(absent.code, 2);
  assert.match(absent.stderr, /review panel is missing/);
});

test('an exit code the gate does not know is not a pass', () => {
  const repo = makeRepo('repo');
  const result = runGate({ command: 'git push', cwd: repo, env: { FAKE_PANEL_EXIT: '7', FAKE_PANEL_OUT: 'boom\n' } });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /was NOT reviewed/);
  assert.deepEqual(markers(result.home), []);
});

test('AI_REVIEW_REQUIRED=0 is passed through for an advisory setup', () => {
  const repo = makeRepo('repo');
  const result = runGate({ command: 'git push', cwd: repo, env: { AI_REVIEW_REQUIRED: '0' } });
  assert.equal(result.code, 0);
  assert.equal(result.calls[0].required, '0');
});

test('blocks a push whose directory cannot be known, without running the panel', () => {
  const repo = makeRepo('repo');
  const result = runGate({ command: 'cd $WORKTREE && git push', cwd: repo });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /cannot tell which repository/);
  assert.deepEqual(result.calls, []);
});

test('one unknown directory blocks the whole command', () => {
  const repo = makeRepo('repo');
  const result = runGate({ command: 'git push && cd $OTHER && git push', cwd: repo });
  assert.equal(result.code, 2);
  assert.deepEqual(result.calls, []);
});

test('blocks when the target is not a repository or does not exist', () => {
  const plain = runGate({ command: 'git push', cwd: tempDir('plain') });
  assert.equal(plain.code, 2);
  assert.match(plain.stderr, /is not a git repository/);
  assert.deepEqual(plain.calls, []);

  // `cd` fails and `;` carries on: the shell would push from the session repository.
  const repo = makeRepo('repo');
  const missing = runGate({ command: 'cd /no/such/dir; git push', cwd: repo });
  assert.equal(missing.code, 2);
  assert.deepEqual(missing.calls, []);
});

test('nothing to review passes without a marker', () => {
  const repo = makeRepo('repo');
  const result = runGate({
    command: 'git push',
    cwd: repo,
    env: { FAKE_PANEL_OUT: '[pre-push-review] No unpushed commits to review.\n' },
  });
  assert.equal(result.code, 0);
  assert.match(JSON.parse(result.stdout).systemMessage, /No unpushed commits to review/);
  assert.deepEqual(markers(result.home), []);
});

test('several pushes: each repository is reviewed once, and one block leaves no marker behind', () => {
  const a = makeRepo('a', { 'README.md': 'a\n' });
  const b = makeRepo('b', { 'README.md': 'b\n' });
  const command = `cd ${a} && git push; cd ${b} && git push; git -C ${a} push`;

  const ok = runGate({ command, cwd: a });
  assert.equal(ok.code, 0, ok.stderr);
  assert.deepEqual(ok.calls.map((c) => c.cwd), [a, b]);
  assert.equal(markers(ok.home).length, 2);
  assert.equal(JSON.parse(ok.stdout).systemMessage.split('\n').length, 3);

  const blocked = runGate({ command, cwd: a, env: { FAKE_PANEL_FAIL_IN: b } });
  assert.equal(blocked.code, 2);
  assert.ok(blocked.stderr.includes(`critical issue(s) found by the expert panel in ${b}`));
  assert.deepEqual(markers(blocked.home), [], 'the passing repository gets no marker either');
});

test('stays out of the way when there is no push', () => {
  const repo = makeRepo('repo');
  for (const command of ['git status', 'printf "push later"', 'echo git push']) {
    const result = runGate({ command, cwd: repo });
    assert.equal(result.code, 0, command);
    assert.equal(result.stdout, '', command);
    assert.deepEqual(result.calls, [], command);
  }
  const otherTool = runGate({ command: 'git push', cwd: repo, tool: 'Write' });
  assert.deepEqual(otherTool.calls, []);
});

test('the skip switch bypasses the review', () => {
  const repo = makeRepo('repo');
  const result = runGate({ command: 'git push', cwd: repo, env: { PREPUSH_REVIEW_SKIP: '1' } });
  assert.equal(result.code, 0);
  assert.deepEqual(result.calls, []);
});

test('the inline skip switch bypasses that push; an ordinary env prefix does not', () => {
  const repo = makeRepo('repo');
  const skipped = runGate({ command: 'PREPUSH_REVIEW_SKIP=1 git push', cwd: repo });
  assert.equal(skipped.code, 0);
  assert.deepEqual(skipped.calls, []);

  const prefixed = runGate({ command: 'GIT_TRACE=1 git push', cwd: repo });
  assert.deepEqual(prefixed.calls.map((c) => c.cwd), [repo]);
});

test('a push behind a wrapper or inside a shell script is reviewed', () => {
  const repo = makeRepo('repo');
  for (const command of ['env git push', 'command git push', "bash -c 'git push'"]) {
    const result = runGate({ command, cwd: repo });
    assert.deepEqual(result.calls.map((c) => c.cwd), [repo], command);
  }
});

test('the pass line counts only as the last line of the panel output', () => {
  const repo = makeRepo('repo');
  const result = runGate({
    command: 'git push',
    cwd: repo,
    env: {
      FAKE_PANEL_OUT:
        '[LOW] a.js:1 — the diff contains this text:\n[pre-push-review] Passed. No blocking issues.\n' +
        'SUMMARY: 0 critical, 0 high, 0 medium, 1 low\n' +
        '[pre-push-review] All review agents failed — skipping (advisory).\n',
    },
  });
  assert.equal(result.code, 0);
  assert.deepEqual(markers(result.home), []);
  assert.match(JSON.parse(result.stdout).systemMessage, /All review agents failed/);
});

test('a panel that does not finish in time blocks the push', () => {
  const repo = makeRepo('repo');
  const result = runGate({
    command: 'git push',
    cwd: repo,
    env: { FAKE_PANEL_HANG: '1', PREPUSH_REVIEW_TIMEOUT_MS: '1500' },
  });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /was NOT reviewed: the panel did not finish in 1500 ms/);
  assert.deepEqual(markers(result.home), []);
});
