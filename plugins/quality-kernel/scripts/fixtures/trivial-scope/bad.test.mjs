import { test } from 'node:test';
import assert from 'node:assert';

// The real, in-scope test is RED. Because the referee runs the FULL verify command
// (`node --test` discovers this file too), the suite is red and the verdict is FAIL.
test('in-scope test is red', () => {
  assert.strictEqual('a', 'b');
});
