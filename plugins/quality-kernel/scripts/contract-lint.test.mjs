import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { contractIds, acceptanceIds, diff } from './contract-lint.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, 'contract-lint.mjs');
const exampleMd = join(here, 'fixtures', 'm2', 'contracts', 'example.md');
const exampleTest = join(here, 'fixtures', 'm2', 'acceptance', 'example.test.mjs');

const MD = "## Invariants\n| id | d | expected |\n| INV-A | x | 1 |\n| INV-B | y | 2 |\n\n## QA procedure\n- do it";

test('contractIds — reads ids from the Invariants table only', () => {
  assert.deepStrictEqual([...contractIds(MD)].sort(), ['INV-A', 'INV-B']);
});
test('acceptanceIds — reads ids referenced by the acceptance suite', () => {
  assert.deepStrictEqual([...acceptanceIds("test('INV-A : ...', ()=>{}); test('INV-B', ()=>{})")].sort(), ['INV-A', 'INV-B']);
});
test('diff — flags a missing assertion and an orphan assertion', () => {
  const d = diff(MD, "test('INV-A', ()=>{}); test('INV-Z', ()=>{})");
  assert.deepStrictEqual(d.missingAssertion, ['INV-B']); // declared, not checked
  assert.deepStrictEqual(d.orphanAssertion, ['INV-Z']);  // checked, not declared
});

test('CLI — the shipped example contract is in lockstep (exit 0)', () => {
  const r = spawnSync('node', [cli, '--contract', exampleMd, '--acceptance', exampleTest], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(JSON.parse(r.stdout).ok, true);
});

test('CLI (RED) — an acceptance suite missing one invariant fails (exit 1)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'qk-lint-'));
  try {
    const md = join(tmp, 'c.md'), tf = join(tmp, 'c.test.mjs');
    writeFileSync(md, MD);
    writeFileSync(tf, "test('INV-A : only one', () => {});"); // INV-B has no assertion
    const r = spawnSync('node', [cli, '--contract', md, '--acceptance', tf], { encoding: 'utf8' });
    assert.strictEqual(r.status, 1);
    assert.deepStrictEqual(JSON.parse(r.stdout).missingAssertion, ['INV-B']);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// --- review regression (#25): ids in COMMENTS are documentation, not assertions ---
test('acceptanceIds (RED) — a bare `// INV-X` comment does NOT satisfy the lockstep', () => {
  assert.deepStrictEqual([...acceptanceIds('// INV-A\n/* INV-B */\n')], []);
});
test('acceptanceIds — executable references still count, and a URL is not read as a comment', () => {
  const src = "test('INV-A works', () => {});\ntest('INV-B at http://x/y', () => {});";
  assert.deepStrictEqual([...acceptanceIds(src)].sort(), ['INV-A', 'INV-B']);
});
test('diff (RED) — an invariant only mentioned in a comment is reported as missing', () => {
  const md = '## Invariants\n| INV-A | x | y |\n';
  assert.deepStrictEqual(diff(md, '// INV-A\n').missingAssertion, ['INV-A']);
});

// --- EARS-H8 (INV-14): contract-lint.mjs's declared-id extraction uses the SAME heading-matching
// rule as EARS-H2/H2b, so a numbered/parenthetical "## External Observable Invariants" heading with
// bold, non-INV- ids is no longer treated as "no invariants declared". ---
const shapeMd = join(here, 'fixtures', 'qk-breaker-robust-input', 'contracts', 'contract-1045-shape.md');
const shapeAcceptance = join(here, 'fixtures', 'qk-breaker-robust-input', 'acceptance', 'contract-1045-shape.test.mjs');

test('contractIds (EARS-H8) — a numbered "## N. ... Invariants" heading with bold ids is recognized', () => {
  const md = '## 6. External Observable Invariants\n| **EO-0** | pred | probe | RED |\n';
  assert.deepStrictEqual([...contractIds(md)], ['EO-0']);
});

test('CLI (EARS-H8/INV-14) — the numbered-heading fixture is no longer "no invariants declared" (exit 0)', () => {
  const r = spawnSync('node', [cli, '--contract', shapeMd, '--acceptance', shapeAcceptance], { encoding: 'utf8' });
  const out = JSON.parse(r.stdout.trim());
  assert.strictEqual(r.status, 0, JSON.stringify(out));
  assert.strictEqual(out.ok, true);
  assert.ok(out.declared.length > 0);
});

// --- panel regression: ID_RE was widened (EARS-H8/EARS-H4's grammar, letters/digits-hyphen, no
// fixed prefix) to recognize non-`INV-` ids like EO-0. acceptanceIds() reuses that same wide regex,
// so ordinary uppercase-hyphen prose tokens that are NOT invariant ids at all (`Content-Type`,
// `UTF-8`) now match too. diff() must not let those become spurious orphanAssertion entries for a
// contract that only declares INV- ids. ---
test('diff (RED) — ordinary uppercase-hyphen tokens (Content-Type, UTF-8) are not treated as referenced ids', () => {
  const md = '## Invariants\n| INV-1 | x | y |\n';
  const src = "test('INV-1: sets Content-Type header and UTF-8 charset correctly', () => {});";
  const d = diff(md, src);
  assert.deepStrictEqual(d.orphanAssertion, []);
  assert.ok(!d.checked.includes('Content-Type'), `checked should not include Content-Type: ${d.checked}`);
  assert.ok(!d.checked.includes('UTF-8'), `checked should not include UTF-8: ${d.checked}`);
  assert.deepStrictEqual(d.missingAssertion, []); // INV-1 IS referenced
});
