// Executable form of contracts/example.md — one assertion per invariant, EXACT expected values
// (qa-paradigms P4). Immutable-from-base; run by the referee as tools.json "acceptance".
import { test } from 'node:test';
import a from 'node:assert';
import { add } from '../src/calc.mjs';

test('INV-ADD-1 : add(2, 3) === 5', () => a.strictEqual(add(2, 3), 5));
test('INV-ADD-2 : add(non-integer, 3).code === 400', () => a.strictEqual(add('x', 3).code, 400));
