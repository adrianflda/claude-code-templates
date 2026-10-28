// Test-only, dependency-free property-testing kit (the plugin ships no package.json, so fast-check is
// not an option). Seeded and reproducible: a failure reports its seed and run index, and
// QK_PROP_SEED=<seed> replays the same cases. No shrinking: generators are biased toward boundary
// values instead, so counterexamples are usually small already.

// mulberry32: a tiny 32-bit PRNG, good enough to drive test-case generation.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A generator is `(rand) => value`.
const pick = (rand, xs) => xs[Math.floor(rand() * xs.length)];
export const gen = {
  constant: (v) => () => v,
  oneOf: (...gens) => (rand) => pick(rand, gens)(rand),
  elements: (...xs) => (rand) => pick(rand, xs),
  // Integer in [min, max]; one case in four is a bound or a neighbour of one.
  int: (min, max) => (rand) => (rand() < 0.25
    ? pick(rand, [min, max, Math.min(min + 1, max), Math.max(max - 1, min)])
    : min + Math.floor(rand() * (max - min + 1))),
  float: (min, max) => (rand) => min + rand() * (max - min),
  bool: () => (rand) => rand() < 0.5,
  array: (g, { maxLength = 8 } = {}) => (rand) => Array.from({ length: Math.floor(rand() * (maxLength + 1)) }, () => g(rand)),
  string: ({ chars = 'abcdefghijklmnopqrstuvwxyz0123456789 _-=./', maxLength = 16 } = {}) => (rand) =>
    Array.from({ length: Math.floor(rand() * (maxLength + 1)) }, () => pick(rand, chars)).join(''),
  record: (shape) => (rand) => Object.fromEntries(Object.entries(shape).map(([k, g]) => [k, g(rand)])),
  map: (g, f) => (rand) => f(g(rand)),
};

const defaultSeed = () => (process.env.QK_PROP_SEED === undefined ? Date.now() : Number(process.env.QK_PROP_SEED));
// A property fails by throwing or returning false.
function check(property, value) {
  try { return { ok: property(value) !== false }; } catch (cause) { return { ok: false, cause }; }
}
const failure = (seed, i, value, cause) => new Error(
  `property failed (seed ${seed}, run ${i}; replay with QK_PROP_SEED=${seed}) for ${JSON.stringify(value)}${cause ? `: ${cause.message}` : ''}`, { cause });

// Runs `property(value)` on `runs` generated values; throws on the first failing one.
export function forAll(g, property, { runs = 200, seed = defaultSeed() } = {}) {
  const rand = rng(seed);
  for (let i = 0; i < runs; i++) {
    const value = g(rand);
    const { ok, cause } = check(property, value);
    if (!ok) throw failure(seed, i, value, cause);
  }
}
