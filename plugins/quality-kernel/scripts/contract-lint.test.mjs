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
