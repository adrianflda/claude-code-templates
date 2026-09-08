import { test } from 'node:test';
import assert from 'node:assert';

// Fixture: a genuinely passing suite → the referee must return PASS (INV2).
test('green fixture passes', () => {
  assert.strictEqual(1 + 1, 2);
});
