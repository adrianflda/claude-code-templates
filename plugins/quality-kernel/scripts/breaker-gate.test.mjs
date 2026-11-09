import './hermetic-git.mjs';
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { syncNotExecutedRecord } from './breaker-gate.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const gate = join(here, 'breaker-gate.mjs');
const contract = join(here, 'fixtures', 'm2', 'contracts', 'example.md');

// a critical change (src/auth/**) with a green referee -> qk-gate exit 3 (blocked-needs-breaker)
function criticalRepo() {
  const tmp = mkdtempSync(join(tmpdir(), 'qk-bgate-'));
  const git = (...a) => spawnSync('git', ['-C', tmp, ...a], { encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  const w = (p, c) => { const d = join(tmp, p); mkdirSync(dirname(d), { recursive: true }); writeFileSync(d, c); };
  w('.quality-kernel/tools.json', JSON.stringify({ verify: 'node --test x.test.mjs', productionGlobs: ['src/**'] }));
  w('.quality-kernel/critical-surface.json', JSON.stringify({ criticalGlobs: ['**/auth/**'], safeGlobs: ['**/*.md'] }));
  w('x.test.mjs', "import { test } from 'node:test'; import a from 'node:assert'; test('ok', () => a.ok(true));");
  w('src/auth/thing.ts', 'export const x = 1;');
  git('add', '-A'); git('commit', '-qm', 'base'); const base = git('rev-parse', 'HEAD').stdout.trim();
  w('src/auth/thing.ts', 'export const x = 2;');
  git('add', '-A'); git('commit', '-qm', 'change'); const head = git('rev-parse', 'HEAD').stdout.trim();
  return { tmp, base, head };
}
function stub(verdict) { return stubJson({ verdict }); }
function stubJson(payload) {
  const tmp = mkdtempSync(join(tmpdir(), 'qk-brk-'));
  const p = join(tmp, 'stub.mjs');
  writeFileSync(p, `let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{console.log(${JSON.stringify(JSON.stringify(payload))});});`);
  return { tmp, cmd: `node ${p}` };
}
const notExecutedPath = (repo) => join(repo, '.quality-kernel', 'breaker-not-executed.json');
const run = (repo, base, head, extra = []) => spawnSync('node', [gate, '--repo', repo, '--base', base, '--head', head, ...extra], { encoding: 'utf8' });
const json = (r) => JSON.parse((r.stdout || '').trim().split('\n').filter(Boolean).pop());

test('breaker-gate — critical + green referee + NO breaker -> exit 3 (still unenforced)', () => {
  const { tmp, base, head } = criticalRepo();
  try { const r = run(tmp, base, head); assert.strictEqual(r.status, 3); assert.strictEqual(json(r).gate, 'blocked-needs-breaker'); }
  finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('breaker-gate — critical + green referee + breaker PASS -> exit 0', () => {
  const { tmp, base, head } = criticalRepo(); const s = stub('BREAKER_PASS');
  try {
    const r = run(tmp, base, head, ['--breaker', s.cmd, '--contract', contract, '--probe', 'true', '--url', 'http://x']);
    assert.strictEqual(r.status, 0); assert.strictEqual(json(r).gate, 'pass');
  } finally { rmSync(tmp, { recursive: true, force: true }); rmSync(s.tmp, { recursive: true, force: true }); }
});

test('breaker-gate — critical + green referee + breaker FAIL -> exit 1', () => {
  const { tmp, base, head } = criticalRepo(); const s = stub('BREAKER_FAIL');
  try {
    // --probe/--url are REQUIRED now: a breaker with no live target cannot produce a trusted verdict,
    // so they must be supplied to reach the breaker at all (otherwise it fails closed as exit 2).
    const r = run(tmp, base, head, ['--breaker', s.cmd, '--contract', contract, '--probe', 'true', '--url', 'http://x']);
    assert.strictEqual(r.status, 1); assert.strictEqual(json(r).gate, 'breaker-fail');
  } finally { rmSync(tmp, { recursive: true, force: true }); rmSync(s.tmp, { recursive: true, force: true }); }
});

// --- review regression (#25): the contract lint is a PRECONDITION, not a documented prerequisite ---
test('breaker-gate (RED) — a contract with no invariants blocks even with a PASSing breaker', () => {
  const { tmp, base, head } = criticalRepo(); const s = stub('BREAKER_PASS');
  const c = mkdtempSync(join(tmpdir(), 'qk-contract-'));
  try {
    const md = join(c, 'empty.md'), acc = join(c, 'empty.test.mjs');
    writeFileSync(md, '# Contract\n\n## QA procedure\n1. open the app\n');   // no ## Invariants table
    writeFileSync(acc, "import { test } from 'node:test'; test('x', () => {});");
    const r = run(tmp, base, head, ['--breaker', s.cmd, '--contract', md, '--acceptance', acc, '--probe', 'true', '--url', 'http://x']);
    assert.strictEqual(r.status, 3);
    assert.strictEqual(json(r).gate, 'blocked-invalid-contract');
  } finally { [tmp, s.tmp, c].forEach((d) => rmSync(d, { recursive: true, force: true })); }
});

// a critical change that ALSO edits a test file -> referee overlays it -> human review is required
function testChangeRepo() {
  const tmp = mkdtempSync(join(tmpdir(), 'qk-bgate-tc-'));
  const git = (...a) => spawnSync('git', ['-C', tmp, ...a], { encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  const w = (p, c) => { const d = join(tmp, p); mkdirSync(dirname(d), { recursive: true }); writeFileSync(d, c); };
  w('.quality-kernel/tools.json', JSON.stringify({ verify: 'node --test x.test.mjs', productionGlobs: ['src/**'] }));
  w('.quality-kernel/critical-surface.json', JSON.stringify({ criticalGlobs: ['**/auth/**'], safeGlobs: ['**/*.md'] }));
  w('x.test.mjs', "import { test } from 'node:test'; import a from 'node:assert'; test('ok', () => a.ok(true));");
  w('src/auth/thing.ts', 'export const x = 1;');
  git('add', '-A'); git('commit', '-qm', 'base'); const base = git('rev-parse', 'HEAD').stdout.trim();
  w('src/auth/thing.ts', 'export const x = 2;');
  w('x.test.mjs', "import { test } from 'node:test'; import a from 'node:assert'; test('ok', () => a.ok(true)); test('extra', () => a.ok(true));");
  git('add', '-A'); git('commit', '-qm', 'change'); const head = git('rev-parse', 'HEAD').stdout.trim();
  return { tmp, base, head };
}
test('breaker-gate (RED) — a PASSing breaker does NOT clear the human-review cause of exit 3', () => {
  const { tmp, base, head } = testChangeRepo(); const s = stub('BREAKER_PASS');
  try {
    const r = run(tmp, base, head, ['--breaker', s.cmd, '--contract', contract, '--probe', 'true', '--url', 'http://x']);
    const v = json(r);
    assert.strictEqual(v.refereeGate.requiresHumanReview, true, 'the referee overlaid a changed test file');
    assert.strictEqual(r.status, 3, 'a test change is a contract change: the human still owns it');
    assert.strictEqual(v.gate, 'blocked-needs-human-review');
  } finally { [tmp, s.tmp].forEach((d) => rmSync(d, { recursive: true, force: true })); }
});

// Carried major #1 (design.md "## 2. The 6 carried majors → tests"): "referee gate" is not a
// behavior this contract defines — this documents the pass-through shape breaker-gate.mjs already
// has: `refereeGate` is qk-gate.mjs's own parsed JSON verdict, verbatim, never reshaped.
test('breaker-gate (carried major #1) — refereeGate is qk-gate.mjs\'s own verdict, passed through verbatim', () => {
  const { tmp, base, head } = criticalRepo();
  try {
    const r = run(tmp, base, head); // no --breaker: qk-gate's own exit 3, no breaker invoked
    const gReferee = spawnSync('node', [join(here, 'qk-gate.mjs'), '--repo', tmp, '--base', base, '--head', head], { encoding: 'utf8' });
    const expected = JSON.parse((gReferee.stdout || '').trim().split('\n').filter(Boolean).pop());
    assert.deepStrictEqual(json(r).refereeGate, expected);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// --- EARS-M1-M5: the breaker-not-executed record (specs/qk-breaker-robust-input/spec.md §1.3) ---

test('breaker-gate (EARS-M1) — an INSTRUMENT-BROKEN verdict writes the record atomically and exits 2', () => {
  const { tmp, base, head } = criticalRepo();
  const s = stubJson({ verdict: 'INSTRUMENT-BROKEN', reason: 'vectors must be a non-empty array', executed: 0, vectors: [] });
  try {
    const r = run(tmp, base, head, ['--breaker', s.cmd, '--contract', contract, '--probe', 'true', '--url', 'http://x']);
    assert.strictEqual(r.status, 2);
    assert.ok(existsSync(notExecutedPath(tmp)));
    const rec = JSON.parse(readFileSync(notExecutedPath(tmp), 'utf8'));
    assert.strictEqual(rec.schemaVersion, 1);
    assert.strictEqual(rec.verdict, 'INSTRUMENT-BROKEN');
    assert.strictEqual(rec.reason, 'vectors must be a non-empty array');
    assert.strictEqual(rec.contract, contract);
    assert.strictEqual(rec.executed, 0);
    assert.ok(typeof rec.ts === 'string' && !Number.isNaN(Date.parse(rec.ts)));
  } finally { [tmp, s.tmp].forEach((d) => rmSync(d, { recursive: true, force: true })); }
});

// EARS-M6 end to end: the breaker command itself cannot run (no stub — a genuinely nonexistent
// command), so breaker-invoke.mjs's nested verdict is INSTRUMENT-BROKEN, not BREAKER_INDETERMINATE.
// breaker-gate.mjs's own exit code must stay exactly what it is today for this case (2); only the
// nested verdict — and therefore whether the breaker-not-executed record is written — changes.
test('breaker-gate (EARS-M6, end to end) — a nonexistent --breaker command writes the breaker-not-executed record, same exit code as today', () => {
  const { tmp, base, head } = criticalRepo();
  try {
    assert.ok(!existsSync(notExecutedPath(tmp)), 'precondition: no stale record');
    const r = run(tmp, base, head, ['--breaker', 'this-command-does-not-exist-xyz', '--contract', contract, '--probe', 'true', '--url', 'http://x']);
    assert.strictEqual(r.status, 2, 'exit code unchanged from today');
    assert.strictEqual(json(r).gate, 'breaker-indeterminate', 'gate field unchanged from today (default-deny)');
    assert.ok(existsSync(notExecutedPath(tmp)), 'EARS-M1: the record is written, not skipped, for a breaker that could not run');
    const rec = JSON.parse(readFileSync(notExecutedPath(tmp), 'utf8'));
    assert.strictEqual(rec.verdict, 'INSTRUMENT-BROKEN');
    assert.match(rec.reason, /breaker exited/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('breaker-gate (EARS-M3) — a later BREAKER_INDETERMINATE verdict clears the stale record (exit code still 2)', () => {
  const { tmp, base, head } = criticalRepo();
  const broken = stubJson({ verdict: 'INSTRUMENT-BROKEN', reason: 'x', executed: 0, vectors: [] });
  const indet = stubJson({ verdict: 'BREAKER_INDETERMINATE', executed: 2, vectors: [{ result: 'HOLDS' }, { result: 'HOLDS' }] });
  try {
    run(tmp, base, head, ['--breaker', broken.cmd, '--contract', contract, '--probe', 'true', '--url', 'http://x']);
    assert.ok(existsSync(notExecutedPath(tmp)), 'precondition: the stale record exists');
    const r = run(tmp, base, head, ['--breaker', indet.cmd, '--contract', contract, '--probe', 'true', '--url', 'http://x']);
    assert.strictEqual(r.status, 2);
    assert.strictEqual(json(r).gate, 'breaker-indeterminate');
    assert.ok(!existsSync(notExecutedPath(tmp)), 'EARS-M3: the nested verdict is no longer INSTRUMENT-BROKEN, so the record is removed');
  } finally { [tmp, broken.tmp, indet.tmp].forEach((d) => rmSync(d, { recursive: true, force: true })); }
});

test('breaker-gate (EARS-M3) — a later passing breaker clears the stale record and exits 0', () => {
  const { tmp, base, head } = criticalRepo();
  const broken = stubJson({ verdict: 'INSTRUMENT-BROKEN', reason: 'x', executed: 0, vectors: [] });
  const pass = stubJson({ verdict: 'BREAKER_PASS', executed: 3, vectors: [{ result: 'HOLDS' }, { result: 'HOLDS' }, { result: 'HOLDS' }] });
  try {
    run(tmp, base, head, ['--breaker', broken.cmd, '--contract', contract, '--probe', 'true', '--url', 'http://x']);
    assert.ok(existsSync(notExecutedPath(tmp)));
    const r = run(tmp, base, head, ['--breaker', pass.cmd, '--contract', contract, '--probe', 'true', '--url', 'http://x']);
    assert.strictEqual(r.status, 0);
    assert.ok(!existsSync(notExecutedPath(tmp)));
  } finally { [tmp, broken.tmp, pass.tmp].forEach((d) => rmSync(d, { recursive: true, force: true })); }
});

test('breaker-gate (EARS-M4) — a pre-seeded malformed record never affects the gate decision, and is removed on PASS', () => {
  const { tmp, base, head } = criticalRepo();
  mkdirSync(join(tmp, '.quality-kernel'), { recursive: true });
  writeFileSync(notExecutedPath(tmp), '{not valid json');
  const pass = stubJson({ verdict: 'BREAKER_PASS', executed: 3, vectors: [{ result: 'HOLDS' }, { result: 'HOLDS' }, { result: 'HOLDS' }] });
  try {
    const r = run(tmp, base, head, ['--breaker', pass.cmd, '--contract', contract, '--probe', 'true', '--url', 'http://x']);
    assert.strictEqual(r.status, 0, 'unaffected by the file\'s prior malformed content');
    assert.ok(!existsSync(notExecutedPath(tmp)));
  } finally { [tmp, pass.tmp].forEach((d) => rmSync(d, { recursive: true, force: true })); }
});

// Panel finding (LOW, breaker-gate.test.mjs:163): chmod 0o555 denies writes only for a non-root
// user — running as root (common in CI containers), chmod-based permission denial has no effect,
// so writeFileSync would silently succeed and this test would pass without ever exercising the
// write-failure path it claims to cover. Skip with a clear reason rather than false-passing.
const runningAsRoot = typeof process.getuid === 'function' && process.getuid() === 0;
test('breaker-gate (EARS-M5) — a write failure never changes the exit code and is reported on stderr, not thrown', { skip: runningAsRoot && 'running as root: chmod 0o555 does not deny root writes, so this test cannot exercise a real write failure here' }, () => {
  const { tmp, base, head } = criticalRepo();
  mkdirSync(join(tmp, '.quality-kernel'), { recursive: true });
  chmodSync(join(tmp, '.quality-kernel'), 0o555);
  const broken = stubJson({ verdict: 'INSTRUMENT-BROKEN', reason: 'x', executed: 0, vectors: [] });
  try {
    const r = run(tmp, base, head, ['--breaker', broken.cmd, '--contract', contract, '--probe', 'true', '--url', 'http://x']);
    assert.strictEqual(r.status, 2, 'same exit code as the writable-directory case');
    assert.match(r.stderr, /breaker-not-executed/);
    assert.strictEqual(r.signal, null, 'did not crash on an uncaught exception');
  } finally { chmodSync(join(tmp, '.quality-kernel'), 0o755); rmSync(tmp, { recursive: true, force: true }); rmSync(broken.tmp, { recursive: true, force: true }); }
});

test('syncNotExecutedRecord (EARS-M1, crash before rename) — an interruption between the temp write and the rename leaves the target untouched, never truncated', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'qk-bgate-crash-'));
  try {
    const target = notExecutedPath(tmp);
    mkdirSync(join(tmp, '.quality-kernel'), { recursive: true });
    writeFileSync(target, JSON.stringify({ schemaVersion: 1, verdict: 'INSTRUMENT-BROKEN', reason: 'prior', executed: 0 }));
    const priorContents = readFileSync(target, 'utf8');

    // Simulate a crash landing exactly between the temp-file write and the rename: the temp file is
    // written for real (so a genuinely non-atomic "write the final path in place" implementation
    // would already have corrupted `target` by this point), then `rename` throws instead of
    // completing. EARS-M5 catches and swallows this (never rethrows, never changes the exit code);
    // this test asserts the ONE guarantee the Gherkin scenario names: target is either absent, or
    // exactly its prior complete contents, or the new complete contents — never truncated or invalid.
    syncNotExecutedRecord(tmp, { verdict: 'INSTRUMENT-BROKEN', reason: 'new', executed: 5 }, 'c.md', {
      rename: () => { throw new Error('simulated crash before rename completes'); },
    });
    assert.strictEqual(readFileSync(target, 'utf8'), priorContents, 'never partially overwritten in place');
    JSON.parse(readFileSync(target, 'utf8')); // throws if truncated/invalid
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// --- panel finding (MEDIUM, breaker-gate.mjs:36): a rename() failure AFTER write() already
// created the temp file orphans it permanently — nothing else in the codebase sweeps stray
// `.quality-kernel/breaker-not-executed.json.<pid>-<hex>.tmp` files. ---
test('syncNotExecutedRecord (EARS-M5, orphan cleanup, RED) — a rename failure unlinks the orphaned temp file', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'qk-bgate-orphan-'));
  try {
    mkdirSync(join(tmp, '.quality-kernel'), { recursive: true });
    let capturedTmpPath = null;
    syncNotExecutedRecord(tmp, { verdict: 'INSTRUMENT-BROKEN', reason: 'x', executed: 0 }, 'c.md', {
      write: (p, data) => { capturedTmpPath = p; writeFileSync(p, data); }, // real write, so the temp file genuinely exists on disk
      rename: () => { throw new Error('simulated rename failure'); },
    });
    assert.ok(capturedTmpPath, 'precondition: write() was called with a temp path');
    assert.ok(!existsSync(capturedTmpPath), `orphaned temp file must be cleaned up on rename failure: ${capturedTmpPath}`);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// --- review item A: EARS-M1 says the system SHALL create <repo>/.quality-kernel/ if it does not
// exist. Every other test above pre-creates the dir (criticalRepo()'s w() calls mkdirSync for
// tools.json); this is the first test that calls syncNotExecutedRecord against a repo where
// `.quality-kernel/` genuinely does not exist yet, so a missing mkdir would ENOENT on write(),
// be swallowed by EARS-M5's catch, and leave the record never written. ---
test('syncNotExecutedRecord (EARS-M1, RED) — creates .quality-kernel/ when it does not exist yet, then writes the record', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'qk-bgate-nodir-'));
  try {
    const dir = join(tmp, '.quality-kernel');
    assert.ok(!existsSync(dir), 'precondition: the dir does not exist yet');
    syncNotExecutedRecord(tmp, { verdict: 'INSTRUMENT-BROKEN', reason: 'vectors must be a non-empty array', executed: 0 }, 'c.md');
    assert.ok(existsSync(dir), 'EARS-M1: the dir must be created');
    assert.ok(existsSync(notExecutedPath(tmp)));
    const rec = JSON.parse(readFileSync(notExecutedPath(tmp), 'utf8'));
    assert.strictEqual(rec.schemaVersion, 1);
    assert.strictEqual(rec.verdict, 'INSTRUMENT-BROKEN');
    assert.strictEqual(rec.reason, 'vectors must be a non-empty array');
    assert.strictEqual(rec.contract, 'c.md');
    assert.strictEqual(rec.executed, 0);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('syncNotExecutedRecord (EARS-M5) — a directory-creation failure is swallowed, never thrown, never writes the record', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'qk-bgate-mkdirfail-'));
  try {
    assert.doesNotThrow(() => {
      syncNotExecutedRecord(tmp, { verdict: 'INSTRUMENT-BROKEN', reason: 'x', executed: 0 }, 'c.md', {
        mkdir: () => { throw new Error('simulated mkdir failure'); },
      });
    });
    assert.ok(!existsSync(notExecutedPath(tmp)));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('breaker-gate (EARS-M1, concurrency) — two concurrent runs never collide; the record ends up valid, never byte-interleaved', async () => {
  const { tmp, base, head } = criticalRepo();
  const broken = stubJson({ verdict: 'INSTRUMENT-BROKEN', reason: 'concurrent', executed: 0, vectors: [] });
  try {
    // A real, non-blocking spawn (not spawnSync) so both processes genuinely overlap, matching the
    // Gherkin's `&`/`wait` shell recipe — spawnSync would serialize the two runs and prove nothing.
    const launch = () => new Promise((resolve) => {
      const child = spawn('node', [gate, '--repo', tmp, '--base', base, '--head', head, '--breaker', broken.cmd, '--contract', contract, '--probe', 'true', '--url', 'http://x']);
      child.on('close', () => resolve());
    });
    await Promise.all([launch(), launch()]);
    assert.ok(existsSync(notExecutedPath(tmp)));
    const rec = JSON.parse(readFileSync(notExecutedPath(tmp), 'utf8')); // throws if byte-interleaved/invalid
    assert.strictEqual(rec.verdict, 'INSTRUMENT-BROKEN');
  } finally { [tmp, broken.tmp].forEach((d) => rmSync(d, { recursive: true, force: true })); }
});
