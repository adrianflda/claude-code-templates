import './hermetic-git.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync, rmSync, symlinkSync, unlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { lockPathFor, processStart, classifyLock, acquireLock } from './process-safety/gate-lock.mjs';
import { newRunId } from './process-safety/proc-tree.mjs';
import { snapshotTable } from './process-safety/proc-descendants.mjs';
import { takeOverStale } from './process-safety/lock-takeover.mjs';
import { newMarker, pgrepMarker, pkillMarker, isAlive, waitFor, markedSleep } from './proc-test-kit.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const markers = []; const dirs = []; const kids = [];
const mark = () => { const m = newMarker(); markers.push(m); return m; };
after(() => { for (const m of markers) pkillMarker(m); for (const k of kids) { try { process.kill(k, 'SIGKILL'); } catch { /* gone */ } } for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const scratch = () => { const d = mkdtempSync(join(tmpdir(), 'qk-lk-')); dirs.push(d); return d; };
const mkRepo = () => {
  const repo = scratch(); const git = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  writeFileSync(join(repo, 'a'), '1'); git('add', '-A'); git('commit', '-qm', 'c');
  return { repo, git };
};
const deadPid = () => { const r = spawnSync('node', ['-e', '0']); return r.pid; };
const lockFiles = (dir) => readdirSync(dir).filter((f) => /^qk-gate-.*\.lock$/.test(f));
const longSleep = (detached = true) => { const c = spawn('sleep', ['60'], { detached, stdio: 'ignore' }); c.unref(); kids.push(c.pid); return c.pid; };

test('PT-C2 — every worktree of one repository maps to the same lock; another repository does not', () => {
  const { repo, git } = mkRepo(); const wt = join(scratch(), 'wt'); const dir = scratch();
  git('worktree', 'add', '-q', wt, '-b', 'other');
  const other = mkRepo().repo;
  const a = lockPathFor(repo, dir), b = lockPathFor(wt, dir), c = lockPathFor(other, dir);
  assert.match(a, new RegExp(`^${dir.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}/qk-gate-[0-9a-f]+\\.lock$`));
  assert.strictEqual(a, b);
  assert.notStrictEqual(a, c);
});

test('processStart — a live pid has a stable start time, a dead pid has none', () => {
  const s = processStart(process.pid);
  assert.ok(typeof s === 'string' && s.length > 5, `lstart ${s}`);
  assert.strictEqual(processStart(process.pid), s);
  assert.strictEqual(processStart(deadPid()), null);
});

test('PT-C3/C4/C5 — lock staleness: live, dead pid, and PID reuse via lstart', () => {
  const lstart = processStart(process.pid);
  assert.strictEqual(classifyLock({ pid: process.pid, lstart }), 'live');
  assert.strictEqual(classifyLock({ pid: deadPid(), lstart }), 'stale');
  assert.strictEqual(classifyLock({ pid: process.pid, lstart: 'Thu Jan  1 00:00:00 1970' }), 'stale');
  assert.strictEqual(classifyLock({ pid: process.pid, lstart: null }), 'live', 'no recorded start time: pid liveness decides');
});

test('PT-C2/C7 — acquire writes {pid, lstart, runId, repo, pgids[]}; release empties the directory', () => {
  const { repo } = mkRepo(); const dir = scratch(); const runId = newRunId();
  const got = acquireLock({ repo, runId, dir });
  assert.strictEqual(got.ok, true);
  const files = lockFiles(dir);
  assert.strictEqual(files.length, 1);
  assert.deepStrictEqual(readdirSync(dir), files, 'no temp files may remain beside the lock');
  const body = JSON.parse(readFileSync(join(dir, files[0]), 'utf8'));
  assert.deepStrictEqual(body, { pid: process.pid, lstart: processStart(process.pid), runId, repo, pgids: [], descendants: [] });
  got.lock.release();
  assert.deepStrictEqual(readdirSync(dir), []);
});

test('PT-C3 — a live holder refuses, naming "another gate run is active", its pid and start time', () => {
  const { repo } = mkRepo(); const dir = scratch();
  const first = acquireLock({ repo, runId: newRunId(), dir });
  const second = acquireLock({ repo, runId: newRunId(), dir });
  assert.strictEqual(second.ok, false);
  assert.match(second.reason, /another gate run is active/);
  assert.ok(second.reason.includes(String(process.pid)), second.reason);
  assert.ok(second.reason.includes(processStart(process.pid)), second.reason);
  assert.strictEqual(lockFiles(dir).length, 1, 'the holder keeps its lock');
  first.lock.release();
});

test('Q18/PT-C4 — addPgid persists group ids atomically (no temp residue), deduplicated', () => {
  const { repo } = mkRepo(); const dir = scratch();
  const { lock } = acquireLock({ repo, runId: newRunId(), dir });
  lock.addPgid(4242); lock.addPgid(4343); lock.addPgid(4242);
  assert.deepStrictEqual(readdirSync(dir), lockFiles(dir));
  assert.deepStrictEqual(JSON.parse(readFileSync(lock.path, 'utf8')).pgids, [4242, 4343]);
  lock.release();
});

test('PT-C4 — a stale lock is taken over: recorded pgids and marker carriers of the stale run are killed', () => {
  const { repo } = mkRepo(); const dir = scratch(); const m = mark();
  const scrubbedPid = longSleep(true);                       // own group, no marker: only the recorded pgid reaches it
  const staleRun = newRunId();
  const carrier = spawn('node', ['-e', 'setTimeout(()=>{},60000)', m], { detached: true, stdio: 'ignore', env: { ...process.env, QK_RUN_ID: staleRun } });
  carrier.unref(); kids.push(carrier.pid);
  const path = lockPathFor(repo, dir);
  writeFileSync(path, JSON.stringify({ pid: deadPid(), lstart: 'Thu Jan  1 00:00:00 1970', runId: staleRun, repo, pgids: [scrubbedPid] }));
  const got = acquireLock({ repo, runId: newRunId(), dir });
  assert.strictEqual(got.ok, true);
  return waitFor(() => !isAlive(scrubbedPid) && !isAlive(carrier.pid)).then((gone) => {
    assert.ok(gone, 'both the recorded group and the marker carrier must be dead');
    assert.deepStrictEqual(JSON.parse(readFileSync(got.lock.path, 'utf8')).pgids, [], 'new lock starts with no pgids');
    got.lock.release();
  });
});

test('PT-C5 — PID reuse: the unrelated live process is never signalled and the lock is taken over', () => {
  const { repo } = mkRepo(); const dir = scratch();
  const unrelated = longSleep(false);
  writeFileSync(lockPathFor(repo, dir), JSON.stringify({ pid: unrelated, lstart: 'Thu Jan  1 00:00:00 1970', runId: newRunId(), repo, pgids: [] }));
  const got = acquireLock({ repo, runId: newRunId(), dir });
  assert.strictEqual(got.ok, true);
  assert.ok(isAlive(unrelated), 'unrelated process must survive');
  got.lock.release();
});

test('PT-C4 — recorded pgids that are not plausible group ids are ignored, not signalled', () => {
  const { repo } = mkRepo(); const dir = scratch();
  writeFileSync(lockPathFor(repo, dir), JSON.stringify({ pid: deadPid(), lstart: 'x', runId: newRunId(), repo, pgids: [0, 1, -1, 'x', 1.5] }));
  const got = acquireLock({ repo, runId: newRunId(), dir });
  assert.strictEqual(got.ok, true);
  got.lock.release();
});

test('fail closed — an unreadable lock file refuses the run and is left in place', () => {
  const { repo } = mkRepo(); const dir = scratch(); const path = lockPathFor(repo, dir);
  writeFileSync(path, '{not json');
  const got = acquireLock({ repo, runId: newRunId(), dir });
  assert.strictEqual(got.ok, false);
  assert.match(got.reason, /unreadable|corrupt/i);
  assert.ok(existsSync(path));
});

test('PT-C6 — six runs racing for one stale lock: exactly one wins, the rest refuse as live', async () => {
  const { repo } = mkRepo(); const dir = scratch(); const gate = join(dir, 'go');
  const lockDir = join(dir, 'locks'); mkdirSync(lockDir);
  writeFileSync(lockPathFor(repo, lockDir), JSON.stringify({ pid: deadPid(), lstart: 'x', runId: newRunId(), repo, pgids: [] }));
  const script = join(dir, 'racer.mjs');
  writeFileSync(script, `
import { existsSync } from 'node:fs';
import { acquireLock } from ${JSON.stringify(pathToFileURL(join(here, 'process-safety', 'gate-lock.mjs')).href)};
import { newRunId } from ${JSON.stringify(pathToFileURL(join(here, 'process-safety', 'proc-tree.mjs')).href)};
while (!existsSync(${JSON.stringify(gate)})) {}
const got = acquireLock({ repo: ${JSON.stringify(repo)}, runId: newRunId(), dir: ${JSON.stringify(lockDir)} });
console.log(JSON.stringify({ ok: got.ok, reason: got.reason ?? null }));
process.stdin.resume(); process.stdin.on('end', () => { if (got.ok) got.lock.release(); process.exit(0); });
`);
  const racers = Array.from({ length: 6 }, () => {
    const c = spawn('node', [script], { stdio: ['pipe', 'pipe', 'inherit'] }); kids.push(c.pid);
    const out = new Promise((res) => { let b = ''; c.stdout.on('data', (d) => { b += d; if (b.includes('\n')) res(JSON.parse(b.trim())); }); });
    return { c, out };
  });
  await new Promise((r) => setTimeout(r, 600));             // all six are spinning on the barrier
  writeFileSync(gate, 'go');
  const results = await Promise.all(racers.map((r) => r.out));
  for (const { c } of racers) c.stdin.end();
  assert.strictEqual(results.filter((r) => r.ok).length, 1, JSON.stringify(results));
  for (const r of results.filter((x) => !x.ok)) assert.match(r.reason, /another gate run is active/);
  await Promise.all(racers.map(({ c }) => new Promise((res) => c.on('exit', res))));
  assert.deepStrictEqual(readdirSync(lockDir), []);
});

// --- hardening: survivors of the mutation run (each names the production harm it guards against) ---
test('processStart is locale-independent and trimmed (the PID-reuse discriminator must compare across shells)', () => {
  // harm: a lock written under LANG=fr_FR ("jeu. 22 oct.") and checked under C would look stale -> a live run is killed
  const keep = { LANG: process.env.LANG, LC_ALL: process.env.LC_ALL, LC_TIME: process.env.LC_TIME };
  const c = spawnSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }).stdout.trim();
  let s;
  try { Object.assign(process.env, { LANG: 'fr_FR.UTF-8', LC_TIME: 'fr_FR.UTF-8' }); delete process.env.LC_ALL; s = processStart(process.pid); }
  finally { for (const [k, v] of Object.entries(keep)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
  assert.strictEqual(s, c);
});

test('PT-C3 — a pid that exists but cannot be signalled (EPERM) is live, never stale', () => {
  // harm: a holder owned by another user (shared QK_LOCK_DIR) judged stale -> its lock is stolen and two runs overlap
  assert.strictEqual(classifyLock({ pid: 1, lstart: null }), 'live');
});

test('PT-C3 — a live holder with no recorded start time is reported as "started unknown"', () => {
  const { repo } = mkRepo(); const dir = scratch();
  writeFileSync(lockPathFor(repo, dir), JSON.stringify({ pid: process.pid, lstart: null, runId: newRunId(), repo, pgids: [] }));
  const got = acquireLock({ repo, runId: newRunId(), dir });
  assert.strictEqual(got.ok, false);
  assert.match(got.reason, /started unknown,/);
});

test('fail closed — a path that is not a git repository refuses with a reason instead of throwing', () => {
  // harm: an uncaught throw in pre-flight, or a lock keyed by a non-repository path
  const notRepo = scratch();
  const got = acquireLock({ repo: notRepo, runId: newRunId(), dir: scratch() });
  assert.strictEqual(got.ok, false);
  assert.match(got.reason, /^cannot create the repository lock: git common dir unavailable for /);
  assert.ok(got.reason.includes(notRepo), got.reason);
});

test('fail closed — a lock path that cannot be read (a directory) is refused as unreadable, not retried', () => {
  // harm: an EISDIR/EACCES lock treated as "no lock" -> a misleading retry loop instead of the real reason
  const { repo } = mkRepo(); const dir = scratch();
  mkdirSync(lockPathFor(repo, dir));
  const got = acquireLock({ repo, runId: newRunId(), dir });
  assert.strictEqual(got.ok, false);
  assert.match(got.reason, /unreadable or corrupt/);
});

test('PT-C6 — a lock that keeps changing hands ends in a bounded refusal (dangling lock link)', () => {
  // harm: an unbounded retry loop hangs the gate forever
  const { repo } = mkRepo(); const dir = scratch(); const path = lockPathFor(repo, dir);
  symlinkSync(join(dir, 'nowhere'), path);
  const got = acquireLock({ repo, runId: newRunId(), dir });
  assert.strictEqual(got.ok, false);
  assert.match(got.reason, /^another gate run is active for this repository \(lock .* changed hands repeatedly\)$/);
  assert.deepStrictEqual(readdirSync(dir), [path.split('/').pop()], 'no temp residue');
});

test('PT-C7 — release removes only its own lock: never one re-taken by another run, and never throws when gone', () => {
  // harm: deleting a lock that now belongs to another run lets a third run start beside it
  const lstart = processStart(process.pid);
  for (const foreign of [{ pid: process.pid, runId: newRunId() }, { pid: deadPid(), runId: null }]) {
    const { repo } = mkRepo(); const dir = scratch(); const runId = newRunId();
    const { lock } = acquireLock({ repo, runId, dir });
    const other = { pid: foreign.pid, lstart, runId: foreign.runId ?? runId, repo, pgids: [] };
    writeFileSync(lock.path, JSON.stringify(other));
    lock.release();
    assert.deepStrictEqual(JSON.parse(readFileSync(lock.path, 'utf8')), other, JSON.stringify(foreign));
  }
  const { repo } = mkRepo(); const { lock } = acquireLock({ repo, runId: newRunId(), dir: scratch() });
  unlinkSync(lock.path);
  assert.doesNotThrow(() => lock.release());
});

test('PT-C6 — takeover puts back a lock that is not the one judged stale, leaving no residue', () => {
  // harm: a fresh live lock that slipped in between the judgement and the rename is deleted -> two runs overlap
  const live = { pid: process.pid, lstart: processStart(process.pid), runId: newRunId(), repo: '/r', pgids: [] };
  const judged = [
    { pid: deadPid(), runId: newRunId(), pgids: [] },  // different holder entirely
    { pid: process.pid, runId: newRunId(), pgids: [] }, // same pid, another run
    { pid: deadPid(), runId: live.runId, pgids: [] },  // same run id, another pid
  ];
  for (const held of judged) {
    const dir = scratch(); const path = join(dir, 'qk-gate-x.lock');
    writeFileSync(path, JSON.stringify(live));
    takeOverStale(path, held);
    assert.deepStrictEqual(JSON.parse(readFileSync(path, 'utf8')), live, JSON.stringify(held));
    assert.deepStrictEqual(readdirSync(dir), ['qk-gate-x.lock']);
  }
  const dir = scratch(); const path = join(dir, 'qk-gate-x.lock');
  writeFileSync(path, '{corrupt');
  assert.doesNotThrow(() => takeOverStale(path, judged[0]));
  assert.strictEqual(readFileSync(path, 'utf8'), '{corrupt');
  assert.doesNotThrow(() => takeOverStale(join(dir, 'absent.lock'), judged[0]), 'a lock already gone is not an error');
});

test('PT-C4 — a recorded group that ignores SIGTERM is still killed on takeover (SIGKILL)', async () => {
  const { repo } = mkRepo(); const dir = scratch(); const env = { ...process.env }; delete env.QK_RUN_ID;
  const c = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});console.log('r');setTimeout(()=>{},60000)"], { detached: true, stdio: ['ignore', 'pipe', 'ignore'], env });
  kids.push(c.pid);
  await new Promise((r) => c.stdout.once('data', r));
  writeFileSync(lockPathFor(repo, dir), JSON.stringify({ pid: deadPid(), lstart: 'x', runId: newRunId(), repo, pgids: [c.pid] }));
  const got = acquireLock({ repo, runId: newRunId(), dir });
  assert.strictEqual(got.ok, true);
  assert.ok(await waitFor(() => !isAlive(c.pid), { timeoutMs: 3000 }), 'SIGTERM-ignoring member must die');
  got.lock.release();
});

// --- PT-A18 / PT-C4: persisted descendants ---
test('PT-A18 — setDescendants persists {pid,start} atomically (no temp residue) and skips an unchanged set', () => {
  const { repo } = mkRepo(); const dir = scratch();
  const { lock } = acquireLock({ repo, runId: newRunId(), dir });
  lock.setDescendants([{ pid: 4242, start: 'a' }]);
  assert.deepStrictEqual(readdirSync(dir), lockFiles(dir));
  assert.deepStrictEqual(JSON.parse(readFileSync(lock.path, 'utf8')).descendants, [{ pid: 4242, start: 'a' }]);
  const ino = statSync(lock.path).ino;
  lock.setDescendants([{ pid: 4242, start: 'a' }]);
  assert.strictEqual(statSync(lock.path).ino, ino, 'an unchanged set must not rewrite the file');
  lock.addPgid(77);
  assert.deepStrictEqual(JSON.parse(readFileSync(lock.path, 'utf8')).descendants, [{ pid: 4242, start: 'a' }], 'addPgid keeps the descendants');
  lock.setDescendants([]);
  assert.deepStrictEqual(JSON.parse(readFileSync(lock.path, 'utf8')).descendants, []);
  lock.release();
});
test('PT-A18 — a new lock starts with descendants: [] and a lock without the key is still readable', () => {
  const { repo } = mkRepo(); const dir = scratch();
  const got = acquireLock({ repo, runId: newRunId(), dir });
  assert.deepStrictEqual(JSON.parse(readFileSync(got.lock.path, 'utf8')).descendants, []);
  got.lock.release();
});
const startNorm = (pid) => snapshotTable().find((e) => e.pid === pid).start;
test('PT-C4/A18 — takeover kills a recorded descendant whose start time matches, spares a differing one (PT-A17)', async () => {
  const { repo } = mkRepo(); const dir = scratch();
  const hit = longSleep(false), spared = longSleep(false);
  writeFileSync(lockPathFor(repo, dir), JSON.stringify({ pid: deadPid(), lstart: 'x', runId: newRunId(), repo, pgids: [],
    descendants: [{ pid: hit, start: startNorm(hit) }, { pid: spared, start: 'Thu Jan 1 00:00:00 1970' }] }));
  const got = acquireLock({ repo, runId: newRunId(), dir });
  assert.strictEqual(got.ok, true);
  assert.ok(await waitFor(() => !isAlive(hit)), 'the matching descendant must be killed');
  assert.ok(isAlive(spared), 'a differing start time must be spared');
  got.lock.release();
});
