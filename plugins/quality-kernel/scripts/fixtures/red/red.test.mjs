import { test } from 'node:test';
import assert from 'node:assert';

// Fixture: the suite is RED. This represents "the harness claims done but the suite fails"
// (a forged pass). The referee ignores any claim, re-executes, and must BLOCK (INV1).
test('red fixture fails on purpose', () => {
  assert.strictEqual(1 + 1, 3);
});
