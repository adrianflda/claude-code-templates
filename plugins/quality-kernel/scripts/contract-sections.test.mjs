// Tests for the shared contract-section parser (EARS-H1/H2/H2b/H3/H4/H4b/H5).
// Shared by breaker-invoke.mjs, contract-lint.mjs and gstack-breaker.mjs (design.md Option B) so the
// heading/table-row parsing mechanism can never drift between the two places that read a contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scanSections,
  emptySectionReason,
  normalizeId,
  splitRow,
  parseInvariantsTable,
} from './contract-sections.mjs';

// --- EARS-H1/H2: numbered/parenthetical headings recognized regardless of prefix/suffix ---
test('EARS-H1/H2: numbered, parenthetical headings open the QA and Invariants sections', () => {
  const md = [
    '## 5. End-to-end QA procedure (UI-only — browser, no internal API)',
    'Navigate to http://example.com/admin/login/',
    '## 6. External Observable Invariants',
    '| **EO-0** | pred | probe | RED |',
  ].join('\n');
  const s = scanSections(md);
  assert.match(s.qaProcedure, /Navigate to http:\/\/example\.com\/admin\/login\//);
  assert.deepEqual(s.invariants, [{ id: 'EO-0', expected: 'RED' }]);
});

// --- EARS-H7: legacy exact headings + INV- ids keep working ---
test('EARS-H7: legacy "## QA procedure" / "## Invariants" headings and INV- ids still parse', () => {
  const md = [
    '## Invariants',
    '| INV-ADD-1 | add(2, 3) | 5 |',
    '## QA procedure',
    '1. Call add(2, 3).',
  ].join('\n');
  const s = scanSections(md);
  assert.match(s.qaProcedure, /Call add\(2, 3\)/);
  assert.deepEqual(s.invariants, [{ id: 'INV-ADD-1', expected: '5' }]);
});

// --- EARS-H2b: first matching heading wins; a later genuinely-matching heading is ignored ---
test('EARS-H2b: a second heading that ALSO matches never overrides the first (dup.md)', () => {
  const md = [
    '## 6. External Observable Invariants',
    '| INV-A | d | 1 |',
    '## 9. Invariants (changelog)',
    '| INV-Z | changelog-only | 99 |',
  ].join('\n');
  const s = scanSections(md);
  assert.deepEqual(s.invariants, [{ id: 'INV-A', expected: '1' }]);
  assert.ok(!s.invariants.some((i) => i.id === 'INV-Z'));
});

// --- EARS-H4b: duplicate id within the SAME table uses the first row ---
test('EARS-H4b: a duplicate id in the SAME table keeps only the first row', () => {
  const md = ['## Invariants', '| INV-A | first | 1 |', '| INV-A | second | 2 |'].join('\n');
  const s = scanSections(md);
  assert.deepEqual(s.invariants, [{ id: 'INV-A', expected: '1' }]);
});

// --- EARS-H3 vs EARS-H2/H2b precedence (design.md carried major #5) ---
test('EARS-H3 precedence: a nested heading lexically matching "Invariants" stays inside the open QA section', () => {
  const md = [
    '## 5. End-to-end QA procedure',
    'step 1',
    '### Known invariants to recheck',
    'not a real table',
    '## 6. External Observable Invariants',
    '| INV-A | d | 1 |',
  ].join('\n');
  const s = scanSections(md);
  assert.match(s.qaProcedure, /Known invariants to recheck/);
  assert.deepEqual(s.invariants, [{ id: 'INV-A', expected: '1' }]);
});

// --- EARS-H4: bold + trailing parenthetical stripping, including malformed/unmatched bold ---
test('EARS-H4: bold id with a trailing parenthetical normalizes to the bare id', () => {
  assert.equal(normalizeId('**EO-6 (re-run)**'), 'EO-6');
  assert.equal(normalizeId('EO-7 (a) (b)'), 'EO-7');
});
test('EARS-H4: unmatched bold (only one side) leaves the stray ** in place', () => {
  assert.equal(normalizeId('**EO-9'), '**EO-9');
});

// --- EARS-H5: pipe splitting respects escaping and inline-code spans ---
test('EARS-H5: a literal pipe inside backticks does not shift which cell is "expected"', () => {
  const row = '| **EO-6 (re-run)** | d | `diff <(x) <(y \\| jq .)` | not yet probeable |';
  const cells = splitRow(row).map((c) => c.trim()).filter((c) => c !== '');
  assert.equal(cells.at(-1), 'not yet probeable');
});
test('EARS-H5: expected is the LAST cell regardless of how many cells are in between', () => {
  const s = parseInvariantsTable('| INV-A | d | p1 | p2 | p3 | 42 |');
  assert.deepEqual(s, [{ id: 'INV-A', expected: '42' }]);
});

// Panel finding (MEDIUM, contract-sections.mjs:27): EARS-H5's escaped-pipe rule had no DIRECT test —
// the only prior pipe-escaping coverage (above, and contract-sections.prop.mjs) exercised a `\|`
// INSIDE backticks, where the backtick-protection guard alone already blocks the boundary regardless
// of the backslash check. This covers an escaped `\|` OUTSIDE backticks, where only the backslash
// rule can save the cell from being split in two.
test('EARS-H5: a literal `\\|` OUTSIDE backticks is kept as one cell, not a boundary', () => {
  const row = '| INV-A | a\\|b | 1 |';
  const cells = splitRow(row).map((c) => c.trim()).filter((c) => c !== '');
  assert.deepEqual(cells, ['INV-A', 'a\\|b', '1']);
});

// --- EARS-H6: empty section fails closed, naming which is empty and listing headings ---
test('EARS-H6: an empty QA-procedure body is reported as empty, naming headings found', () => {
  const md = ['## 5. End-to-end QA procedure', '', '## 6. External Observable Invariants', '| INV-A | d | 1 |'].join('\n');
  const reason = emptySectionReason(scanSections(md));
  assert.match(reason, /qaProcedure/);
  assert.match(reason, /## 5\. End-to-end QA procedure/);
});
test('EARS-H6: an empty invariants table is reported as empty, naming headings found', () => {
  const md = ['## 5. End-to-end QA procedure', 'do it', '## 6. External Observable Invariants', ''].join('\n');
  const reason = emptySectionReason(scanSections(md));
  assert.match(reason, /invariants/);
  assert.match(reason, /## 6\. External Observable Invariants/);
});
test('EARS-H6: both empty are named together, not just the first', () => {
  const md = ['## 5. End-to-end QA procedure', '', '## 6. External Observable Invariants', ''].join('\n');
  const reason = emptySectionReason(scanSections(md));
  assert.match(reason, /qaProcedure/);
  assert.match(reason, /invariants/);
});
test('emptySectionReason: null when both sections are non-empty', () => {
  const md = ['## QA procedure', 'x', '## Invariants', '| INV-A | d | 1 |'].join('\n');
  assert.equal(emptySectionReason(scanSections(md)), null);
});
