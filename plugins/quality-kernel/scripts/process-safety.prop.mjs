// Property tests for the pure functions of process-safety/ (separate command:
// `node --test scripts/*.prop.mjs`). Starter set; the hardener extends it.
import { test } from 'node:test';
import assert from 'node:assert';
import { gen, forAll } from './prop-kit.mjs';
import { resolveTimeoutSeconds, DEFAULT_TIMEOUT_SECONDS } from './process-safety/proc-tree.mjs';
import { evaluatePressure, resolveGuardConfig } from './process-safety/mem-guard.mjs';
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
  const lockGen = gen.record({ pid: gen.int(1, 99999), lstart: gen.string(), runId: gen.map(gen.array(gen.elements(...'0123456789abcdef'), { maxLength: 16 }), (xs) => xs.join('').padEnd(16, '0')), repo: gen.string(), pgids: gen.array(gen.int(2, 99999)) });
  forAll(lockGen, (l) => assert.deepStrictEqual(parseLock(JSON.stringify(l)), l));
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
