import './hermetic-git.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import {
  KILL_GRACE_MS, DEFAULT_TIMEOUT_SECONDS, resolveTimeoutSeconds, unsupportedPlatformReason,
  newRunId, killGroup, groupAlive, sweepByMarker, procfsPidsCarrying, createRunner, installCleanup,
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

// --- hardening: survivors of the mutation run (each names the production harm it guards against) ---
const IGNORE_TERM = `"${process.execPath}" -e "process.on('SIGTERM',()=>{});setTimeout(()=>{},60000)"`;
const pidIn = async (f) => { await waitFor(() => { try { return readFileSync(f, 'utf8').trim(); } catch { return ''; } }); return Number(readFileSync(f, 'utf8').trim()); };
const foreignGroup = () => {
  if (process.getuid() === 0) return null;
  const rows = spawnSync('ps', ['-axo', 'pid=,pgid=,user='], { encoding: 'utf8' }).stdout.split('\n').map((l) => l.trim().split(/\s+/));
  const row = rows.find(([pid, pgid, user]) => user === 'root' && pid === pgid && Number(pid) > 1);
  return row ? Number(row[0]) : null;
};

test('killGroup surfaces EPERM and groupAlive reports a foreign group as alive (signal 0 only)', { skip: foreignGroup() === null && 'no foreign process group visible' }, () => {
  // harm: swallowing EPERM hides a failed kill; reporting it dead ends the SIGTERM grace early
  const g = foreignGroup();
  assert.throws(() => killGroup(g, 0), { code: 'EPERM' });
  assert.strictEqual(groupAlive(g), true);
});

test('PT-A6 — sweepByMarker uses SIGKILL: a SIGTERM-ignoring marker carrier dies', async () => {
  const id = newRunId(); const m = mark();
  const c = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});console.log('r');setTimeout(()=>{},60000)", m], { detached: true, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, QK_RUN_ID: id } });
  await new Promise((r) => c.stdout.once('data', r));
  sweepByMarker(id);
  assert.ok(await waitFor(() => !isAlive(c.pid), { timeoutMs: 3000 }));
});

test('PT-A6 — sweepByMarker never kills the calling process even when it carries the marker', () => {
  // harm: a nested gate run (launched under the stale run's marker) would SIGKILL itself mid-takeover
  const id = newRunId();
  const code = `import { sweepByMarker } from ${JSON.stringify(pathToFileURL(join(here, 'process-safety', 'proc-tree.mjs')).href)}; sweepByMarker(process.env.QK_RUN_ID); console.log('alive');`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env: { ...process.env, QK_RUN_ID: id } });
  assert.deepStrictEqual([r.status, r.signal, r.stdout.trim()], [0, null, 'alive']);
});

const fakeProc = () => {
  const p = new EventEmitter(); p.exits = []; p.err = '';
  p.exit = (c) => { p.exits.push(c); }; p.stderr = { write: (s) => { p.err += s; } };
  return p;
};
test('PT-A9 — SIGINT/SIGTERM/SIGHUP run the cleanup once and exit 130/143/129', () => {
  for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
    const proc = fakeProc(); let n = 0;
    installCleanup({ cleanup: () => { n++; }, proc });
    proc.emit(sig); proc.emit('exit');
    assert.deepStrictEqual([n, proc.exits], [1, [code]], sig);
  }
});
test('PT-A9 — a normal exit runs the cleanup', () => {
  const proc = fakeProc(); let n = 0;
  installCleanup({ cleanup: () => { n++; }, proc });
  proc.emit('exit');
  assert.strictEqual(n, 1);
});
test('PT-A10 — an uncaught exception runs the cleanup, prints the stack, reports it and exits 2', () => {
  const proc = fakeProc(); let n = 0; const fatal = [];
  installCleanup({ cleanup: () => { n++; }, onFatal: (e) => fatal.push(e), proc });
  const err = new Error('boom');
  proc.emit('uncaughtException', err); proc.emit('exit');
  assert.deepStrictEqual([n, proc.exits, fatal], [1, [2], [err]]);
  assert.strictEqual(proc.err, `${err.stack}\n`);
  const plain = fakeProc();
  installCleanup({ cleanup: () => {}, proc: plain });
  plain.emit('uncaughtException', 'plain failure');
  assert.strictEqual(plain.err, 'plain failure\n', 'a thrown non-Error is printed as is');
});

test('commands get no stdin (EOF at once): a command reading stdin does not hang until the timeout', async () => {
  // harm: a prompting command (npm init, git credential) blocks the gate for the whole budget
  const r = mkRunner({ timeoutMs: 4000 });
  const out = await r.run('cat', tmpdir());
  assert.deepStrictEqual([out.timedOut, out.code], [false, 0]);
});

test('a spawn that throws synchronously resolves with the error (never rejects)', async () => {
  const out = await mkRunner().run('exit 0', 123);
  assert.ok(out.error instanceof Error, JSON.stringify(out));
  assert.strictEqual(out.code, null);
});

test('a spawn that fails asynchronously (missing cwd) resolves with the error and registers no group', async () => {
  // harm: persisting an undefined pgid into the lock, or a result with no error for a command that never ran
  const seen = []; const r = mkRunner({ onGroup: (g) => seen.push(g) });
  const out = await r.run('exit 0', join(tmpdir(), 'qk-no-such-dir', 'x'));
  assert.strictEqual(out.error && out.error.code, 'ENOENT');
  assert.deepStrictEqual(seen, []);
});

test('Decision 18 — if the group cannot be persisted the command is killed and the error returned', async () => {
  // harm: an unrecorded group would escape the takeover after a crash; the command must not run on
  const dir = scratch(); const f = join(dir, 'ran');
  try {
    const r = mkRunner({ onGroup: () => { throw new Error('persist failed'); } });
    const out = await r.run(`sleep 0.3; touch ${f}`, dir);
    assert.strictEqual(out.error && out.error.message, 'persist failed');
    await new Promise((res) => setTimeout(res, 600));
    assert.deepStrictEqual(readdirSync(dir), [], 'the command must have been killed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('PT-A4 — at command end the group gets SIGKILL: a scrubbed SIGTERM-ignoring straggler dies', async () => {
  const dir = scratch(); const pf = join(dir, 'pid'); let pid;
  try {
    const out = await mkRunner().run(`env -i ${IGNORE_TERM} & echo $! > ${pf}; sleep 0.4; exit 0`, dir);
    assert.strictEqual(out.code, 0);
    pid = await pidIn(pf);
    assert.ok(await waitFor(() => !isAlive(pid), { timeoutMs: 3000 }), 'scrubbed SIGTERM-ignorer must be dead');
  } finally { if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } rmSync(dir, { recursive: true, force: true }); }
});

test('PT-A2 — after the grace the group gets SIGKILL: a scrubbed SIGTERM-ignoring member dies', async () => {
  const dir = scratch(); const pf = join(dir, 'pid'); let pid;
  try {
    const out = await mkRunner({ timeoutMs: 600, graceMs: 300 }).run(`env -i ${IGNORE_TERM} & echo $! > ${pf}; wait`, dir);
    assert.strictEqual(out.timedOut, true);
    pid = await pidIn(pf);
    assert.ok(await waitFor(() => !isAlive(pid), { timeoutMs: 3000 }), 'scrubbed SIGTERM-ignorer must be dead');
  } finally { if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } rmSync(dir, { recursive: true, force: true }); }
});

test('PT-C14 — onGroupEnd reports the command group once it has been reaped, on success and on timeout', async () => {
  for (const [cmd, timeoutMs] of [['true', 60000], ['sleep 30', 300]]) {
    const events = []; const m = mkRunner({ timeoutMs, graceMs: 200, onGroup: (g) => events.push(['start', g]), onGroupEnd: (g) => events.push(['end', g, groupAlive(g)]) });
    await m.run(cmd, tmpdir());
    assert.strictEqual(events.length, 2, JSON.stringify(events));
    assert.strictEqual(events[0][0], 'start');
    assert.deepStrictEqual(events[1], ['end', events[0][1], false], 'reported after the group is dead');
  }
});
