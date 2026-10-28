import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fingerprint } from '../lib/findings.mjs';
import { anchorFor, findingMarker, parseExistingComments, planReview } from '../lib/github.mjs';
import { addLearning, learningsPath, loadLearnings, loadUsage, recordUsage, relevantLearnings, removeLearning, renderLearnings, REPO_LEARNINGS } from '../lib/learnings.mjs';
import { completeness, fixPrompt, renderMarkdown, renderNdjson, renderText, SUMMARY_MARKER } from '../lib/report.mjs';
import { makeRepo, remove, tempDir } from './helpers.mjs';

// --- learnings --------------------------------------------------------------------------------

function sandbox() {
  const repo = makeRepo();
  const home = tempDir('ppr-home-');
  return { repo, env: { PREPUSH_REVIEW_HOME: home }, done: () => { remove(repo.root); remove(home); } };
}

test('learnings — repo scope is a committed file, user scope stays out of the repo', () => {
  const { repo, env, done } = sandbox();
  try {
    const a = addLearning({ root: repo.root, scope: 'repo', kind: 'rule', text: 'Money is stored in cents.', paths: ['src/billing/**'] }, env);
    const b = addLearning({ root: repo.root, scope: 'user', kind: 'rejection', text: 'Not a real issue.' }, env);
    assert.match(a.id, /^L-[0-9a-f]{6,}$/);
    assert.notEqual(a.id, b.id);
    assert.equal(learningsPath('repo', repo.root, env), join(repo.root, REPO_LEARNINGS));
    assert.equal(repo.git('status', '--porcelain'), '?? .pre-push-review/');

    const all = loadLearnings(repo.root, env);
    assert.deepEqual(all.map((l) => [l.id, l.scope, l.kind]), [[a.id, 'repo', 'rule'], [b.id, 'user', 'rejection']]);
  } finally {
    done();
  }
});

test('learnings — invalid input is refused; corrupt rows are skipped without losing the rest', () => {
  const { repo, env, done } = sandbox();
  try {
    assert.throws(() => addLearning({ root: repo.root, kind: 'rule', text: '   ' }, env), /non-empty/);
    assert.throws(() => addLearning({ root: repo.root, kind: 'opinion', text: 'x' }, env), /kind/);
    assert.throws(() => addLearning({ root: repo.root, scope: 'world', kind: 'rule', text: 'x' }, env), /scope/);
    assert.throws(() => addLearning({ root: repo.root, kind: 'rule', text: 'x', paths: 'src/**' }, env), /paths/);

    const good = addLearning({ root: repo.root, kind: 'rule', text: 'Keep it.' }, env);
    const path = learningsPath('repo', repo.root, env);
    writeFileSync(path, `${readFileSync(path, 'utf8')}{ truncated\n{"id":"L-x","kind":"rule"}\n`);
    assert.deepEqual(loadLearnings(repo.root, env).map((l) => l.id), [good.id]);
  } finally {
    done();
  }
});

test('learnings — relevance follows path globs; unrestricted learnings always apply', () => {
  const learnings = [
    { id: 'L-1', kind: 'rule', text: 'a', paths: [] },
    { id: 'L-2', kind: 'rule', text: 'b', paths: ['src/db/**'] },
    { id: 'L-3', kind: 'rejection', text: 'c', paths: ['*.css'] },
  ];
  assert.deepEqual(relevantLearnings(learnings, ['src/db/001.sql']).map((l) => l.id), ['L-1', 'L-2']);
  assert.deepEqual(relevantLearnings(learnings, []).map((l) => l.id), ['L-1']);
  const text = renderLearnings(learnings);
  assert.match(text, /\[L-2\] RULE \(applies to src\/db\/\*\*\): b/);
  assert.match(text, /\[L-3\] KNOWN FALSE POSITIVE/);
});

test('learnings — removal and usage counts', () => {
  const { repo, env, done } = sandbox();
  try {
    const a = addLearning({ root: repo.root, kind: 'rule', text: 'one' }, env);
    const b = addLearning({ root: repo.root, kind: 'rule', text: 'two' }, env);
    recordUsage([a.id, a.id, null, ''], env);
    recordUsage([a.id, b.id], env);
    const usage = loadUsage(env);
    assert.equal(usage[a.id].count, 2, 'one application per review, however often it is cited');
    assert.equal(usage[b.id].count, 1);
    assert.equal(repo.git('status', '--porcelain'), '?? .pre-push-review/', 'usage is not written into the repo');

    assert.equal(removeLearning(repo.root, a.id, env).id, a.id);
    assert.equal(removeLearning(repo.root, 'L-nope', env), null);
    assert.deepEqual(loadLearnings(repo.root, env).map((l) => l.id), [b.id]);
  } finally {
    done();
  }
});

// --- report and GitHub plan -------------------------------------------------------------------

function file(path, hunks) {
  const all = hunks.flat();
  return {
    path,
    commentableLines: new Set(all),
    addedLines: new Set(all),
    hunks: hunks.map((ls) => ({ lines: ls.map((n) => ({ type: 'add', newLine: n })) })),
  };
}

function finding(over) {
  const f = { id: 'F1', severity: 'high', category: 'correctness', source: 'reviewer', reportedBy: ['Correctness & Logic'], file: 'src/a.ts', line: 10, endLine: null, title: 'Off by one in pagination', issue: 'The last page is skipped.', suggestion: 'Use <= instead of <.', replacement: null, verdict: 'confirmed', verification: { reason: 'Loop bound excludes the final index.', evidence: 'src/a.ts:10' }, ...over };
  return { ...f, fingerprint: fingerprint(f) };
}

function result(findings, over = {}) {
  return {
    scope: { description: 'pull request #7', headSha: 'abcdef1234567890', baseSha: '1234567890abcdef', headKind: 'commit', incremental: false, notes: [], excluded: [], stats: { files: 2, additions: 12, deletions: 3 }, pr: { number: 7, repo: 'o/r', url: 'https://github.com/o/r/pull/7', headSha: 'abcdef1234567890' }, files: [] },
    summary: { text: 'Adds pagination.', effort: 2, risks: ['Boundary handling'], walkthrough: [{ file: 'src/a.ts', change: 'Adds a | pipe' }] },
    tools: [{ name: 'gitleaks', status: 'ok', findings: 0 }],
    reviewers: [{ role: 'correctness', title: 'Correctness & Logic', ok: true, findings: findings.length }],
    verification: { ran: true, ok: true, skipped: null, confirmed: findings.length, refuted: 1, unverifiable: 0, unverified: 0, failedBatches: 0, batches: 1 },
    findings,
    dropped: [{ droppedReason: 'refuted' }],
    counts: { critical: 0, high: findings.length, medium: 0, low: 0 },
    blocking: [],
    costUsd: 0.4,
    durationMs: 61_000,
    ...over,
  };
}

const anchors = new Map([['src/a.ts', file('src/a.ts', [[8, 9, 10, 11, 12], [40, 41]])]]);

test('anchorFor — only lines GitHub can anchor; ranges must stay inside one hunk', () => {
  assert.deepEqual(anchorFor(finding({}), anchors), { start: 10, end: 10, exactRange: true });
  assert.deepEqual(anchorFor(finding({ line: 9, endLine: 12 }), anchors), { start: 9, end: 12, exactRange: true });
  assert.deepEqual(anchorFor(finding({ line: 12, endLine: 40 }), anchors), { start: 12, end: 12, exactRange: false });
  assert.equal(anchorFor(finding({ line: 25 }), anchors), null);
  assert.equal(anchorFor(finding({ line: null }), anchors), null);
  assert.equal(anchorFor(finding({ file: 'src/other.ts' }), anchors), null);
});

test('planReview — inline where anchorable, summary for the rest', () => {
  const inline = finding({ id: 'F1', line: 9, endLine: 11, replacement: 'for (let i = 0; i <= n; i++) {' });
  const loose = finding({ id: 'F2', line: 300, title: 'Missing test for empty list' });
  const plan = planReview(result([inline, loose]), anchors);

  assert.equal(plan.comments.length, 1);
  const [c] = plan.comments;
  assert.deepEqual([c.path, c.start_line, c.line, c.side, c.start_side], ['src/a.ts', 9, 11, 'RIGHT', 'RIGHT']);
  assert.match(c.body, /```suggestion\nfor \(let i = 0; i <= n; i\+\+\) \{\n```/);
  assert.ok(c.body.includes(findingMarker(inline)));
  assert.deepEqual([...plan.inlineIds], ['F1']);

  assert.ok(plan.body.startsWith(SUMMARY_MARKER));
  assert.match(plan.body, /Missing test for empty list/);
  assert.doesNotMatch(plan.body, /Off by one in pagination/, 'an inline finding is not repeated in the summary');
  assert.match(plan.body, /1 finding\(s\) are posted as inline comments/);
});

test('planReview — a replacement is never offered as a suggestion for a range it was not written for', () => {
  const f = finding({ line: 12, endLine: 40, replacement: 'new code' });
  const [c] = planReview(result([f]), anchors).comments;
  assert.equal(c.line, 12);
  assert.equal(c.start_line, undefined);
  assert.doesNotMatch(c.body, /```suggestion/);
});

test('planReview — findings already posted by an earlier run are not posted again', () => {
  const f = finding({});
  const moved = finding({ id: 'F2', line: 41, title: 'Entirely different wording now', category: 'security' });
  const existing = parseExistingComments([
    { body: `text\n\n${findingMarker(f)}`, path: 'src/a.ts', line: 10 },
    { body: 'a human comment', path: 'src/a.ts', line: 41 },
    { body: `x ${findingMarker({ fingerprint: 'ffff0000ffff0000', category: 'security' })}`, path: 'src/a.ts', line: 40 },
  ]);
  assert.equal(existing.length, 2);
  const plan = planReview(result([f, moved]), anchors, existing);
  assert.equal(plan.comments.length, 0);
  assert.deepEqual(plan.skipped.sort(), ['F1', 'F2']);
});

test('report — a partial review says so in every human format', () => {
  const partial = result([finding({})], {
    reviewers: [
      { role: 'correctness', title: 'Correctness & Logic', ok: true, findings: 1 },
      { role: 'security', title: 'Security & Privacy', ok: false, error: 'timeout after 1000ms', findings: 0 },
    ],
    verification: { ran: true, ok: false, skipped: null, confirmed: 0, refuted: 0, unverifiable: 0, unverified: 1, failedBatches: 1, batches: 1 },
    tools: [{ name: 'typecheck', status: 'timeout', reason: 'timed out after 5ms', findings: 0 }],
  });
  const gaps = completeness(partial);
  assert.equal(gaps.length, 3);
  assert.match(renderText(partial), /This review is PARTIAL/);
  assert.match(renderText(partial), /Security & Privacy\s+FAILED: timeout/);
  assert.match(renderMarkdown(partial), /\*\*This review is partial\.\*\*/);
  assert.deepEqual(completeness(result([finding({})])), []);
});

test('report — table cells cannot be broken by pipes or newlines in model text', () => {
  const md = renderMarkdown(result([]));
  assert.match(md, /\| `src\/a\.ts` \| Adds a \\\| pipe \|/);
  assert.match(md, /No findings\./);
});

test('report — ndjson is one JSON value per line and tells the agent how far to trust a finding', () => {
  const rows = renderNdjson(result([finding({}), finding({ id: 'F2', verdict: 'unverifiable', title: 'Maybe a race' })], { blocking: ['F1'] }))
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((r) => r.type), ['review', 'finding', 'finding', 'complete']);
  assert.equal(rows[1].blocking, true);
  assert.match(rows[1].fixPrompt, /was verified/);
  assert.match(rows[2].fixPrompt, /NOT verified\. Read the code first/);
  assert.equal(rows[3].partial, false);
  assert.match(fixPrompt(finding({ replacement: 'x = 1' })), /Proposed replacement/);
});
