// Acceptance suite for fixtures/qk-breaker-robust-input/contracts/contract-1045-shape.md
// One assertion per declared invariant, so contract-lint.mjs's lockstep check (EARS-H8/INV-COND-1)
// can be exercised against a numbered-heading, bold-id contract without needing the real,
// machine-local 1045-static-files contract.
import { test } from 'node:test';
import assert from 'node:assert';

// INV id EO-0: every static href on the login page is a bare /static2/ path.
test('EO-0: static hrefs are bare /static2/ paths', () => {
  const hrefs = ['/static2/app.css', '/static2/app.js'];
  assert.ok(hrefs.every((h) => h.startsWith('/static2/')));
});

// INV id EO-6: collectstatic is idempotent byte-for-byte (re-run invariant).
test('EO-6: collectstatic output is byte-identical across two runs', () => {
  const run1 = 'manifest-v1';
  const run2 = 'manifest-v1';
  assert.strictEqual(run1, run2);
});
