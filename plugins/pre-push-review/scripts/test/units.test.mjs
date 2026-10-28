import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildArgs, parseEnvelope } from '../lib/agent.mjs';
import { CONFIG_FILE, DEFAULTS, loadConfig } from '../lib/config.mjs';
import { coerceSeverity, dedupe, isBlocking, normalizeFinding, rank, similarity } from '../lib/findings.mjs';
import { matchesAny, matchesGlob } from '../lib/glob.mjs';
import { collectGuidelines, relevantPathInstructions } from '../lib/guidelines.mjs';
import { planDiff } from '../lib/reviewers.mjs';
import { applyVerdicts, buildVerifierPrompt } from '../lib/verify.mjs';
import { diffFile, remove, tempDir, write } from './helpers.mjs';

// --- glob -------------------------------------------------------------------------------------

test('glob — a pattern without a slash matches the basename at any depth', () => {
  assert.equal(matchesGlob('yarn.lock', '*.lock'), true);
  assert.equal(matchesGlob('a/b/yarn.lock', '*.lock'), true);
  assert.equal(matchesGlob('a/lock.js', '*.lock'), false);
});

test('glob — ** crosses directories, * does not', () => {
  assert.equal(matchesGlob('src/db/x/y.ts', 'src/db/**'), true);
  assert.equal(matchesGlob('src/dbx/y.ts', 'src/db/**'), false);
  assert.equal(matchesGlob('src/a.ts', 'src/*.ts'), true);
  assert.equal(matchesGlob('src/x/a.ts', 'src/*.ts'), false);
  assert.equal(matchesGlob('src/x/a.test.ts', 'src/**/*.test.ts'), true);
  assert.equal(matchesGlob('src/a.test.ts', 'src/**/*.test.ts'), true);
  assert.equal(matchesGlob('pkg/__snapshots__/a.snap', '**/__snapshots__/**'), true);
});

test('glob — regex metacharacters in a pattern are literal', () => {
  assert.equal(matchesGlob('a+b(1).ts', 'a+b(1).ts'), true);
  assert.equal(matchesGlob('aab1.ts', 'a+b(1).ts'), false);
  assert.equal(matchesGlob('dist/x.js', 'dist/'), true);
});

test('glob — empty or invalid patterns match nothing', () => {
  assert.equal(matchesGlob('a.ts', ''), false);
  assert.equal(matchesAny('a.ts', null), false);
  assert.equal(matchesAny('a.ts', ['b.ts', '*.ts']), true);
});

// --- config -----------------------------------------------------------------------------------

test('config — defaults are valid', () => {
  const { config, errors, source } = loadConfig(null, {});
  assert.deepEqual(errors, []);
  assert.equal(source, 'defaults');
  assert.equal(config.blockOn, 'critical');
});

test('config — repo file overrides defaults, nested keys merge', () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, CONFIG_FILE), JSON.stringify({ blockOn: 'high', models: { verifier: 'sonnet' }, tools: { gitleaks: false } }));
    const { config, errors, source } = loadConfig(dir, {});
    assert.deepEqual(errors, []);
    assert.equal(source, CONFIG_FILE);
    assert.equal(config.blockOn, 'high');
    assert.equal(config.models.verifier, 'sonnet');
    assert.equal(config.models.reviewer, DEFAULTS.models.reviewer);
    assert.equal(config.tools.gitleaks, false);
    assert.equal(config.tools.autoDetect, true);
  } finally {
    remove(dir);
  }
});

test('config — invalid values are reported, not coerced', () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, CONFIG_FILE), JSON.stringify({ blockOn: 'medium', roles: ['security', 'vibes'], concurrency: 0, typo: true, tools: { commands: [{ name: 'x' }] } }));
    const { errors } = loadConfig(dir, {});
    const all = errors.join('\n');
    assert.match(all, /blockOn/);
    assert.match(all, /unknown role\(s\): vibes/);
    assert.match(all, /concurrency/);
    assert.match(all, /unknown key "typo"/);
    assert.match(all, /tools\.commands\[0\]/);
  } finally {
    remove(dir);
  }
});

test('config — malformed JSON is an error, and defaults still load', () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, CONFIG_FILE), '{ not json');
    const { config, errors } = loadConfig(dir, {});
    assert.equal(errors.length, 1);
    assert.match(errors[0], /not valid JSON/);
    assert.equal(config.profile, 'full');
  } finally {
    remove(dir);
  }
});

test('config — environment overrides win, and the v1 AI_REVIEW_* names still work', () => {
  const a = loadConfig(null, { AI_REVIEW_MODEL: 'haiku', AI_REVIEW_BLOCK_ON: 'HIGH' });
  assert.deepEqual(a.errors, []);
  assert.equal(a.config.models.reviewer, 'haiku');
  assert.equal(a.config.blockOn, 'high');
  const b = loadConfig(null, { AI_REVIEW_MODEL: 'haiku', PREPUSH_REVIEW_MODEL: 'opus' });
  assert.equal(b.config.models.reviewer, 'opus');
  const c = loadConfig(null, { PREPUSH_REVIEW_TIMEOUT_MS: 'soon' });
  assert.match(c.errors.join('\n'), /timeoutMs/);
});

// --- findings ---------------------------------------------------------------------------------

const byPath = new Map([['src/a.ts', diffFile('src/a.ts', { added: [10, 11, 12], context: [8, 9, 13] })]]);
const reviewer = { kind: 'reviewer', name: 'Correctness & Logic', category: 'correctness' };
const raw = (over = {}) => ({ severity: 'high', file: 'src/a.ts', line: 10, title: 'Null dereference on user', issue: 'user may be null', evidence: 'src/a.ts:10', confidence: 0.8, ...over });

test('findings — a valid finding is anchored to the diff', () => {
  const { finding } = normalizeFinding(raw(), reviewer, byPath);
  assert.equal(finding.inDiff, true);
  assert.equal(finding.lineInDiff, true);
  assert.equal(finding.lineAdded, true);
  assert.equal(finding.verdict, 'unverified');
  assert.deepEqual(finding.reportedBy, ['Correctness & Logic']);
});

test('findings — diff prefixes and ./ are stripped from paths', () => {
  assert.equal(normalizeFinding(raw({ file: 'b/src/a.ts' }), reviewer, byPath).finding.file, 'src/a.ts');
  assert.equal(normalizeFinding(raw({ file: './src/a.ts' }), reviewer, byPath).finding.inDiff, true);
});

test('findings — a file outside the change is kept but flagged, never re-anchored', () => {
  const { finding } = normalizeFinding(raw({ file: 'src/other.ts' }), reviewer, byPath);
  assert.equal(finding.inDiff, false);
  assert.equal(finding.lineInDiff, false);
});

test('findings — a line outside the diff is flagged as not commentable', () => {
  const { finding } = normalizeFinding(raw({ line: 400 }), reviewer, byPath);
  assert.equal(finding.inDiff, true);
  assert.equal(finding.lineInDiff, false);
});

test('findings — malformed model output is rejected with a reason', () => {
  assert.match(normalizeFinding(null, reviewer, byPath).rejected, /not an object/);
  assert.match(normalizeFinding(raw({ severity: 'catastrophic' }), reviewer, byPath).rejected, /severity/);
  assert.match(normalizeFinding(raw({ file: '' }), reviewer, byPath).rejected, /no file/);
  assert.match(normalizeFinding(raw({ title: '', issue: '' }), reviewer, byPath).rejected, /no description/);
});

test('findings — out-of-range values are clamped or discarded', () => {
  const { finding } = normalizeFinding(raw({ confidence: 7, line: '12', endLine: 3, replacement: '' }), reviewer, byPath);
  assert.equal(finding.confidence, 1);
  assert.equal(finding.line, 12);
  assert.equal(finding.endLine, null);
  assert.equal(finding.replacement, null);
  assert.equal(normalizeFinding(raw({ line: -4 }), reviewer, byPath).finding.line, null);
});

test('findings — severity aliases map onto the four levels', () => {
  assert.equal(coerceSeverity('Major'), 'high');
  assert.equal(coerceSeverity('warning'), 'medium');
  assert.equal(coerceSeverity(' CRITICAL '), 'critical');
  assert.equal(coerceSeverity('whatever'), null);
});

test('findings — tool findings are deterministic and never sent to verification', () => {
  const { finding } = normalizeFinding(raw({ rule: 'TS2322' }), { kind: 'tool', name: 'typecheck', category: 'typecheck' }, byPath);
  assert.equal(finding.verdict, 'deterministic');
  assert.equal(finding.source, 'tool');
});

test('dedupe — two reviewers on the same issue merge, the most severe wording wins', () => {
  const a = normalizeFinding(raw({ severity: 'medium' }), reviewer, byPath).finding;
  const b = normalizeFinding(raw({ severity: 'critical', line: 11, title: 'Null dereference of user object' }), { kind: 'reviewer', name: 'Error Handling & Reliability', category: 'reliability' }, byPath).finding;
  const merged = dedupe([a, b]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].severity, 'critical');
  assert.deepEqual(merged[0].reportedBy.sort(), ['Correctness & Logic', 'Error Handling & Reliability']);
});

test('dedupe — different issues on nearby lines stay separate', () => {
  const a = normalizeFinding(raw(), reviewer, byPath).finding;
  const b = normalizeFinding(raw({ line: 11, title: 'SQL built by string concatenation' }), { kind: 'reviewer', name: 'Security & Privacy', category: 'security' }, byPath).finding;
  assert.equal(dedupe([a, b]).length, 2);
  const far = normalizeFinding(raw({ line: 13 }), reviewer, byPath).finding;
  assert.equal(dedupe([a, far]).length, 2);
});

test('dedupe — one reviewer listing two things on adjacent lines means two things', () => {
  const a = normalizeFinding(raw({ line: 10, title: 'Page size is reduced by one' }), reviewer, byPath).finding;
  const b = normalizeFinding(raw({ line: 11, title: 'slice may throw on null items' }), reviewer, byPath).finding;
  const c = normalizeFinding(raw({ line: 10, title: 'Result is not memoized' }), reviewer, byPath).finding;
  assert.equal(dedupe([a, b, c]).length, 3);
});

test('dedupe — different reviewers on the same line merge, and the other wording is kept', () => {
  const a = normalizeFinding(raw({ severity: 'high', title: 'Query built by string concatenation' }), { kind: 'reviewer', name: 'Security & Privacy', category: 'security' }, byPath).finding;
  const b = normalizeFinding(raw({ severity: 'medium', title: 'Runs once per row inside the loop' }), { kind: 'reviewer', name: 'Performance & Scale', category: 'performance' }, byPath).finding;
  const [merged, ...rest] = dedupe([b, a]);
  assert.equal(rest.length, 0);
  assert.equal(merged.title, 'Query built by string concatenation');
  assert.equal(merged.category, 'security');
  assert.deepEqual(merged.alsoReported, [{ by: 'Performance & Scale', severity: 'medium', title: 'Runs once per row inside the loop' }]);
});

test('similarity — ignores digits and punctuation', () => {
  assert.equal(similarity('Null dereference on user', 'null dereference on user!'), 1);
  assert.equal(similarity('abc', ''), 0);
});

test('isBlocking — refuted and unverifiable findings never block; unverified ones do', () => {
  const f = (severity, verdict) => ({ severity, verdict });
  assert.equal(isBlocking(f('critical', 'confirmed'), 'critical'), true);
  assert.equal(isBlocking(f('critical', 'deterministic'), 'critical'), true);
  assert.equal(isBlocking(f('critical', 'unverified'), 'critical'), true);
  assert.equal(isBlocking(f('critical', 'unverifiable'), 'critical'), false);
  assert.equal(isBlocking(f('critical', 'refuted'), 'critical'), false);
  assert.equal(isBlocking(f('high', 'confirmed'), 'critical'), false);
  assert.equal(isBlocking(f('high', 'confirmed'), 'high'), true);
  assert.equal(isBlocking(f('medium', 'confirmed'), 'high'), false);
});

test('rank — severity first, then how well established the finding is', () => {
  const ordered = rank([
    { id: 'a', severity: 'low', verdict: 'confirmed', file: 'a', line: 1 },
    { id: 'b', severity: 'critical', verdict: 'unverifiable', file: 'a', line: 1 },
    { id: 'c', severity: 'critical', verdict: 'confirmed', file: 'a', line: 1 },
  ]);
  assert.deepEqual(ordered.map((f) => f.id), ['c', 'b', 'a']);
});

// --- verification -----------------------------------------------------------------------------

const claim = (id, over = {}) => ({ id, severity: 'critical', category: 'security', file: 'src/a.ts', line: 10, endLine: null, title: `claim ${id}`, issue: 'detail', evidence: 'REVIEWER-EVIDENCE', confidence: 0.99, verdict: 'unverified', ...over });

test('applyVerdicts — silence from the verifier is not confirmation', () => {
  const out = applyVerdicts([claim('F1'), claim('F2')], [{ id: 'F1', verdict: 'confirmed', reason: 'real', evidence: 'src/a.ts:10' }]);
  assert.equal(out[0].verdict, 'confirmed');
  assert.equal(out[1].verdict, 'unverifiable');
  assert.match(out[1].verification.reason, /no verdict/);
});

test('applyVerdicts — a confirmation without evidence is downgraded', () => {
  const [f] = applyVerdicts([claim('F1')], [{ id: 'F1', verdict: 'confirmed', reason: 'trust me', evidence: '  ' }]);
  assert.equal(f.verdict, 'unverifiable');
});

test('applyVerdicts — the verifier can correct severity; the claim is remembered', () => {
  const [f] = applyVerdicts([claim('F1')], [{ id: 'F1', verdict: 'confirmed', reason: 'real but minor', evidence: 'src/a.ts:10', severity: 'low' }]);
  assert.equal(f.severity, 'low');
  assert.equal(f.claimedSeverity, 'critical');
});

test('applyVerdicts — unknown verdicts, unknown ids and invented learning ids are ignored', () => {
  const out = applyVerdicts(
    [claim('F1'), claim('F2')],
    [
      { id: 'F1', verdict: 'probably', reason: 'x', evidence: 'y' },
      { id: 'F9', verdict: 'refuted', reason: 'x', evidence: 'y' },
      { id: 'F2', verdict: 'refuted', reason: 'known', evidence: 'src/a.ts:1', learningId: 'L-made-up' },
    ],
    new Set(['L-real']),
  );
  assert.equal(out[0].verdict, 'unverifiable');
  assert.equal(out[1].verdict, 'refuted');
  assert.equal(out[1].verification.learningId, undefined);
  assert.equal(applyVerdicts([claim('F1')], 'not a list')[0].verdict, 'unverifiable');
});

test('verifier prompt — carries the claim but not the reviewer evidence or confidence', () => {
  const prompt = buildVerifierPrompt({ context: 'CTX', diff: 'DIFF', findings: [claim('F1')] });
  assert.match(prompt, /### F1/);
  assert.match(prompt, /src\/a\.ts:10/);
  assert.match(prompt, /claim F1/);
  assert.doesNotMatch(prompt, /REVIEWER-EVIDENCE/);
  assert.doesNotMatch(prompt, /0\.99/);
});

// --- agent ------------------------------------------------------------------------------------

test('agent args — reviewers are read-only and cannot be prompted for more', () => {
  const args = buildArgs({ model: 'sonnet', systemPrompt: 'S', schema: { type: 'object' }, addDirs: ['/tmp/p'], maxBudgetUsd: 2 });
  const value = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(value('--tools'), 'Read,Grep,Glob');
  assert.equal(value('--permission-prompts'), 'none');
  assert.equal(value('--setting-sources'), '');
  assert.equal(value('--add-dir'), '/tmp/p');
  assert.equal(value('--max-budget-usd'), '2');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(args.includes('--no-session-persistence'));
  for (const banned of ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions']) assert.equal(args.includes(banned), false);
});

test('parseEnvelope — structured output, fallback to result, and failures', () => {
  assert.deepEqual(parseEnvelope(JSON.stringify({ type: 'result', is_error: false, structured_output: { a: 1 }, total_cost_usd: 0.2, num_turns: 4, permission_denials: [{}] })), { output: { a: 1 }, costUsd: 0.2, turns: 4, denials: 1 });
  assert.deepEqual(parseEnvelope(JSON.stringify({ type: 'result', is_error: false, result: '{"b":2}' })).output, { b: 2 });
  assert.match(parseEnvelope('').error, /empty/);
  assert.match(parseEnvelope('Rate limited, try later').error, /not JSON/);
  assert.match(parseEnvelope(JSON.stringify({ type: 'result', is_error: true, subtype: 'error_max_budget_usd', result: 'budget' })).error, /error_max_budget_usd/);
  assert.match(parseEnvelope(JSON.stringify({ type: 'result', is_error: false, result: 'just prose' })).error, /no structured output/);
});

// --- guidance and diff planning ---------------------------------------------------------------

test('guidelines — root files first, nested files scoped to changed directories, within budget', () => {
  const dir = tempDir();
  try {
    write(dir, 'CLAUDE.md', 'ROOT RULES');
    write(dir, 'src/api/CLAUDE.md', 'API RULES');
    write(dir, 'src/ui/CLAUDE.md', 'UI RULES');
    write(dir, '.cursorrules', 'CURSOR RULES');
    const found = collectGuidelines(dir, ['src/api/users.ts'], 10_000);
    assert.deepEqual(found.map((g) => g.path), ['CLAUDE.md', '.cursorrules', 'src/api/CLAUDE.md']);

    const tight = collectGuidelines(dir, ['src/api/users.ts'], 14);
    assert.equal(tight[0].content, 'ROOT RULES');
    assert.equal(tight[1].content, 'CURS');
    assert.equal(tight[1].truncated, true);
    assert.equal(tight.length, 2);
  } finally {
    remove(dir);
  }
});

test('path instructions — only those matching a changed file apply', () => {
  const out = relevantPathInstructions(
    [
      { paths: ['src/db/**'], instructions: 'migrations must be reversible' },
      { paths: ['*.css'], instructions: 'no !important' },
    ],
    ['src/db/001.sql', 'src/a.ts'],
  );
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].files, ['src/db/001.sql']);
});

test('planDiff — files beyond the inline budget are deferred, none are dropped', () => {
  const file = (path, n) => ({ path, binary: false, patch: Array.from({ length: n }, () => '+x').join('\n') });
  const plan = planDiff([file('a', 60), file('b', 60), file('c', 10)], 100);
  assert.deepEqual(plan.inline.map((f) => f.path), ['a', 'c']);
  assert.deepEqual(plan.deferred.map((f) => f.path), ['b']);
  assert.equal(plan.inline.length + plan.deferred.length, 3);
});
