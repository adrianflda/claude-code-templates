import { test } from 'node:test';
import assert from 'node:assert';
import { evaluatePressure, resolveGuardConfig, readSample, readLinuxSample, runMemoryGuard } from './mem-guard.mjs';

const T = { maxLevel: 2, minPct: 20 };
const none = { pressureLevel: null, levelPct: null, psiAvg10: null, availPct: null };

// --- PT-C8 boundary arithmetic: refusal is strict inequality, equality passes ---
test('PT-C8 — macOS pressure level refuses at >= the maximum (equality refuses), passes below', () => {
  assert.strictEqual(evaluatePressure({ ...none, pressureLevel: 1 }, T).breaches.length, 0);
  const b = evaluatePressure({ ...none, pressureLevel: 2 }, T).breaches;
  assert.strictEqual(b.length, 1);
  assert.match(b[0].signal, /kern\.memorystatus_vm_pressure_level/);
  assert.strictEqual(b[0].value, 2);
  assert.strictEqual(b[0].threshold, 2);
  assert.strictEqual(evaluatePressure({ ...none, pressureLevel: 4 }, T).breaches.length, 1);
});
test('PT-C8 — macOS level percentage refuses strictly below the minimum, equality passes', () => {
  assert.strictEqual(evaluatePressure({ ...none, levelPct: 20 }, T).breaches.length, 0);
  assert.strictEqual(evaluatePressure({ ...none, levelPct: 19 }, T).breaches.length, 1);
  const b = evaluatePressure({ ...none, levelPct: 19 }, T).breaches[0];
  assert.match(b.signal, /kern\.memorystatus_level/);
  assert.deepStrictEqual([b.value, b.threshold], [19, 20]);
});
test('PT-C8 — Linux PSI some avg10 refuses strictly above 25, equality passes (fixed)', () => {
  assert.strictEqual(evaluatePressure({ ...none, psiAvg10: 25 }, T).breaches.length, 0);
  const b = evaluatePressure({ ...none, psiAvg10: 25.01 }, T).breaches;
  assert.strictEqual(b.length, 1);
  assert.match(b[0].signal, /\/proc\/pressure\/memory/);
  assert.deepStrictEqual([b[0].value, b[0].threshold], [25.01, 25]);
});
test('PT-C8 — Linux MemAvailable percentage refuses strictly below the minimum, equality passes', () => {
  const t = { maxLevel: 2, minPct: 15 };
  assert.strictEqual(evaluatePressure({ ...none, availPct: 15 }, t).breaches.length, 0);
  const b = evaluatePressure({ ...none, availPct: 14.9 }, t).breaches;
  assert.strictEqual(b.length, 1);
  assert.match(b[0].signal, /MemAvailable/);
});
test('PT-C8/Decision 10 — any single breaching signal refuses even when the others are healthy', () => {
  const r = evaluatePressure({ pressureLevel: 1, levelPct: 5, psiAvg10: null, availPct: null }, T);
  assert.strictEqual(r.readable, true);
  assert.strictEqual(r.breaches.length, 1);
  const two = evaluatePressure({ pressureLevel: 4, levelPct: 5, psiAvg10: null, availPct: null }, T);
  assert.strictEqual(two.breaches.length, 2);
});
test('PT-C8 — healthy readings do not refuse', () => {
  const r = evaluatePressure({ pressureLevel: 1, levelPct: 89, psiAvg10: null, availPct: null }, T);
  assert.deepStrictEqual(r, { readable: true, breaches: [] });
});

// --- PT-C9 ---
test('PT-C9 — with no readable signal the guard passes and warns on stderr, never refuses', () => {
  assert.strictEqual(evaluatePressure(none, T).readable, false);
  const warnings = [];
  const r = runMemoryGuard({ env: {}, platform: 'darwin', read: () => none, warn: (m) => warnings.push(m) });
  assert.deepStrictEqual(r, { ok: true });
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /memory/i);
});
test('PT-C9 — default warn writes to stderr', () => {
  const orig = process.stderr.write; let seen = '';
  process.stderr.write = (s) => { seen += s; return true; };
  try { runMemoryGuard({ env: {}, platform: 'darwin', read: () => none }); } finally { process.stderr.write = orig; }
  assert.match(seen, /memory/i);
});

// --- PT-C8 reason wording (contractual substring: "memory pressure"; names signal, value, threshold) ---
test('PT-C8 — a breach is INDETERMINATE-worthy: reason says "memory pressure" and names signal, value, threshold', () => {
  const r = runMemoryGuard({ env: {}, platform: 'darwin', read: () => ({ ...none, pressureLevel: 4, levelPct: 50 }) });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /memory pressure/);
  assert.match(r.reason, /kern\.memorystatus_vm_pressure_level/);
  assert.match(r.reason, /\b4\b/);
  assert.match(r.reason, /\b2\b/);
});

// --- PT-C10 / Decision 16 ---
test('PT-C10 — defaults: macOS level 2 / 20 percent; Linux 15 percent (Decision 16)', () => {
  assert.deepStrictEqual(resolveGuardConfig({}, 'darwin'), { off: false, maxLevel: 2, minPct: 20 });
  assert.deepStrictEqual(resolveGuardConfig({}, 'linux'), { off: false, maxLevel: 2, minPct: 15 });
});
test('PT-C10 — overrides apply: QK_MEM_MAX_PRESSURE_LEVEL and QK_MEM_MIN_LEVEL_PCT (also on Linux)', () => {
  assert.deepStrictEqual(resolveGuardConfig({ QK_MEM_MAX_PRESSURE_LEVEL: '1', QK_MEM_MIN_LEVEL_PCT: '101' }, 'darwin'), { off: false, maxLevel: 1, minPct: 101 });
  assert.deepStrictEqual(resolveGuardConfig({ QK_MEM_MAX_PRESSURE_LEVEL: '5', QK_MEM_MIN_LEVEL_PCT: '0' }, 'darwin'), { off: false, maxLevel: 5, minPct: 0 });
  assert.strictEqual(resolveGuardConfig({ QK_MEM_MIN_LEVEL_PCT: '12.5' }, 'linux').minPct, 12.5);
});

// --- PT-C11 ---
test('PT-C11 — QK_MEM_GUARD=off skips the guard entirely (reads nothing, even with a bad threshold)', () => {
  assert.deepStrictEqual(resolveGuardConfig({ QK_MEM_GUARD: 'off', QK_MEM_MIN_LEVEL_PCT: 'abc' }, 'darwin'), { off: true });
  const r = runMemoryGuard({ env: { QK_MEM_GUARD: 'off' }, platform: 'darwin', read: () => { throw new Error('must not read'); } });
  assert.deepStrictEqual(r, { ok: true });
});
test('PT-C11 — QK_MEM_GUARD=on behaves as unset', () => {
  assert.deepStrictEqual(resolveGuardConfig({ QK_MEM_GUARD: 'on' }, 'darwin'), { off: false, maxLevel: 2, minPct: 20 });
});

// --- Decision 17: invalid env fails closed naming the variable ---
test('Decision 17 — QK_MEM_GUARD other than unset/on/off is an error naming the variable', () => {
  for (const v of ['OFF', '1', '', 'true', 'off ']) {
    assert.match(resolveGuardConfig({ QK_MEM_GUARD: v }, 'darwin').error, /QK_MEM_GUARD/, `value ${JSON.stringify(v)}`);
  }
});
test('Decision 17 — non-numeric / out-of-range QK_MEM_MAX_PRESSURE_LEVEL is an error naming the variable', () => {
  for (const v of ['abc', '0', '-1', '1.5', '', '2x', ' 2', 'NaN', 'Infinity']) {
    assert.match(resolveGuardConfig({ QK_MEM_MAX_PRESSURE_LEVEL: v }, 'darwin').error, /QK_MEM_MAX_PRESSURE_LEVEL/, `value ${JSON.stringify(v)}`);
  }
});
test('Decision 17 — non-numeric / out-of-range QK_MEM_MIN_LEVEL_PCT is an error naming the variable', () => {
  for (const v of ['abc', '-1', '', '1e2', ' 5', 'NaN', 'Infinity', '5%']) {
    assert.match(resolveGuardConfig({ QK_MEM_MIN_LEVEL_PCT: v }, 'darwin').error, /QK_MEM_MIN_LEVEL_PCT/, `value ${JSON.stringify(v)}`);
  }
});
test('Decision 17 — runMemoryGuard turns a config error into a refusal naming the variable', () => {
  const r = runMemoryGuard({ env: { QK_MEM_MIN_LEVEL_PCT: 'lots' }, platform: 'darwin', read: () => none });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /QK_MEM_MIN_LEVEL_PCT/);
});

// --- real signal sanity (macOS only; never creates pressure) ---
test('readSample on macOS returns real sysctl values', { skip: process.platform !== 'darwin' && 'macOS only' }, () => {
  const s = readSample('darwin');
  assert.ok(Number.isInteger(s.pressureLevel) && s.pressureLevel >= 1, JSON.stringify(s));
  assert.ok(s.levelPct >= 0 && s.levelPct <= 100, JSON.stringify(s));
  assert.strictEqual(s.psiAvg10, null);
});
test('readSample on an unsupported platform returns all-null (unreadable)', () => {
  assert.deepStrictEqual(readSample('freebsd'), none);
});

// --- readLinuxSample with an injected reader (the Linux probes cannot run on this macOS host) ---
const fakeProc = (files) => (path) => { if (!(path in files)) throw new Error('ENOENT'); return files[path]; };

test('readLinuxSample parses PSI some avg10 and MemAvailable/MemTotal percent', () => {
  const s = readLinuxSample(fakeProc({
    '/proc/pressure/memory': 'some avg10=12.50 avg60=1.00 avg300=0.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n',
    '/proc/meminfo': 'MemTotal:       1000 kB\nMemFree: 1 kB\nMemAvailable:    250 kB\n',
  }));
  assert.deepStrictEqual(s, { psiAvg10: 12.5, availPct: 25 });
});

test('readLinuxSample reports an absent or malformed probe as null (unreadable)', () => {
  assert.deepStrictEqual(readLinuxSample(fakeProc({})), { psiAvg10: null, availPct: null });
  const s = readLinuxSample(fakeProc({ '/proc/pressure/memory': 'garbage', '/proc/meminfo': 'MemTotal: 0 kB\nMemAvailable: 5 kB\n' }));
  assert.deepStrictEqual(s, { psiAvg10: null, availPct: null });
  assert.strictEqual(readLinuxSample(fakeProc({ '/proc/meminfo': 'MemTotal: 10 kB\n' })).availPct, null);
});
