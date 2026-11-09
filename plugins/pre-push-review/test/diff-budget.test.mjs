import { test } from 'node:test';
import assert from 'node:assert';
import { boundDiffBytes, MAX_DIFF_LINES } from '../scripts/diff-budget.mjs';

// OG-17/F17: the skipped-files footer must never be partially cut by a later truncation step — every
// name counted in "N file(s) not reviewed" must actually be present in the returned text, and the
// total line count must never exceed MAX_DIFF_LINES.
function fileDiff(name, lines) {
  return `diff --git a/${name} b/${name}\n@@ -1,1 +1,${lines} @@\n${Array.from({ length: lines }, (_, i) => `+line${i}`).join('\n')}\n`;
}
const countListed = (out) => (out.match(/^#   /gm) || []).length;
const claimedSkipped = (out) => Number((out.match(/(\d+) file\(s\) not reviewed/) || [])[1] || 0);

test('OG-17/F17: one large file plus 60 tiny files that overflow the budget — every claimed name is present', () => {
  let diff = fileDiff('big.txt', 2937);
  for (let i = 0; i < 60; i++) diff += fileDiff(`tiny${i}.txt`, 3);
  const out = boundDiffBytes(diff);
  const lines = out.split('\n').length;
  assert.ok(lines <= MAX_DIFF_LINES, `output is ${lines} lines, over the ${MAX_DIFF_LINES}-line budget`);
  const claimed = claimedSkipped(out);
  assert.ok(claimed > 0, 'sanity: this scenario must actually skip files');
  assert.strictEqual(countListed(out), claimed, `footer claims ${claimed} but only ${countListed(out)} names are present — the footer was cut`);
});

test('a diff that fits entirely has no footer and keeps every file', () => {
  const diff = fileDiff('a.txt', 5) + fileDiff('b.txt', 5);
  const out = boundDiffBytes(diff);
  assert.doesNotMatch(out, /not reviewed/);
  assert.match(out, /a\.txt/);
  assert.match(out, /b\.txt/);
});

test('a file over MAX_FILE_BYTES/MAX_LINE_CHARS is sent as header-only, not fully skipped', () => {
  const huge = `diff --git a/big.min.js b/big.min.js\n@@ -1,1 +1,1 @@\n+${'x'.repeat(3000)}\n`;
  const out = boundDiffBytes(huge);
  assert.match(out, /content omitted/);
  assert.doesNotMatch(out, /not reviewed/);
});

test('every name listed in the footer is present verbatim, across a range of skip counts', () => {
  for (const n of [1, 5, 48, 49, 50, 51, 100]) {
    let diff = fileDiff('anchor.txt', 2950);
    for (let i = 0; i < n; i++) diff += fileDiff(`f${i}.txt`, 2);
    const out = boundDiffBytes(diff);
    const claimed = claimedSkipped(out);
    if (claimed === 0) continue; // this n did not overflow the budget at all; nothing to check
    assert.strictEqual(countListed(out), claimed, `n=${n}: claimed ${claimed}, listed ${countListed(out)}`);
    assert.ok(out.split('\n').length <= MAX_DIFF_LINES, `n=${n}: output over budget`);
  }
});
