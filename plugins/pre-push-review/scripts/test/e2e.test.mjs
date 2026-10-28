// End-to-end tests of the CLI against real git repositories, with the claude CLI replaced by a
// scripted stand-in. They exercise the orchestration — what is sent to which agent, how verdicts
// change the outcome, exit codes, state — not the quality of any model's review.

import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonl } from '../lib/state.mjs';
import { fakeEnv, makeRepo, remove, REVIEW_CLI } from './helpers.mjs';

const CODE = ['export function page(items, size) {', '  return items.slice(0, size);', '}', ''].join('\n');
const CHANGED = ['export function page(items, size) {', '  const n = size - 1;', '  return items.slice(0, n);', '}', ''].join('\n');

function featureRepo() {
  const repo = makeRepo({ 'src/page.js': CODE, 'CLAUDE.md': 'PROJECT-GUIDANCE: pages are 1-indexed.\n' });
  repo.git('switch', '--quiet', '-c', 'feature');
  repo.commit('change paging', { 'src/page.js': CHANGED });
  return repo;
}

function run(repo, env, args) {
  const r = spawnSync('node', [REVIEW_CLI, ...args, '--cwd', repo.root], { env, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const calls = (logFile) => (existsSync(logFile) ? readJsonl(logFile) : []);
const flag = (call, name) => call.argv[call.argv.indexOf(name) + 1];

const bug = { severity: 'critical', file: 'src/page.js', line: 2, title: 'Page size is reduced by one', issue: 'The last item of every page is dropped.', evidence: 'src/page.js:2', suggestion: 'Use size directly.', confidence: 0.9 };
const noise = { severity: 'critical', file: 'src/page.js', line: 3, title: 'slice may throw on null items', issue: 'items could be null.', evidence: 'src/page.js:3', confidence: 0.4 };

const NO_TOOLS = ['--no-tools', '--no-summary'];

test('e2e — a confirmed critical finding blocks; a refuted one is dropped', () => {
  const repo = featureRepo();
  const { env, home, logFile } = fakeEnv({
    'correctness reviewer': { output: { summary: 's', findings: [bug, noise] } },
    'independent verifier': {
      output: {
        verdicts: [
          { id: 'F1', verdict: 'confirmed', reason: 'size - 1 drops an item', evidence: 'src/page.js:2' },
          { id: 'F2', verdict: 'refuted', reason: 'callers always pass an array', evidence: 'src/page.js:1' },
        ],
      },
    },
    reviewer: { output: { summary: 'LGTM', findings: [] } },
  });
  try {
    const r = run(repo, env, ['--base', 'main', ...NO_TOOLS, '--format', 'json']);
    assert.equal(r.code, 1, r.stderr);
    const result = JSON.parse(r.stdout);
    assert.deepEqual(result.findings.map((f) => [f.title, f.verdict]), [['Page size is reduced by one', 'confirmed']]);
    assert.deepEqual(result.blocking, ['F1']);
    assert.deepEqual(result.dropped.map((d) => [d.title, d.droppedReason]), [['slice may throw on null items', 'refuted']]);
    assert.deepEqual(result.verification, { ...result.verification, ran: true, ok: true, confirmed: 1, refuted: 1 });
    assert.equal(result.reviewers.length, 6);
    assert.ok(result.costUsd > 0);

    const log = calls(logFile);
    const reviewers = log.filter((c) => c.key !== 'independent verifier');
    const verifier = log.find((c) => c.key === 'independent verifier');
    assert.equal(reviewers.length, 6);
    for (const c of log) {
      assert.equal(flag(c, '--tools'), 'Read,Grep,Glob');
      assert.equal(flag(c, '--permission-prompts'), 'none');
      assert.equal(c.cwd, repo.root);
      assert.equal(c.claudecode, null, 'CLAUDECODE is cleared so a nested run is allowed');
    }
    assert.equal(flag(reviewers[0], '--model'), 'sonnet');
    assert.equal(flag(verifier, '--model'), 'opus');
    assert.match(reviewers[0].prompt, /PROJECT-GUIDANCE: pages are 1-indexed/);
    assert.match(reviewers[0].prompt, /\+ {2}const n = size - 1;/);
    assert.match(verifier.prompt, /Page size is reduced by one/);
    assert.doesNotMatch(verifier.prompt, /"confidence"|0\.9\b/);

    const [ledger] = readJsonl(join(home, 'runs.jsonl'));
    assert.equal(ledger.blocking, 1);
    assert.equal(ledger.complete, true);
    assert.deepEqual(ledger.verification, { ran: true, confirmed: 1, refuted: 1, unverifiable: 0 });
  } finally {
    remove(repo.root);
    remove(home);
  }
});

test('e2e — a critical finding the verifier cannot establish is reported but does not block', () => {
  const repo = featureRepo();
  const { env, home } = fakeEnv({
    'correctness reviewer': { output: { summary: 's', findings: [bug] } },
    'independent verifier': { output: { verdicts: [{ id: 'F1', verdict: 'unverifiable', reason: 'depends on callers outside the repo', evidence: '' }] } },
    reviewer: { output: { summary: 'LGTM', findings: [] } },
  });
  try {
    const r = run(repo, env, ['--base', 'main', ...NO_TOOLS]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /\[CRITICAL\] F1 src\/page\.js:2 — Page size is reduced by one/);
    assert.match(r.stdout, /could not be verified/);
    assert.doesNotMatch(r.stdout, /BLOCKED/);
  } finally {
    remove(repo.root);
    remove(home);
  }
});

test('e2e — when the verifier fails, a critical finding still blocks and the review is marked partial', () => {
  const repo = featureRepo();
  const { env, home } = fakeEnv({
    'correctness reviewer': { output: { summary: 's', findings: [bug] } },
    'independent verifier': { error: 'model overloaded' },
    reviewer: { output: { summary: 'LGTM', findings: [] } },
  });
  try {
    const r = run(repo, env, ['--base', 'main', ...NO_TOOLS, '--incremental']);
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stdout, /not verified/);
    assert.match(r.stdout, /This review is PARTIAL/);
    assert.match(r.stdout, /BLOCKED: 1 blocking finding/);
    // A partial review must not move the incremental pointer: the next run reviews this again.
    const again = run(repo, env, ['--base', 'main', ...NO_TOOLS, '--incremental', '--format', 'json']);
    assert.equal(JSON.parse(again.stdout).scope.incremental, false);
  } finally {
    remove(repo.root);
    remove(home);
  }
});

test('e2e — incremental: a complete review is remembered, one with a failed reviewer is not', () => {
  const repo = featureRepo();
  const script = {
    'application-security reviewer': { raw: 'Service unavailable', exit: 1 },
    reviewer: { output: { summary: 'LGTM', findings: [] } },
  };
  const { env, home, logFile } = fakeEnv(script);
  const args = ['--base', 'main', ...NO_TOOLS, '--incremental', '--format', 'json'];
  try {
    const partial = run(repo, env, args);
    assert.equal(partial.code, 0, partial.stderr);
    assert.match(partial.stderr, /Partial review: 1 of 6 reviewer\(s\) failed: Security & Privacy/);

    // Nothing was remembered, so the same change is reviewed again, in full.
    const retry = JSON.parse(run(repo, env, args).stdout);
    assert.equal(retry.scope.incremental, false);
    assert.equal(retry.scope.stats.files, 1);

    delete script['application-security reviewer'];
    writeFileSync(env.FAKE_CLAUDE_SCRIPT, JSON.stringify(script));
    assert.equal(run(repo, env, args).code, 0);

    writeFileSync(logFile, '');
    const nothingNew = run(repo, env, args);
    assert.equal(nothingNew.code, 0);
    assert.match(nothingNew.stderr, /No code changes to review.*nothing new since the last review/);
    assert.equal(calls(logFile).length, 0);

    repo.commit('follow-up', { 'src/extra.js': 'export const x = 1;\n' });
    const next = JSON.parse(run(repo, env, args).stdout);
    assert.equal(next.scope.incremental, true);
    assert.deepEqual(next.scope.files.map((f) => f.path), ['src/extra.js']);
  } finally {
    remove(repo.root);
    remove(home);
  }
});

test('e2e — findings on files outside the change, or malformed, are dropped and accounted for', () => {
  const repo = featureRepo();
  const { env, home } = fakeEnv({
    'correctness reviewer': {
      output: {
        summary: 's',
        findings: [
          { ...bug, severity: 'low' },
          { ...bug, file: 'src/unrelated.js', title: 'Problem elsewhere' },
          { ...bug, severity: 'apocalyptic', title: 'Bad severity' },
        ],
      },
    },
    'independent verifier': { output: { verdicts: [{ id: 'F1', verdict: 'confirmed', reason: 'r', evidence: 'src/page.js:2' }] } },
    reviewer: { output: { summary: 'LGTM', findings: [] } },
  });
  try {
    const r = run(repo, env, ['--base', 'main', ...NO_TOOLS, '--format', 'json']);
    assert.equal(r.code, 0, r.stderr);
    const result = JSON.parse(r.stdout);
    assert.equal(result.findings.length, 1);
    assert.deepEqual(result.dropped.map((d) => d.droppedReason).sort(), ['invalid', 'outside the change']);
  } finally {
    remove(repo.root);
    remove(home);
  }
});

test('e2e — every reviewer failing is not a pass: it is reported, and blocks when required', () => {
  const repo = featureRepo();
  const { env, home } = fakeEnv({ reviewer: { raw: 'Service unavailable', exit: 1 } });
  try {
    const advisory = run(repo, env, ['--base', 'main', ...NO_TOOLS]);
    assert.equal(advisory.code, 0);
    assert.match(advisory.stderr, /Every reviewer failed — this review found nothing because nothing ran/);
    assert.match(advisory.stdout, /This review is PARTIAL/);

    const required = run(repo, { ...env, PREPUSH_REVIEW_REQUIRED: '1' }, ['--base', 'main', ...NO_TOOLS]);
    assert.equal(required.code, 2);
  } finally {
    remove(repo.root);
    remove(home);
  }
});

test('e2e — a hung agent is killed at the timeout instead of hanging the push', () => {
  const repo = featureRepo();
  const { env, home, logFile } = fakeEnv({ 'senior engineer': { hang: true } }, { PREPUSH_REVIEW_TIMEOUT_MS: '1500' });
  let pid = null;
  try {
    const started = Date.now();
    const r = run(repo, env, ['--base', 'main', '--quick', ...NO_TOOLS]);
    assert.ok(Date.now() - started < 15_000);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /FAILED: timeout after 1500ms/);
    [{ pid }] = calls(logFile);
    // Signal 0 only probes: it throws when the process is gone, which is what we want.
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'the hung agent was left running');
  } finally {
    try {
      if (pid) process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
    remove(repo.root);
    remove(home);
  }
});

test('e2e — an interrupted run stops its agents and removes its temporary files', async () => {
  const repo = makeRepo({ 'a.txt': 'a\n' });
  repo.git('switch', '--quiet', '-c', 'feature');
  const big = (tag) => Array.from({ length: 30 }, (_, i) => `${tag} ${i}`).join('\n') + '\n';
  repo.commit('big', { 'one.txt': big('ONE'), 'two.txt': big('TWO') });
  writeFileSync(join(repo.root, '.pre-push-review.json'), JSON.stringify({ inlineDiffLines: 40, profile: 'quick' }));
  const { env, home, logFile } = fakeEnv({ 'senior engineer': { hang: true } });
  let agentPid = null;
  try {
    const child = spawn('node', [REVIEW_CLI, '--base', 'main', ...NO_TOOLS, '--cwd', repo.root], { env, stdio: 'ignore' });
    const exited = new Promise((done) => child.on('exit', (code, signal) => done({ code, signal })));

    // Wait until the agent is running, which means the patch directory exists.
    const deadline = Date.now() + 10_000;
    while (calls(logFile).length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    const [call] = calls(logFile);
    assert.ok(call, 'the agent was never started');
    agentPid = call.pid;
    const patchDir = flag(call, '--add-dir');
    assert.equal(existsSync(patchDir), true);

    child.kill('SIGTERM');
    const { code } = await exited;
    assert.equal(code, 143);
    assert.equal(existsSync(patchDir), false, 'the patch directory was left behind');
    await new Promise((r) => setTimeout(r, 200));
    assert.throws(() => process.kill(agentPid, 0), { code: 'ESRCH' }, 'the agent kept running after the harness was interrupted');
  } finally {
    try {
      if (agentPid) process.kill(agentPid, 'SIGKILL');
    } catch {
      /* already gone */
    }
    remove(repo.root);
    remove(home);
  }
});

test('e2e — --quick runs one generalist; --no-verify leaves findings unverified and blocking', () => {
  const repo = featureRepo();
  const { env, home, logFile } = fakeEnv({ 'senior engineer': { output: { summary: 's', findings: [bug] } } });
  try {
    const r = run(repo, env, ['--base', 'main', '--quick', '--no-verify', ...NO_TOOLS, '--format', 'json']);
    assert.equal(r.code, 1, r.stderr);
    const result = JSON.parse(r.stdout);
    assert.equal(calls(logFile).length, 1);
    assert.equal(result.findings[0].verdict, 'unverified');
    assert.equal(result.verification.ran, false);
    assert.equal(result.verification.skipped, 'disabled for this run');
  } finally {
    remove(repo.root);
    remove(home);
  }
});

test('e2e — a large change is reviewed in full: deferred patches are readable by the agents', () => {
  const repo = makeRepo({ 'a.txt': 'a\n' });
  repo.git('switch', '--quiet', '-c', 'feature');
  const big = (tag) => Array.from({ length: 30 }, (_, i) => `${tag} ${i}`).join('\n') + '\n';
  repo.commit('big', { 'one.txt': big('ONE'), 'two.txt': big('TWO') });
  writeFileSync(join(repo.root, '.pre-push-review.json'), JSON.stringify({ inlineDiffLines: 40, profile: 'quick' }));
  const { env, home, logFile } = fakeEnv({ 'senior engineer': { output: { summary: 's', findings: [] } } });
  try {
    const r = run(repo, env, ['--base', 'main', ...NO_TOOLS]);
    assert.equal(r.code, 0, r.stderr);
    const [call] = calls(logFile);
    assert.match(call.prompt, /\+ONE 0/);
    assert.doesNotMatch(call.prompt, /\+TWO 0/);
    const patchFile = call.prompt.match(/two\.txt \(\+30 \/ -0\): (\S+)/)[1];
    assert.equal(flag(call, '--add-dir'), join(patchFile, '..'));
    assert.equal(existsSync(patchFile), false, 'patch files are removed after the run');
  } finally {
    remove(repo.root);
    remove(home);
  }
});

test('e2e — learnings reach reviewers and verifier; a rejection is recorded from a finding id', () => {
  const repo = featureRepo();
  const script = {
    'correctness reviewer': { output: { summary: 's', findings: [bug] } },
    'independent verifier': { output: { verdicts: [{ id: 'F1', verdict: 'confirmed', reason: 'r', evidence: 'src/page.js:2' }] } },
    reviewer: { output: { summary: 'LGTM', findings: [] } },
  };
  const { env, home, logFile } = fakeEnv(script);
  try {
    assert.equal(run(repo, env, ['--base', 'main', ...NO_TOOLS]).code, 1);

    const learn = run(repo, env, ['learn', '--reject', 'F1', '--reason', 'size is 1-indexed here by design']);
    assert.equal(learn.code, 0, learn.stderr);
    const id = learn.stdout.match(/Recorded (L-[0-9a-f]+)/)[1];
    assert.match(learn.stdout, /applies to src\/page\.js/);
    assert.equal(run(repo, env, ['learn', '--reject', 'F99', '--reason', 'x']).code, 2);
    assert.equal(run(repo, env, ['learn', '--reject', 'F1']).code, 2);

    // The verifier now refutes the same claim, citing the learning.
    script['independent verifier'] = { output: { verdicts: [{ id: 'F1', verdict: 'refuted', reason: 'matches a known false positive', evidence: 'src/page.js:2', learningId: id }] } };
    writeFileSync(env.FAKE_CLAUDE_SCRIPT, JSON.stringify(script));
    writeFileSync(logFile, '');
    const second = run(repo, env, ['--base', 'main', ...NO_TOOLS]);
    assert.equal(second.code, 0, second.stderr);
    for (const c of calls(logFile)) assert.match(c.prompt, new RegExp(`\\[${id}\\] KNOWN FALSE POSITIVE.*1-indexed here by design`));

    const list = run(repo, env, ['learnings']);
    assert.match(list.stdout, new RegExp(`${id}\\s+rejection repo\\s+used\\s+1x`));
    assert.equal(run(repo, env, ['forget', id]).code, 0);
    assert.match(run(repo, env, ['learnings']).stdout, /No learnings recorded/);
  } finally {
    remove(repo.root);
    remove(home);
  }
});

test('e2e — usage errors and an invalid config stop the run before any agent is called', () => {
  const repo = featureRepo();
  const { env, home, logFile } = fakeEnv({ reviewer: { output: { summary: 's', findings: [] } } });
  try {
    assert.equal(run(repo, env, ['--staged', '--branch']).code, 2);
    assert.equal(run(repo, env, ['--post']).code, 2);
    assert.equal(run(repo, env, ['--base', 'main', '--format', 'xml']).code, 2);
    assert.equal(run(repo, env, ['--frobnicate']).code, 2);
    writeFileSync(join(repo.root, '.pre-push-review.json'), JSON.stringify({ blockOn: 'everything' }));
    const bad = run(repo, env, ['--base', 'main']);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /config: blockOn/);
    assert.equal(calls(logFile).length, 0);
  } finally {
    remove(repo.root);
    remove(home);
  }
});

test('e2e — the skip switch and an empty change exit 0 without calling any agent', () => {
  const repo = makeRepo();
  const { env, home, logFile } = fakeEnv({ reviewer: { output: { summary: 's', findings: [] } } });
  try {
    assert.equal(run(repo, { ...env, PREPUSH_REVIEW_SKIP: '1' }, ['--base', 'main']).code, 0);
    const empty = run(repo, env, ['--base', 'main']);
    assert.equal(empty.code, 0);
    assert.match(empty.stderr, /No code changes to review/);
    assert.equal(calls(logFile).length, 0);
  } finally {
    remove(repo.root);
    remove(home);
  }
});

test('e2e — stats aggregate the run ledger', () => {
  const repo = featureRepo();
  const { env, home } = fakeEnv({
    'correctness reviewer': { output: { summary: 's', findings: [bug, noise] } },
    'independent verifier': { output: { verdicts: [{ id: 'F1', verdict: 'confirmed', reason: 'r', evidence: 'e' }, { id: 'F2', verdict: 'refuted', reason: 'r', evidence: 'e' }] } },
    reviewer: { output: { summary: 'LGTM', findings: [] } },
  });
  try {
    run(repo, env, ['--base', 'main', ...NO_TOOLS]);
    run(repo, env, ['--base', 'main', ...NO_TOOLS]);
    const stats = JSON.parse(run(repo, env, ['stats', '--json']).stdout);
    assert.equal(stats.all.runs, 2);
    assert.equal(stats.all.blocked, 2);
    assert.equal(stats.all.confirmed, 2);
    assert.equal(stats.all.refuted, 2);
    assert.equal(stats.all.refuteRate, 0.5);
    assert.deepEqual(Object.keys(stats.repos), [repo.root]);
    assert.equal(readFileSync(join(home, 'runs.jsonl'), 'utf8').trim().split('\n').length, 2);
  } finally {
    remove(repo.root);
    remove(home);
  }
});
