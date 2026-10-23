import './hermetic-git.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  KILL_GRACE_MS, DEFAULT_TIMEOUT_SECONDS, resolveTimeoutSeconds, unsupportedPlatformReason,
  newRunId, killGroup, groupAlive, sweepByMarker, procfsPidsCarrying, createRunner,
} from './process-safety/proc-tree.mjs';
import { newMarker, pgrepMarker, pkillMarker, isAlive, waitFor, markedSleep } from './proc-test-kit.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const markers = [];
const mark = () => { const m = newMarker(); markers.push(m); return m; };
after(() => { for (const m of markers) pkillMarker(m); });
const scratch = () => mkdtempSync(join(tmpdir(), 'qk-pt-'));
const mkRunner = (over = {}) => {
  const runId = newRunId();
  return { runId, ...createRunner({ runId, env: { ...process.env, QK_RUN_ID: runId }, timeoutMs: 60000, ...over }) };
};

// --- PT-B1 / PT-B2 / PT-B3 (pure) ---
test('PT-B1 — absent timeoutSeconds resolves to the 300 s default', () => {
  assert.strictEqual(DEFAULT_TIMEOUT_SECONDS, 300);
  assert.deepStrictEqual(resolveTimeoutSeconds({ verify: 'x' }), { seconds: 300 });
});
test('PT-B2 — an integer from 1 to 3600 is applied unchanged', () => {
  for (const v of [1, 2, 300, 3599, 3600]) assert.deepStrictEqual(resolveTimeoutSeconds({ timeoutSeconds: v }), { seconds: v });
});
test('PT-B3 — present but invalid timeoutSeconds is an error naming the field, never clamped or defaulted', () => {
  for (const v of [null, 0, -1, 1.5, '5', true, false, 3601, 99999, [], {}, Number.MAX_SAFE_INTEGER]) {
    const r = resolveTimeoutSeconds({ timeoutSeconds: v });
    assert.match(r.error, /timeoutSeconds/, `value ${JSON.stringify(v)}`);
    assert.strictEqual(r.seconds, undefined, `value ${JSON.stringify(v)} must not resolve to a number`);
  }
});

// --- PT-A14 (pure) ---
test('PT-A14 — win32 is unsupported and the reason names the platform; POSIX platforms pass', () => {
  assert.match(unsupportedPlatformReason('win32'), /win32/);
  assert.strictEqual(unsupportedPlatformReason('darwin'), null);
  assert.strictEqual(unsupportedPlatformReason('linux'), null);
});

// --- PT-A7 ---
test('PT-A7 — run ids are 16 lowercase hex chars and differ between runs', () => {
  const ids = new Set(Array.from({ length: 50 }, newRunId));
  assert.strictEqual(ids.size, 50);
  for (const id of ids) assert.match(id, /^[0-9a-f]{16}$/);
});

test('killGroup swallows ESRCH for a group that does not exist', () => {
  assert.doesNotThrow(() => killGroup(2 ** 22 - 3, 'SIGKILL'));
  assert.strictEqual(groupAlive(2 ** 22 - 3), false);
});

// --- runner: PT-A1..A5, A8, D4/D5 inputs ---
test('PT-A1/A3 — a timed-out command: whole group gets SIGTERM, result is timedOut', async () => {
  const m = mark(); const r = mkRunner({ timeoutMs: 400 });
  const out = await r.run(`${markedSleep(m)} & wait`, tmpdir());
  assert.strictEqual(out.timedOut, true);
  assert.deepStrictEqual(pgrepMarker(m), [], 'grandchild must be gone when run() resolves');
});

test('PT-A2 — a SIGTERM-ignoring member survives the grace and is SIGKILLed after it', async () => {
  const m = mark(); const r = mkRunner({ timeoutMs: 300, graceMs: 1500 });
  const ignore = `node -e "process.on('SIGTERM',()=>{});setTimeout(()=>{},60000)" ${m}`;
  const t0 = Date.now();
  const out = await r.run(`${ignore} & wait`, tmpdir());
  const elapsed = Date.now() - t0;
  assert.strictEqual(out.timedOut, true);
  assert.ok(elapsed >= 300 + 1500 - 50, `grace must be honored, elapsed ${elapsed}`);
  assert.ok(elapsed < 300 + 1500 + 3000, `forced kill must follow the grace, elapsed ${elapsed}`);
  assert.deepStrictEqual(pgrepMarker(m), []);
});

test('PT-A2 — the default grace is 5000 ms', () => { assert.strictEqual(KILL_GRACE_MS, 5000); });

test('PT-A3 — exiting 0 during the grace period is still a timeout', async () => {
  const r = mkRunner({ timeoutMs: 300 });
  const out = await r.run(`trap 'exit 0' TERM; sleep 30 & wait`, tmpdir());
  assert.strictEqual(out.timedOut, true);
});

test('PT-A4/A5 — a straggler holding stdout is killed at command end and does not delay the result', async () => {
  const m = mark(); const r = mkRunner();
  const t0 = Date.now();
  const out = await r.run(`${markedSleep(m)} & exit 0`, tmpdir());
  assert.ok(Date.now() - t0 < 8000, 'must not wait for the straggler to release stdout');
  assert.strictEqual(out.code, 0);
  assert.strictEqual(out.timedOut, false);
  assert.deepStrictEqual(pgrepMarker(m), [], 'straggler must be dead when run() resolves');
});

test('PT-A4 — stragglers die even when the command fails', async () => {
  const m = mark(); const r = mkRunner();
  const out = await r.run(`${markedSleep(m)} & exit 3`, tmpdir());
  assert.strictEqual(out.code, 3);
  assert.deepStrictEqual(pgrepMarker(m), []);
});

test('PT-A4 — the group kill reaches a straggler that scrubbed the marker (no env fallback)', async () => {
  const dir = scratch(); const pf = join(dir, 'pid'); const r = mkRunner();
  try {
    const out = await r.run(`env -i /bin/sleep 60 & echo $! > ${pf}; exit 0`, dir);
    assert.strictEqual(out.code, 0);
    const pid = Number(readFileSync(pf, 'utf8').trim());
    assert.ok(await waitFor(() => !isAlive(pid), { timeoutMs: 3000 }), 'scrubbed straggler must be dead');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('PT-A6 — a descendant in its own session is killed through the run marker', async () => {
  const m = mark(); const r = mkRunner();
  const escape = `node -e "require('child_process').spawn('node',['-e','setTimeout(()=>{},60000)','${m}'],{detached:true,stdio:'ignore'}).unref()"`;
  const out = await r.run(`${escape}; exit 0`, tmpdir());
  assert.strictEqual(out.code, 0);
  assert.deepStrictEqual(await waitFor(() => pgrepMarker(m).length === 0, { timeoutMs: 3000 }), true);
});

test('PT-A6 — sweepByMarker kills marker carriers and spares processes without the marker', async () => {
  const id = newRunId(); const m = mark(); const control = mark();
  const sp = (extraEnv, tag) => spawn('node', ['-e', 'setTimeout(()=>{},60000)', tag], { detached: true, stdio: 'ignore', env: { ...process.env, ...extraEnv } });
  const marked = sp({ QK_RUN_ID: id }, m); const other = sp({ QK_RUN_ID: newRunId() }, control);
  marked.unref(); other.unref();
  assert.ok(await waitFor(() => isAlive(marked.pid) && isAlive(other.pid)));
  sweepByMarker(id);
  assert.ok(await waitFor(() => !isAlive(marked.pid)), 'marker carrier must die');
  assert.ok(isAlive(other.pid), 'a process with another run id must be untouched');
  process.kill(other.pid, 'SIGKILL');
});

test('PT-A7 — every command of one runner sees the same QK_RUN_ID and no other marker source', async () => {
  const dir = scratch(); const r = mkRunner(); const f = join(dir, 'ids');
  try {
    for (let i = 0; i < 3; i++) await r.run(`printf '%s\\n' "$QK_RUN_ID" >> ${f}`, dir);
    assert.deepStrictEqual(readFileSync(f, 'utf8').trim().split('\n'), [r.runId, r.runId, r.runId]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('PT-A8 — 3 MiB on stdout, stderr or both never produces an error', async () => {
  const r = mkRunner();
  const big = (s) => `node -e "process.${s}.write('x'.repeat(3145728))"`;
  for (const cmd of [big('stdout'), big('stderr'), `${big('stdout')}; ${big('stderr')}`]) {
    const out = await r.run(cmd, tmpdir());
    assert.strictEqual(out.error, undefined);
    assert.strictEqual(out.code, 0);
  }
  assert.strictEqual((await r.run(`${big('stdout')}; exit 3`, tmpdir())).code, 3);
});

test('PT-D4 input — hasStdout reports non-whitespace stdout even after >1 MiB, and false for empty', async () => {
  const r = mkRunner();
  assert.strictEqual((await r.run('exit 127', tmpdir())).hasStdout, false);
  assert.strictEqual((await r.run('printf "  \\n"; exit 127', tmpdir())).hasStdout, false);
  assert.strictEqual((await r.run(`node -e "process.stdout.write('x'.repeat(3145728))"; exit 127`, tmpdir())).hasStdout, true);
});

test('PT-D5 input — a command killed by an external signal has no exit code and is not a timeout', async () => {
  const r = mkRunner();
  const out = await r.run('kill -9 $$', tmpdir());
  assert.strictEqual(out.code, null);
  assert.strictEqual(out.signal, 'SIGKILL');
  assert.strictEqual(out.timedOut, false);
});

test('PT-C4 input — onGroup receives the process group of every command at spawn time', async () => {
  const seen = []; const r = mkRunner({ onGroup: (g) => seen.push(g) });
  await r.run('exit 0', tmpdir()); await r.run('exit 0', tmpdir());
  assert.strictEqual(seen.length, 2);
  for (const g of seen) assert.ok(Number.isInteger(g) && g > 1);
  assert.notStrictEqual(seen[0], seen[1]);
});

test('PT-A9 input — killAll kills every live group', async () => {
  const m = mark(); const r = mkRunner();
  const p = r.run(`${markedSleep(m)} & wait`, tmpdir());
  assert.ok(await waitFor(() => pgrepMarker(m).length > 0));
  r.killAll('SIGKILL');
  await p;
  assert.deepStrictEqual(await waitFor(() => pgrepMarker(m).length === 0), true);
});

// --- PT-A10: code-level fault injection ---
test('PT-A10 — an uncaught exception kills every live tree and releases the lock before exiting', async () => {
  const dir = scratch(); const lockDir = join(dir, 'locks'); const repo = join(dir, 'repo'); const m = mark();
  mkdirSync(lockDir); mkdirSync(repo);
  spawnSync('git', ['-C', repo, 'init', '-q']);
  const url = (f) => JSON.stringify(pathToFileURL(join(here, f)).href);
  const script = join(dir, 'inject.mjs');
  writeFileSync(script, `
import { createRunner, installCleanup, newRunId } from ${url('process-safety/proc-tree.mjs')};
import { acquireLock } from ${url('process-safety/gate-lock.mjs')};
const runId = newRunId();
const got = acquireLock({ repo: ${JSON.stringify(repo)}, runId, dir: ${JSON.stringify(lockDir)} });
const runner = createRunner({ runId, env: { ...process.env, QK_RUN_ID: runId }, timeoutMs: 60000, onGroup: (g) => got.lock.addPgid(g) });
installCleanup({ cleanup: () => { runner.killAll('SIGKILL'); got.lock.release(); } });
runner.run(${JSON.stringify(`${markedSleep(m)} & wait`)}, ${JSON.stringify(dir)});
setTimeout(() => { throw new Error('injected fault'); }, 1500);
`);
  try {
    const child = spawn('node', [script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = ''; child.stderr.on('data', (d) => { err += d; });
    assert.ok(await waitFor(() => pgrepMarker(m).length > 0, { timeoutMs: 4000 }), 'grandchild must start');
    const code = await new Promise((res) => child.on('exit', (c) => res(c)));
    assert.notStrictEqual(code, 0, `exit code ${code}`);
    assert.match(err, /injected fault/);
    assert.deepStrictEqual(await waitFor(() => pgrepMarker(m).length === 0, { timeoutMs: 3000 }), true, 'tree must be dead');
    assert.deepStrictEqual(readdirSync(lockDir), [], 'lock must be released');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('procfsPidsCarrying (Linux branch) matches numeric entries whose environ carries the needle, skipping unreadable ones', () => {
  const root = mkdtempSync(join(tmpdir(), 'qkpt-procfs-'));
  try {
    for (const [name, environ] of [['101', 'A=1\0QK_RUN_ID=abc\0'], ['202', 'A=1\0'], ['self', 'QK_RUN_ID=abc\0']]) {
      mkdirSync(join(root, name));
      writeFileSync(join(root, name, 'environ'), environ);
    }
    mkdirSync(join(root, '303')); // numeric entry without an environ file: gone or not ours
    assert.deepStrictEqual(procfsPidsCarrying('QK_RUN_ID=abc', root), [101]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
