import { test } from 'node:test';
import assert from 'node:assert';
import { rng, gen, forAll } from './prop-kit.mjs';

test('rng is deterministic per seed and stays in [0, 1)', () => {
  const a = rng(42), b = rng(42), c = rng(43);
  const xs = Array.from({ length: 100 }, a);
  assert.deepStrictEqual(Array.from({ length: 100 }, b), xs);
  assert.notDeepStrictEqual(Array.from({ length: 100 }, c), xs);
  assert.ok(xs.every((x) => x >= 0 && x < 1));
});

test('gen.int stays within its bounds and reaches both of them', () => {
  const rand = rng(7), g = gen.int(-3, 5);
  const seen = new Set(Array.from({ length: 500 }, () => g(rand)));
  assert.ok([...seen].every((v) => Number.isInteger(v) && v >= -3 && v <= 5));
  assert.ok(seen.has(-3) && seen.has(5));
});

test('gen.array, gen.string and gen.record respect their shapes', () => {
  const rand = rng(1);
  for (let i = 0; i < 100; i++) {
    const arr = gen.array(gen.bool(), { maxLength: 4 })(rand);
    assert.ok(arr.length <= 4 && arr.every((x) => typeof x === 'boolean'));
    const s = gen.string({ chars: 'ab', maxLength: 3 })(rand);
    assert.match(s, /^[ab]{0,3}$/);
    const r = gen.record({ k: gen.constant(1), e: gen.elements('x', 'y') })(rand);
    assert.ok(r.k === 1 && ['x', 'y'].includes(r.e));
  }
});

test('forAll passes a true property and reports seed and counterexample for a false one', () => {
  forAll(gen.int(0, 10), (n) => n >= 0, { seed: 3 });
  assert.throws(() => forAll(gen.int(0, 10), (n) => n < 10, { seed: 3, runs: 500 }), /seed 3, run \d+; replay with QK_PROP_SEED=3\) for 10/);
  assert.throws(() => forAll(gen.constant('v'), () => { throw new Error('boom'); }, { seed: 9 }), /for "v": boom/);
});
