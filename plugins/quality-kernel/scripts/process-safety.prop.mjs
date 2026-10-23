// Property tests for the pure functions of process-safety/ (separate command:
// `node --test scripts/*.prop.mjs`). Starter set; the hardener extends it.
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gen, forAll } from './prop-kit.mjs';
import { resolveTimeoutSeconds, DEFAULT_TIMEOUT_SECONDS, unsupportedPlatformReason, procfsPidsCarrying } from './process-safety/proc-tree.mjs';
import { evaluatePressure, resolveGuardConfig, readLinuxSample } from './process-safety/mem-guard.mjs';
import { classifyLock } from './process-safety/gate-lock.mjs';
import { commandFailure } from './process-safety/gate-session.mjs';
import { parseLock } from './process-safety/lock-store.mjs';
import { parsePsPids } from './process-safety/proc-group.mjs';
import { lastJsonLine } from './process-safety/proc-forward.mjs';

const anyValue = gen.oneOf(gen.int(-10, 4000), gen.float(-1, 4000), gen.string(), gen.constant(null), gen.bool(), gen.map(gen.int(1, 3600), String));

test('resolveTimeoutSeconds accepts exactly the integers 1..3600, unchanged, and defaults only when absent', () => {
  assert.deepStrictEqual(resolveTimeoutSeconds({}), { seconds: DEFAULT_TIMEOUT_SECONDS });
  forAll(anyValue, (v) => {
    const r = resolveTimeoutSeconds({ timeoutSeconds: v });
    const valid = Number.isInteger(v) && v >= 1 && v <= 3600;
    return valid ? r.seconds === v && !('error' in r) : r.error.includes('timeoutSeconds') && !('seconds' in r);
  });
});

const reading = (g) => gen.oneOf(gen.constant(null), g);
const sampleGen = gen.record({ pressureLevel: reading(gen.int(0, 6)), levelPct: reading(gen.float(0, 100)), psiAvg10: reading(gen.float(0, 100)), availPct: reading(gen.float(0, 100)) });
const thresholdsGen = gen.record({ maxLevel: gen.int(1, 5), minPct: gen.float(0, 50) });

test('evaluatePressure: readable iff any reading is non-null; every breach names a read signal', () => {
  forAll(gen.record({ s: sampleGen, t: thresholdsGen }), ({ s, t }) => {
    const { readable, breaches } = evaluatePressure(s, t);
    return readable === Object.values(s).some((v) => v !== null) && breaches.every((b) => b.value !== null) && (readable || breaches.length === 0);
  });
});

test('evaluatePressure is monotonic: raising the pressure level never removes a breach', () => {
  forAll(gen.record({ s: sampleGen, t: thresholdsGen, d: gen.int(0, 3) }), ({ s, t, d }) => {
    if (s.pressureLevel === null) return true;
    return evaluatePressure({ ...s, pressureLevel: s.pressureLevel + d }, t).breaches.length >= evaluatePressure(s, t).breaches.length;
  });
});

test('resolveGuardConfig never returns both an error and a configuration', () => {
  const envGen = gen.record({ QK_MEM_GUARD: gen.elements(undefined, 'on', 'off', 'yes', ''), QK_MEM_MAX_PRESSURE_LEVEL: gen.oneOf(gen.constant(undefined), gen.string({ chars: '0123456789.-x', maxLength: 4 })), QK_MEM_MIN_LEVEL_PCT: gen.oneOf(gen.constant(undefined), gen.string({ chars: '0123456789.-x', maxLength: 4 })) });
  forAll(gen.record({ env: envGen, platform: gen.elements('darwin', 'linux', 'freebsd') }), ({ env, platform }) => {
    const c = resolveGuardConfig(env, platform);
    return 'error' in c ? !('off' in c) : (c.off === true || (Number.isInteger(c.maxLevel) && c.maxLevel >= 1 && c.minPct >= 0));
  });
});

test('commandFailure: a timeout always wins and names the budget; otherwise it fails exactly on no usable exit code', () => {
  const resultGen = gen.record({ timedOut: gen.bool(), code: gen.oneOf(gen.constant(null), gen.int(0, 255)), signal: gen.elements(null, 'SIGKILL'), hasStdout: gen.bool(), error: gen.elements(undefined, new Error('spawn failed')) });
  forAll(gen.record({ r: resultGen, n: gen.int(1, 3600) }), ({ r, n }) => {
    const f = commandFailure(r, { label: 'verify', cmd: 'npm test', timeoutSeconds: n });
    if (r.timedOut) return new RegExp(`timed out after ${n}s; process tree killed`).test(f);
    const failed = Boolean(r.error) || r.code === null || ([126, 127].includes(r.code) && !r.hasStdout);
    return failed ? typeof f === 'string' : f === null;
  });
});

test('parseLock round-trips every well-formed lock and rejects arbitrary text', () => {
  const lockGen = gen.record({ pid: gen.int(1, 99999), lstart: gen.string(), runId: gen.map(gen.array(gen.elements(...'0123456789abcdef'), { maxLength: 16 }), (xs) => xs.join('').padEnd(16, '0')), repo: gen.string(), pgids: gen.array(gen.int(2, 99999)), descendants: gen.array(gen.record({ pid: gen.int(2, 99999), start: gen.string() })) });
  forAll(lockGen, (l) => assert.deepStrictEqual(parseLock(JSON.stringify(l)), l));
  forAll(lockGen, (l) => { const { descendants, ...legacy } = l; return JSON.stringify(parseLock(JSON.stringify(legacy)).descendants) === '[]'; });
  forAll(gen.string(), (s) => { const r = parseLock(s); return r === null || Number.isInteger(r.pid); });
});

test('parsePsPids never returns the ps process itself and only pids whose line carries the needle', () => {
  const lineGen = gen.record({ pid: gen.int(1, 50), marked: gen.bool() });
  forAll(gen.record({ lines: gen.array(lineGen, { maxLength: 12 }), psPid: gen.int(1, 50) }), ({ lines, psPid }) => {
    const out = parsePsPids(lines.map((l) => `  ${l.pid} node x ${l.marked ? 'QK_RUN_ID=ab' : 'A=1'}`).join('\n'), 'QK_RUN_ID=ab', psPid);
    const expected = lines.filter((l) => l.marked && l.pid !== psPid).map((l) => l.pid);
    assert.deepStrictEqual(out, expected);
  });
});

test('lastJsonLine returns the last JSON line regardless of what precedes it', () => {
  forAll(gen.record({ noise: gen.array(gen.string({ chars: 'abc {}' })), v: gen.record({ pass: gen.bool(), code: gen.int(0, 3) }) }), ({ noise, v }) => {
    assert.deepStrictEqual(lastJsonLine([...noise, JSON.stringify(v), ''].join('\n')), v);
  });
});

// --- hardener additions ---
const breachedSignals = (s, t) => evaluatePressure(s, t).breaches.map((b) => b.signal);
test('evaluatePressure is monotonic in every signal: more pressure (lower %, higher PSI) never removes a breach', () => {
  const worse = { levelPct: -1, psiAvg10: 1, availPct: -1 };
  forAll(gen.record({ s: sampleGen, t: thresholdsGen, key: gen.elements(...Object.keys(worse)), d: gen.float(0, 30) }), ({ s, t, key, d }) => {
    if (s[key] === null) return true;
    const before = breachedSignals(s, t);
    const after = breachedSignals({ ...s, [key]: s[key] + worse[key] * d }, t);
    return before.every((sig) => after.includes(sig));
  });
});

test('evaluatePressure boundaries: level breaches at equality; percentages and PSI only strictly past the threshold', () => {
  const none = { pressureLevel: null, levelPct: null, psiAvg10: null, availPct: null };
  forAll(gen.record({ maxLevel: gen.int(1, 5), minPct: gen.int(0, 50), eps: gen.elements(0.5, 0.01, 1) }), ({ maxLevel, minPct, eps }) => {
    const t = { maxLevel, minPct }; const n = (sample) => evaluatePressure({ ...none, ...sample }, t).breaches.length;
    assert.deepStrictEqual(
      [n({ pressureLevel: maxLevel }), n({ pressureLevel: maxLevel - 1 }), n({ levelPct: minPct }), n({ levelPct: minPct - eps }),
        n({ availPct: minPct }), n({ availPct: minPct - eps }), n({ psiAvg10: 25 }), n({ psiAvg10: 25 + eps })],
      [1, 0, 0, 1, 0, 1, 0, 1]);
  });
});

test('resolveGuardConfig applies every well-formed override exactly (any digit count)', () => {
  forAll(gen.record({ level: gen.int(1, 99999), whole: gen.int(0, 999), frac: gen.string({ chars: '0123456789', maxLength: 4 }), platform: gen.elements('darwin', 'linux') }), ({ level, whole, frac, platform }) => {
    const pct = frac ? `${whole}.${frac}` : String(whole);
    assert.deepStrictEqual(resolveGuardConfig({ QK_MEM_MAX_PRESSURE_LEVEL: String(level), QK_MEM_MIN_LEVEL_PCT: pct }, platform), { off: false, maxLevel: level, minPct: Number(pct) });
  });
});

test('commandFailure names the command and the cause; "not executable" exactly for 126/127 without stdout (PT-D4/D5)', () => {
  const resultGen = gen.record({ timedOut: gen.bool(), code: gen.oneOf(gen.constant(null), gen.elements(0, 1, 2, 125, 126, 127, 128), gen.int(0, 255)), signal: gen.elements(null, 'SIGKILL', 'SIGSEGV'), hasStdout: gen.bool(), error: gen.elements(undefined, new Error('spawn sh ENOENT')) });
  forAll(gen.record({ r: resultGen, n: gen.int(1, 3600) }), ({ r, n }) => {
    const f = commandFailure(r, { label: 'verify', cmd: 'npm test', timeoutSeconds: n });
    if (r.timedOut) return f === `verify timed out after ${n}s; process tree killed: "npm test"`;
    if (r.error) return f === 'verify could not complete: "npm test" (spawn sh ENOENT)';
    if (r.code === null) return f === `verify could not complete: "npm test" (${r.signal ? `killed by ${r.signal}` : 'no exit status'})`;
    if ((r.code === 126 || r.code === 127) && !r.hasStdout) return f === `verify not executable (exit ${r.code}): "npm test"`;
    return f === null;
  });
});

test('parseLock rejects any lock whose pid is not a positive integer or whose runId is not exactly 16 lowercase hex chars', () => {
  const hex16 = gen.constant('a1b2c3d4e5f60718');
  const badRunId = gen.oneOf(gen.map(gen.string({ chars: 'xz-G \n', maxLength: 3 }), (p) => `${p || 'x'}a1b2c3d4e5f60718`), gen.map(gen.string({ chars: 'xz-G \n', maxLength: 3 }), (p) => `a1b2c3d4e5f60718${p || 'x'}`), gen.constant(1234567890123456), gen.constant('a1b2c3d4e5f6071'));
  forAll(gen.record({ pid: gen.int(-5, 0), runId: hex16 }), (l) => parseLock(JSON.stringify({ ...l, pgids: [] })) === null);
  forAll(gen.record({ pid: gen.int(1, 99999), runId: badRunId }), (l) => parseLock(JSON.stringify({ ...l, pgids: [] })) === null);
});

test('classifyLock: stale iff the pid is gone or its readable start time differs from a recorded one (never kill on doubt)', () => {
  const t = gen.elements(null, '', 'Mon Jan  1 00:00:00 2026', 'Tue Jan  2 00:00:00 2026');
  forAll(gen.record({ exists: gen.bool(), lstart: t, now: t }), ({ exists, lstart, now }) => {
    let asked = null;
    const got = classifyLock({ pid: 4242, lstart }, { exists: (p) => { asked = p; return exists; }, start: () => now });
    const stale = !exists || Boolean(lstart && now && now !== lstart);
    return asked === 4242 && got === (stale ? 'stale' : 'live');
  });
});

test('procfsPidsCarrying returns exactly the all-digit entries whose readable environ carries the needle', () => {
  const entryGen = gen.record({ name: gen.oneOf(gen.map(gen.int(1, 99999), String), gen.elements('self', '12x', 'x12', 'net')), environ: gen.elements(null, 'A=1\0', 'A=1\0QK_RUN_ID=abc\0', 'QK_RUN_ID=abcd\0', 'QK_RUN_ID=ab\0') });
  forAll(gen.array(entryGen, { maxLength: 6 }), (entries) => {
    const root = mkdtempSync(join(tmpdir(), 'qkpt-procfs-'));
    try {
      const made = new Map();
      for (const e of entries) {
        if (made.has(e.name)) continue;
        made.set(e.name, e.environ); mkdirSync(join(root, e.name));
        if (e.environ !== null) writeFileSync(join(root, e.name, 'environ'), e.environ);
      }
      const expected = [...made].filter(([n, env]) => /^\d+$/.test(n) && env !== null && env.includes('QK_RUN_ID=abc')).map(([n]) => Number(n));
      assert.deepStrictEqual(procfsPidsCarrying('QK_RUN_ID=abc', root).sort((a, b) => a - b), expected.sort((a, b) => a - b));
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, { runs: 60 });
});

test('readLinuxSample: PSI is the "some avg10" value and availability is MemAvailable/MemTotal in percent', () => {
  forAll(gen.record({ avg10: gen.float(0, 100), total: gen.int(1, 10 ** 8), share: gen.float(0, 1) }), ({ avg10, total, share }) => {
    const avail = Math.floor(total * share);
    const files = { '/proc/pressure/memory': `some avg10=${avg10.toFixed(2)} avg60=99.00 avg300=0.00 total=1\nfull avg10=77.00 avg60=0.00 avg300=0.00 total=0\n`, '/proc/meminfo': `MemTotal:  ${total} kB\nMemFree:  1 kB\nMemAvailable:  ${avail} kB\n` };
    const s = readLinuxSample((p) => files[p]);
    return s.psiAvg10 === Number(avg10.toFixed(2)) && Math.abs(s.availPct - (avail / total) * 100) < 1e-9;
  });
});

test('unsupportedPlatformReason refuses exactly win32', () => {
  forAll(gen.oneOf(gen.elements('win32', 'darwin', 'linux', 'freebsd', 'aix', 'sunos'), gen.string()), (p) => (unsupportedPlatformReason(p) === null) === (p !== 'win32'));
});
