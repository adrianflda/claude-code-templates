/**
 * "Fit to the ticket" as a table over the whole branch, blocking on a confirmed contradiction.
 *
 * The fixture mirrors the case that motivated it: a ticket asking for a feature-flag framework the
 * business can use to switch features off, and a branch whose first push added a design that
 * refuses to switch some features off. The later pushes were small, so a per-push review never saw
 * the design again; the ticket reviewer now sees the whole branch on every push.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { aggregate, render } from '../scripts/stats.mjs';
import { SCRIPTS, executable, fakePlugin, git, installGate, makeRepo, runNode, tempDir, write } from './helpers.mjs';

const PANEL = join(SCRIPTS, 'ai-review-panel.mjs');
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'prodmgt-76.md');
const LGTM = '{"findings":[],"summary":"LGTM"}';
const TICKET_ROLE = 'checks a change against the ticket';

/** A `claude` stand-in: LGTM for every reviewer except the ticket one, which answers `rows`. */
function fakeClaude(rows, { summary = 'checked' } = {}) {
  const dir = tempDir('claude');
  const callCapture = join(dir, 'calls.jsonl');
  const bin = executable(
    join(dir, 'claude'),
    `#!/usr/bin/env node
const fs = require('node:fs');
let prompt = '';
process.stdin.on('data', (d) => { prompt += d; });
process.stdin.on('end', () => {
  const argv = process.argv.slice(2);
  const role = argv[argv.indexOf('--append-system-prompt') + 1];
  fs.appendFileSync(${JSON.stringify(callCapture)}, JSON.stringify({ role, prompt }) + '\\n');
  const reply = role.includes(${JSON.stringify(TICKET_ROLE)}) ? ${JSON.stringify(JSON.stringify({ rows, summary }))} : ${JSON.stringify(LGTM)};
  process.stdout.write(JSON.stringify({ type: 'result', is_error: false, total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5 }, result: reply }));
  process.exit(0);
});
`,
  );
  const calls = () => (existsSync(callCapture) ? readFileSync(callCapture, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  return { bin, calls, ticketCall: () => calls().find((c) => c.role.includes(TICKET_ROLE)), otherCalls: () => calls().filter((c) => !c.role.includes(TICKET_ROLE)) };
}

/** A `gh` stand-in answering `pr view` with `pr` and `issue view` from `issues`; everything else fails. */
function fakeGh({ issues = {}, pr = null } = {}) {
  const dir = tempDir('gh');
  const log = join(dir, 'gh.jsonl');
  executable(
    join(dir, 'gh'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const issues = ${JSON.stringify(issues)};
if (args[0] === 'issue' && args[1] === 'view') {
  const repo = args[args.indexOf('-R') + 1];
  const issue = issues[repo + '#' + args[2]];
  if (!issue) { process.stderr.write('GraphQL: Could not resolve to an issue\\n'); process.exit(1); }
  process.stdout.write(JSON.stringify(issue));
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'view' && ${JSON.stringify(pr)}) { process.stdout.write(JSON.stringify(${JSON.stringify(pr)})); process.exit(0); }
if (args[0] === 'pr' && args[1] === 'comment') {
  let body = '';
  process.stdin.on('data', (d) => { body += d; });
  process.stdin.on('end', () => { fs.writeFileSync(${JSON.stringify(join(dir, 'posted.md'))}, body); process.exit(0); });
} else process.exit(1);
`,
  );
  return {
    path: `${dir}:${process.env.PATH}`,
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []),
    posted: () => (existsSync(join(dir, 'posted.md')) ? readFileSync(join(dir, 'posted.md'), 'utf8') : ''),
  };
}

/**
 * `dev` plus `feat/76-feature-flags` with two commits: the design (locks that refuse to switch
 * safety features off) and a small follow-up. Returns the shas so a test can push only the second.
 */
function flagsRepo({ branch = 'feat/76-feature-flags', messages = ['feat(flags): environment-wide lock-off', 'docs: verification guide'] } = {}) {
  const repo = makeRepo('flags', { 'README.md': 'service\n' });
  git(repo, 'branch', '-m', 'main', 'dev');
  git(repo, 'checkout', '-q', '-b', branch);
  write(repo, { 'src/locks.js': 'export const SAFETY_KEYS = ["911", "crisis"];\nexport function refuseLock(key) { return SAFETY_KEYS.includes(key); }\n' });
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', messages[0]);
  const first = git(repo, 'rev-parse', 'HEAD');
  write(repo, { 'docs/verify.md': 'Check the lock on dev.\n' });
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', messages[1]);
  const second = git(repo, 'rev-parse', 'HEAD');
  return { repo, first, second };
}

const rowsIn = (home) => {
  const path = join(home, '.cache', 'git-ai-review', 'runs.jsonl');
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
};

/** Run the panel over the second commit only, as the pre-push runner would, with the saved ticket. */
function replay(rows, { env = {}, args = [] } = {}) {
  const { repo, first, second } = flagsRepo();
  const home = tempDir('home');
  const claude = fakeClaude(rows);
  const r = runNode(PANEL, {
    args: ['--range', first, second, '--ticket-file', FIXTURE, ...args],
    cwd: repo,
    env: { HOME: home, CLAUDE_BIN: claude.bin, ...env },
  });
  return { ...r, repo, claude, rows: rowsIn(home) };
}

const CONTRADICTED = {
  kind: 'criterion',
  // The quote differs from the ticket in case and markdown: the check must still find it.
  quote: 'Framework supports IMMEDIATE or near-real-time disabling/enabling of features per environment',
  status: 'contradicted',
  evidence: 'src/locks.js:2 refuses to switch 911 and crisis off, so the business cannot disable those features',
};
const ROWS = [
  { kind: 'criterion', quote: 'feature flagging system / framework chosen', status: 'met', evidence: 'src/locks.js:1 extends the own catalogue' },
  { kind: 'criterion', quote: 'CTO approves of the framework', status: 'missing', evidence: 'no approval in the diff' },
  CONTRADICTED,
  { kind: 'reason', quote: 'the application has to be a "non-medical" device', status: 'partial', evidence: 'src/locks.js:2 keeps some features always on' },
  { kind: 'extra', quote: '', status: 'unrequested', evidence: 'src/locks.js:1 safety keys can never be locked; no ticket line asks for it' },
];

test('offline replay: the design pushed earlier contradicts a ticket line, and a later small push is blocked', () => {
  const r = replay(ROWS);

  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /Ticket context: file .*prodmgt-76\.md\./);
  assert.match(r.stdout, /"Fit to the ticket" covers the whole branch: 2 commit\(s\) vs dev/);
  assert.match(r.stdout, /Fit to the ticket {12}5 row\(s\): 1 met, 1 partial, 1 missing, 1 contradicted, 1 unrequested/);
  assert.match(r.stdout, /\[CONTRADICTED\] criterion: "Framework supports IMMEDIATE or near-real-time disabling\/enabling of features per environment" — src\/locks\.js:2/);
  assert.match(r.stdout, /\[MISSING\] criterion: "CTO approves of the framework"/);
  assert.match(r.stdout, /\[UNREQUESTED\] extra: "" — src\/locks\.js:1 safety keys can never be locked/);
  assert.match(r.stdout, /SUMMARY: 0 critical, 0 high, 0 medium, 0 low · ticket: 1 contradicted \(1 confirmed\)/);
  assert.match(r.stdout, /BLOCKED: 1 ticket line\(s\) contradicted/);

  // The ticket reviewer sees the whole branch; the others see only the pushed commit.
  const ticketCall = r.claude.ticketCall();
  assert.match(ticketCall.prompt, /Check this git diff \(the whole branch: 2 commit\(s\) vs dev\) against the ticket below/);
  assert.match(ticketCall.prompt, /refuseLock/, 'the design from the first push is in the ticket prompt');
  assert.match(ticketCall.prompt, /Check the lock on dev/);
  assert.match(ticketCall.prompt, /### Ticket \(from .*prodmgt-76\.md\)\n# As PO, I would like the application to support feature flagging/);
  assert.equal(r.claude.otherCalls().length, 7);
  for (const other of r.claude.otherCalls()) {
    assert.doesNotMatch(other.prompt, /refuseLock/, 'the other reviewers see only the push');
    assert.doesNotMatch(other.prompt, /feature flagging/, 'the other reviewers do not get the ticket');
  }

  assert.equal(r.rows.length, 1);
  const row = r.rows[0];
  assert.equal(row.outcome, 'blocked');
  assert.equal(row.blocking, 1);
  assert.equal(row.ticket, 'found');
  assert.equal(row.ticketSource, 'file');
  assert.deepEqual(row.ticketFit, { base: 'dev', commits: 2, rows: { met: 1, partial: 1, missing: 1, contradicted: 1, unrequested: 1 }, confirmed: 1, noCriteria: false });
  assert.deepEqual(row.findings.ticket, { critical: 0, high: 1, medium: 2, low: 1 }, 'rows count by severity in the per-role totals');
  assert.deepEqual(row.counts, { critical: 0, high: 0, medium: 0, low: 0 }, 'rows are not findings');
});

test('a "contradicted" row whose quote is not in the ticket is shown as a warning and does not block', () => {
  const r = replay([{ ...CONTRADICTED, quote: 'features must never be locked for safety reasons' }]);

  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /\[CONTRADICTED\? \(quote not found in the ticket: not blocking\)\] criterion: "features must never be locked/);
  assert.match(r.stdout, /ticket: 1 contradicted \(0 confirmed\)/);
  assert.match(r.stdout, /Passed\. No blocking issues/);
  assert.equal(r.rows[0].ticketFit.confirmed, 0);
  assert.equal(r.rows[0].findings.ticket.high, 1, 'it still counts as a high for the role');
});

test('a short or empty quote never confirms a contradiction', () => {
  const r = replay([{ ...CONTRADICTED, quote: 'feature' }, { ...CONTRADICTED, quote: '' }]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /ticket: 2 contradicted \(0 confirmed\)/);
});

test('confirmed contradictions add to the severity blocks, and the message names both', () => {
  const dir = tempDir('claude');
  const critical = '{"findings":[{"severity":"critical","file":"src/locks.js","line":1,"issue":"broken","suggestion":"fix"}],"summary":"x"}';
  const rows = JSON.stringify({ rows: [CONTRADICTED], summary: 'x' });
  const bin = executable(
    join(dir, 'claude'),
    `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('end', () => {
  const argv = process.argv.slice(2);
  const role = argv[argv.indexOf('--append-system-prompt') + 1];
  const reply = role.includes(${JSON.stringify(TICKET_ROLE)}) ? ${JSON.stringify(rows)} : role.includes('correctness reviewer') ? ${JSON.stringify(critical)} : ${JSON.stringify(LGTM)};
  process.stdout.write(reply);
  process.exit(0);
});
`,
  );
  const { repo, first, second } = flagsRepo();
  const r = runNode(PANEL, { args: ['--range', first, second, '--ticket-file', FIXTURE], cwd: repo, env: { CLAUDE_BIN: bin } });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /BLOCKED: 1 critical\+ issue\(s\) found and 1 ticket line\(s\) contradicted/);
});

test('a ticket without acceptance criteria is said so, and the business reason is still checked', () => {
  const ticket = join(tempDir('ticket'), 'no-criteria.md');
  write(dirname(ticket), { 'no-criteria.md': 'Nurses asked for a faster reminder so that patients answer the call.\n' });
  const r = replay([{ kind: 'reason', quote: 'so that patients answer the call', status: 'met', evidence: 'docs/verify.md:1' }], {
    args: ['--ticket-file', ticket],
  });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Fit to the ticket \(the whole branch: 2 commit\(s\) vs dev\):\n {2}ticket has no acceptance criteria\n {2}\[MET\] reason:/);
  assert.equal(r.rows[0].ticketFit.noCriteria, true);
});

test('malformed rows are dropped; a reply with no rows reports none and passes', () => {
  const r = replay([null, 'text', { status: 'weird', quote: 'x' }, { kind: 'nonsense', status: 'MET', quote: 'CTO approves of the framework' }]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /1 row\(s\): 1 met/);
  assert.match(r.stdout, /\[MET\] extra: "CTO approves of the framework"/, 'an unknown kind becomes "extra", an upper-case status is read');

  const none = replay([]);
  assert.equal(none.code, 0, none.stdout + none.stderr);
  assert.match(none.stdout, /Fit to the ticket {12}0 row\(s\)\n/);
  assert.match(none.stdout, /No rows reported\./);
});

test('the ticket is found in the pushed branch\'s PR (named by AI_REVIEW_PUSH_REF), and the review starts at the PR base', () => {
  const { repo, first, second } = flagsRepo({ messages: ['feat: the design', 'docs: guide'] });
  git(repo, 'remote', 'add', 'origin', 'git@github.com:Acme/backend.git');
  // Another branch is checked out: the ref git is pushing must win over the checkout.
  git(repo, 'checkout', '-q', 'dev');
  const gh = fakeGh({
    pr: { number: 432, baseRefName: 'dev', title: 'Feature switches', body: 'Part of Acme/prodmgt#76 (feature flagging).' },
    issues: { 'Acme/prodmgt#76': { title: 'Support feature flagging', body: readFileSync(FIXTURE, 'utf8') } },
  });
  const claude = fakeClaude([CONTRADICTED]);
  const home = tempDir('home');
  const r = runNode(PANEL, {
    args: ['--range', first, second],
    cwd: repo,
    env: { HOME: home, CLAUDE_BIN: claude.bin, PATH: gh.path, AI_REVIEW_PUSH_REF: 'refs/heads/feat/76-feature-flags' },
  });

  assert.equal(r.code, 1, r.stdout + r.stderr);
  // The PR's base exists locally, so the default branch is never asked for (`gh repo view`).
  assert.deepEqual(gh.calls(), [
    ['pr', 'view', 'feat/76-feature-flags', '--json', 'number,baseRefName,title,body', '-R', 'Acme/backend'],
    ['issue', 'view', '76', '--json', 'title,body,url', '-R', 'Acme/prodmgt'],
  ]);
  assert.match(r.stdout, /Ticket context: PR description \+ issue\(s\) Acme\/prodmgt#76\./);
  assert.match(r.stdout, /"Fit to the ticket" covers the whole branch: 2 commit\(s\) vs dev/);
  assert.match(r.stdout, /BLOCKED: 1 ticket line\(s\) contradicted/);
  const ticketCall = claude.ticketCall();
  assert.match(ticketCall.prompt, /### Pull request description \(the author's account, not requirements\)\nFeature switches\n\nPart of Acme\/prodmgt#76/);
  assert.match(ticketCall.prompt, /### Issue Acme\/prodmgt#76: Support feature flagging/);
  assert.equal(rowsIn(home)[0].ticketSource, 'issues');
});

test('the issue number in the branch name is the last resort: used without references, ignored with them', () => {
  const noRefs = flagsRepo({ branch: 'feat/76-feature-flags', messages: ['feat: the design', 'docs: guide'] });
  git(noRefs.repo, 'remote', 'add', 'origin', 'https://github.com/Acme/backend.git');
  const issue = { title: 'Own issue 76', body: readFileSync(FIXTURE, 'utf8') };
  let gh = fakeGh({ issues: { 'Acme/backend#76': issue } });
  let claude = fakeClaude([]);
  let r = runNode(PANEL, { args: ['--range', noRefs.first, noRefs.second], cwd: noRefs.repo, env: { CLAUDE_BIN: claude.bin, PATH: gh.path } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Ticket context: issue\(s\) #76 \(from the branch name\)\./);
  assert.ok(gh.calls().some((a) => a.join(' ') === 'issue view 76 --json title,body,url -R Acme/backend'));
  assert.ok(claude.ticketCall(), 'the ticket reviewer ran');

  // The same branch name, but a commit names the real ticket: the branch number is not fetched.
  const withRef = flagsRepo({ branch: 'feat/76-feature-flags', messages: ['feat: the design (prodmgt#31)', 'docs: guide'] });
  git(withRef.repo, 'remote', 'add', 'origin', 'https://github.com/Acme/backend.git');
  gh = fakeGh({ issues: { 'Acme/backend#76': issue, 'Acme/prodmgt#31': issue } });
  claude = fakeClaude([]);
  r = runNode(PANEL, { args: ['--range', withRef.first, withRef.second], cwd: withRef.repo, env: { CLAUDE_BIN: claude.bin, PATH: gh.path } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Ticket context: issue\(s\) Acme\/prodmgt#31\./);
  assert.ok(!gh.calls().some((a) => a[2] === '76'), 'the branch number is not used when a reference exists');
  assert.ok(claude.ticketCall(), 'the ticket reviewer ran');
});

test('references are read from every commit of the branch, not only the pushed ones', () => {
  // The first commit (not in this push) names the ticket; the pushed one does not.
  const { repo, first, second } = flagsRepo({ branch: 'feature', messages: ['feat: the design (prodmgt#31)', 'docs: guide'] });
  git(repo, 'remote', 'add', 'origin', 'https://github.com/Acme/backend.git');
  const gh = fakeGh({ issues: { 'Acme/prodmgt#31': { title: 'T', body: 'Done when: x.' } } });
  const claude = fakeClaude([]);
  const r = runNode(PANEL, { args: ['--range', first, second], cwd: repo, env: { CLAUDE_BIN: claude.bin, PATH: gh.path } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Ticket context: issue\(s\) Acme\/prodmgt#31\./);
});

test('AI_REVIEW_ROLES runs only the named reviewers, and the run log says which were skipped', () => {
  const r = replay(ROWS, { env: { AI_REVIEW_ROLES: 'ticket' } });
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /with 1 expert agents/);
  assert.equal(r.claude.calls().length, 1);
  assert.deepEqual(r.rows[0].roles.run, ['ticket']);
  assert.equal(r.rows[0].roles.skipped.length, 7);

  const none = replay(ROWS, { env: { AI_REVIEW_ROLES: 'nope' } });
  assert.equal(none.code, 0);
  assert.match(none.stdout, /No reviewer selected \(AI_REVIEW_ROLES\)/);
  assert.equal(none.rows[0].outcome, 'nothing-to-review');
});

test('a --pr review posts the ticket table in the PR comment', () => {
  const { repo } = flagsRepo({ branch: 'feature', messages: ['feat: the design', 'docs: guide'] });
  git(repo, 'remote', 'add', 'origin', 'https://github.com/Acme/backend.git');
  const head = git(repo, 'rev-parse', 'HEAD');
  const gh = fakeGh({
    pr: { baseRefName: 'dev', headRefName: 'feature', headRefOid: head, title: 'Switches', body: 'Closes #5' },
    issues: { 'Acme/backend#5': { title: 'Flags', body: readFileSync(FIXTURE, 'utf8') } },
  });
  const claude = fakeClaude(ROWS);
  const r = runNode(PANEL, { args: ['--pr', '9'], cwd: repo, env: { CLAUDE_BIN: claude.bin, PATH: gh.path } });
  assert.equal(r.code, 1, r.stdout + r.stderr);
  const body = gh.posted();
  assert.match(body, /\| Fit to the ticket \| 5 row\(s\) \|/);
  assert.match(body, /### Fit to the ticket \(the whole branch: 2 commit\(s\) vs dev\)/);
  assert.match(body, /\| Status \| Kind \| Ticket line \| Evidence \|/);
  assert.match(body, /\| CONTRADICTED \| criterion \| Framework supports IMMEDIATE or near-real-time disabling\/enabling of features per environment \| src\/locks\.js:2/);
  assert.match(body, /\| UNREQUESTED \| extra \| — \| src\/locks\.js:1/);
  assert.match(body, /\*\*SUMMARY:\*\* 0 critical · 0 high · 0 medium · 0 low · ticket: 1 contradicted \(1 confirmed\)/);
});

test('--ticket-file makes no gh call, even with an origin and a PR', () => {
  const { repo, first, second } = flagsRepo();
  git(repo, 'remote', 'add', 'origin', 'https://github.com/Acme/backend.git');
  const gh = fakeGh({ pr: { number: 1, baseRefName: 'dev', title: 't', body: 'Closes #5' } });
  const claude = fakeClaude([]);
  const r = runNode(PANEL, { args: ['--range', first, second, '--ticket-file', FIXTURE], cwd: repo, env: { CLAUDE_BIN: claude.bin, PATH: gh.path } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(gh.calls(), []);
  assert.match(r.stdout, /covers the whole branch: 2 commit\(s\) vs dev/);
});

test('the default branch is asked from gh only when the PR did not settle the base', () => {
  const { repo, first, second } = flagsRepo({ messages: ['feat: the design', 'docs: guide'] });
  git(repo, 'remote', 'add', 'origin', 'https://github.com/Acme/backend.git');
  git(repo, 'branch', 'trunk', 'dev'); // the default branch has a name the panel would not guess
  git(repo, 'branch', '-D', 'dev');
  const dir = tempDir('gh');
  const log = join(dir, 'gh.jsonl');
  executable(
    join(dir, 'gh'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] === 'repo' && args[1] === 'view') { process.stdout.write('trunk\\n'); process.exit(0); }
process.exit(1);
`,
  );
  const claude = fakeClaude([]);
  const r = runNode(PANEL, { args: ['--range', first, second, '--ticket-file', FIXTURE, '--no-post'], cwd: repo, env: { CLAUDE_BIN: claude.bin, PATH: `${dir}:${process.env.PATH}` } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  // --ticket-file: no gh at all, so the branch cannot be told apart from the base and the push diff is used.
  assert.ok(!existsSync(log), 'gh was never called');
  assert.doesNotMatch(r.stdout, /covers the whole branch/);

  // Without --ticket-file (a gh-less ticket is then found nowhere), the default branch is asked and used.
  const claude2 = fakeClaude([]);
  const r2 = runNode(PANEL, { args: ['--range', first, second], cwd: repo, env: { CLAUDE_BIN: claude2.bin, PATH: `${dir}:${process.env.PATH}` } });
  assert.equal(r2.code, 0, r2.stdout + r2.stderr);
  const calls = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(calls.some((a) => a.join(' ') === 'repo view Acme/backend --json defaultBranchRef -q .defaultBranchRef.name'));
});

test('when the pushed head is the base itself, the ticket reviewer sees the push diff', () => {
  // Pushing `dev` itself: the only base candidate is the branch being pushed.
  const repo = makeRepo('trunk', { 'README.md': 'service\n' });
  git(repo, 'branch', '-m', 'main', 'dev');
  const first = git(repo, 'rev-parse', 'HEAD');
  write(repo, { 'src/a.js': 'export const a = 1;\n' });
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'feat: a');
  const second = git(repo, 'rev-parse', 'HEAD');
  const home = tempDir('home');
  const claude = fakeClaude([{ kind: 'criterion', quote: 'CTO approves of the framework', status: 'missing', evidence: 'nothing' }]);
  const r = runNode(PANEL, { args: ['--range', first, second, '--ticket-file', FIXTURE], cwd: repo, env: { HOME: home, CLAUDE_BIN: claude.bin } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /covers the whole branch/);
  assert.match(claude.ticketCall().prompt, /Check this git diff \(1 commit\(s\) being pushed\) against the ticket below/);
  assert.match(r.stdout, /Fit to the ticket \(1 commit\(s\) being pushed\):/);
  assert.deepEqual(rowsIn(home)[0].ticketFit, { base: '', commits: 0, rows: { met: 0, partial: 0, missing: 1, contradicted: 0, unrequested: 0 }, confirmed: 0, noCriteria: false });
});

test('a ticket reviewer that answers with findings, or fails, cannot block on a ticket line', () => {
  const dir = tempDir('claude');
  const findings = '{"findings":[{"severity":"medium","file":"src/locks.js","line":1,"issue":"old-style reply","suggestion":"x"}],"summary":"x"}';
  const bin = executable(
    join(dir, 'claude'),
    `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('end', () => {
  const argv = process.argv.slice(2);
  const role = argv[argv.indexOf('--append-system-prompt') + 1];
  if (!role.includes(${JSON.stringify(TICKET_ROLE)})) { process.stdout.write(${JSON.stringify(LGTM)}); process.exit(0); }
  if (process.env.TICKET_REPLY === 'garbage') { process.stdout.write('not json'); process.exit(1); }
  process.stdout.write(${JSON.stringify(findings)});
  process.exit(0);
});
`,
  );
  const { repo, first, second } = flagsRepo();
  const home = tempDir('home');
  const r = runNode(PANEL, { args: ['--range', first, second, '--ticket-file', FIXTURE], cwd: repo, env: { HOME: home, CLAUDE_BIN: bin } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /\[MEDIUM\] src\/locks\.js:1 — old-style reply\n\s+↳ x {3}\(Fit to the ticket\)/, 'findings are handled as ordinary findings');
  assert.match(r.stdout, /SUMMARY: 0 critical, 0 high, 1 medium, 0 low\n/, 'no ticket summary without rows');
  assert.equal(rowsIn(home)[0].ticketFit, null);

  const home2 = tempDir('home');
  const failed = runNode(PANEL, { args: ['--range', first, second, '--ticket-file', FIXTURE], cwd: repo, env: { HOME: home2, CLAUDE_BIN: bin, TICKET_REPLY: 'garbage' } });
  assert.equal(failed.code, 0, failed.stdout + failed.stderr);
  assert.match(failed.stdout, /Fit to the ticket {12}FAILED:/);
  assert.deepEqual(rowsIn(home2)[0].roles.failed, ['ticket']);
  assert.equal(rowsIn(home2)[0].ticketFit, null);
});

test('--ticket-file that does not exist is an error', () => {
  const { repo, first, second } = flagsRepo();
  const r = runNode(PANEL, { args: ['--range', first, second, '--ticket-file', join(repo, 'missing.md')], cwd: repo });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--ticket-file: cannot read/);
});

test('real git push: the runner tells the panel which ref is pushed', () => {
  const plugin = fakePlugin({ realPanel: false });
  const home = installGate(plugin);
  const remote = tempDir('remote');
  git(remote, 'init', '-q', '--bare', '-b', 'main');
  const repo = makeRepo('work', { 'a.js': 'export const a = 1;\n' });
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'checkout', '-q', '-b', 'feat/76-flags');
  const log = join(home, 'panel-calls.jsonl');
  const push = spawnSync('git', ['push', 'origin', 'feat/76-flags'], { cwd: repo, encoding: 'utf8', env: { ...process.env, HOME: home, FAKE_PANEL_LOG: log } });
  assert.equal(push.status, 0, push.stderr);
  const calls = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pushRef, 'refs/heads/feat/76-flags');
  assert.equal(calls[0].args[0], '--range');
});

test('stats sums the ticket tables', () => {
  const ts = new Date().toISOString();
  const rows = [
    { v: 1, ts, outcome: 'blocked', roles: { run: ['ticket'] }, ticketFit: { base: 'dev', commits: 2, rows: { met: 1, partial: 0, missing: 0, contradicted: 2, unrequested: 0 }, confirmed: 1, noCriteria: false } },
    { v: 1, ts, outcome: 'passed', roles: { run: ['ticket'] }, ticketFit: { base: 'main', commits: 1, rows: { met: 0, partial: 0, missing: 0, contradicted: 0, unrequested: 1 }, confirmed: 0, noCriteria: true } },
    { v: 1, ts, outcome: 'passed', roles: { run: ['security'] }, ticketFit: null },
  ];
  const a = aggregate(rows);
  assert.deepEqual(a.ticketFit, { runs: 2, contradicted: 2, confirmed: 1, noCriteria: 1 });
  assert.match(render(7, a), /ticket {4}2 table\(s\) · 2 contradicted line\(s\), 1 confirmed · 1 ticket\(s\) without acceptance criteria/);
  assert.doesNotMatch(render(7, aggregate([rows[2]])), /table\(s\)/, 'no line when the ticket reviewer never ran');
});
