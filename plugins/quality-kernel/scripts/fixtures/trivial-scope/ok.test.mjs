import { test } from 'node:test';
import assert from 'node:assert';

// A trivial passing test. It must NOT be able to rescue a red suite (INV3):
// the referee runs the whole configured verify command, not this test alone.
test('trivial ok', () => {
  assert.ok(true);
});
