import './hermetic-git.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync, rmSync, symlinkSync, unlinkSync, statSync, chmodSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { lockPathFor, processStart, classifyLock, acquireLock, defaultLockDir } from './process-safety/gate-lock.mjs';
import { parseLock, readLock, writeTemp } from './process-safety/lock-store.mjs';
import { newRunId } from './process-safety/proc-tree.mjs';
import { snapshotTable } from './process-safety/proc-descendants.mjs';
import { takeOverStale, sweepStale, reapTempFiles } from './process-safety/lock-takeover.mjs';
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
  assert.deepStrictEqual(JSON.parse(readFileSync(lock.path, 'utf8')).pgids, [{ pgid: 4242, start: null }, { pgid: 4343, start: null }], 'an unreadable leader start is recorded as null');
  lock.release();
});

test('PT-C4 — a stale lock is taken over: recorded pgids and marker carriers of the stale run are killed', () => {
  const { repo } = mkRepo(); const dir = scratch(); const m = mark();
  const scrubbedPid = longSleep(true);                       // own group, no marker: only the recorded pgid reaches it
  const staleRun = newRunId();
  const carrier = spawn('node', ['-e', 'setTimeout(()=>{},60000)', m], { detached: true, stdio: 'ignore', env: { ...process.env, QK_RUN_ID: staleRun } });
  carrier.unref(); kids.push(carrier.pid);
  const path = lockPathFor(repo, dir);
  writeFileSync(path, JSON.stringify({ pid: deadPid(), lstart: 'Thu Jan  1 00:00:00 1970', runId: staleRun, repo, pgids: [{ pgid: scrubbedPid, start: startNorm(scrubbedPid) }], descendants: [] }));
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
  writeFileSync(lockPathFor(repo, dir), JSON.stringify({ pid: unrelated, lstart: 'Thu Jan  1 00:00:00 1970', runId: newRunId(), repo, pgids: [], descendants: [] }));
  const got = acquireLock({ repo, runId: newRunId(), dir });
  assert.strictEqual(got.ok, true);
  assert.ok(isAlive(unrelated), 'unrelated process must survive');
  got.lock.release();
});

test('PT-C4 — recorded pgids that are not plausible group ids are ignored, not signalled', () => {
  const { repo } = mkRepo(); const dir = scratch();
  writeFileSync(lockPathFor(repo, dir), JSON.stringify({ pid: deadPid(), lstart: 'x', runId: newRunId(), repo, pgids: [0, 1, -1].map((pgid) => ({ pgid, start: null })), descendants: [] }));
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
  writeFileSync(lockPathFor(repo, lockDir), JSON.stringify({ pid: deadPid(), lstart: 'x', runId: newRunId(), repo, pgids: [], descendants: [] }));
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
  writeFileSync(lockPathFor(repo, dir), JSON.stringify({ pid: process.pid, lstart: null, runId: newRunId(), repo, pgids: [], descendants: [] }));
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

test('fail closed — a trusted-looking lock that cannot be read (mode 000) is refused as unreadable, not retried', () => {
  // harm: an EISDIR/EACCES lock treated as "no lock" -> a misleading retry loop instead of the real reason
  const { repo } = mkRepo(); const dir = scratch();
  writeFileSync(lockPathFor(repo, dir), '{}', { mode: 0o600 }); chmodSync(lockPathFor(repo, dir), 0o000);
  const got = acquireLock({ repo, runId: newRunId(), dir });
  assert.strictEqual(got.ok, false);
  assert.match(got.reason, /unreadable or corrupt/);
  assert.match(got.reason, new RegExp(lockPathFor(repo, dir).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')));
});

test('PT-C6/C13 — a dangling link at the lock path ends in an immediate untrusted refusal, not a retry loop', () => {
  // harm: an unbounded retry loop hangs the gate forever
  const { repo } = mkRepo(); const dir = scratch(); const path = lockPathFor(repo, dir);
  symlinkSync(join(dir, 'nowhere'), path);
  const got = acquireLock({ repo, runId: newRunId(), dir });
  assert.strictEqual(got.ok, false);
  assert.match(got.reason, /^repository lock .* is untrusted \(is not a real file/);
  assert.deepStrictEqual(readdirSync(dir), [path.split('/').pop()], 'no temp residue');
});

test('PT-C7 — release removes only its own lock: never one re-taken by another run, and never throws when gone', () => {
  // harm: deleting a lock that now belongs to another run lets a third run start beside it
  const lstart = processStart(process.pid);
  for (const foreign of [{ pid: process.pid, runId: newRunId() }, { pid: deadPid(), runId: null }]) {
    const { repo } = mkRepo(); const dir = scratch(); const runId = newRunId();
    const { lock } = acquireLock({ repo, runId, dir });
    const other = { pid: foreign.pid, lstart, runId: foreign.runId ?? runId, repo, pgids: [], descendants: [] };
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
  const live = { pid: process.pid, lstart: processStart(process.pid), runId: newRunId(), repo: '/r', pgids: [], descendants: [] };
  const judged = [
    { pid: deadPid(), runId: newRunId(), pgids: [], descendants: [] },  // different holder entirely
    { pid: process.pid, runId: newRunId(), pgids: [], descendants: [] }, // same pid, another run
    { pid: deadPid(), runId: live.runId, pgids: [], descendants: [] },  // same run id, another pid
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
  writeFileSync(lockPathFor(repo, dir), JSON.stringify({ pid: deadPid(), lstart: 'x', runId: newRunId(), repo, pgids: [{ pgid: c.pid, start: startNorm(c.pid) }], descendants: [] }));
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

// --- pre-push panel hardening (PT-C12..C15) ---
const staleLock = (repo, dir, over = {}) => { const path = lockPathFor(repo, dir); writeFileSync(path, JSON.stringify({ pid: deadPid(), lstart: 'x', runId: newRunId(), repo, pgids: [], descendants: [], ...over })); return path; };

test('PT-C12 — the default lock directory is <tmp>/qk-gate-<uid>, created 0700; a trusted existing one is reused', () => {
  const base = scratch(); const dir = defaultLockDir(base);
  assert.strictEqual(dir, join(base, `qk-gate-${process.getuid()}`));
  assert.strictEqual(statSync(dir).mode & 0o777, 0o700);
  assert.strictEqual(defaultLockDir(base), dir);
});

test('PT-C12 — a lock directory that is group/world-writable, a symlink, or not a directory is refused, naming it', () => {
  const { repo } = mkRepo();
  const open = scratch(); chmodSync(open, 0o777);
  const g = scratch(); chmodSync(g, 0o770);
  const real = scratch(); const link = join(scratch(), 'link'); symlinkSync(real, link);
  const file = join(scratch(), 'f'); writeFileSync(file, '');
  for (const dir of [open, g, link, file]) {
    const got = acquireLock({ repo, runId: newRunId(), dir });
    assert.strictEqual(got.ok, false, dir);
    assert.ok(got.reason.includes(dir), got.reason);
    assert.deepStrictEqual(existsSync(dir) && statSync(dir).isDirectory() ? readdirSync(dir) : [], [], 'nothing written');
  }
});

test('PT-C12 — a directory owned by another user is refused (uid check)', () => {
  const { repo } = mkRepo();
  const got = acquireLock({ repo, runId: newRunId(), dir: '/', uid: process.getuid() + 1 });
  assert.strictEqual(got.ok, false);
  assert.match(got.reason, /not owned by uid/);
});

test('PT-C12 — lock and temp files are created exclusively (0600), never through a planted symlink', () => {
  const { repo } = mkRepo(); const dir = scratch(); const victim = join(scratch(), 'victim'); writeFileSync(victim, 'VICTIM');
  const path = lockPathFor(repo, dir);
  symlinkSync(victim, `${path}.${process.pid}.tmp`);                  // the old, predictable temp name
  const got = acquireLock({ repo, runId: newRunId(), dir });
  assert.strictEqual(got.ok, true);
  got.lock.addPgid(4242); got.lock.setDescendants([{ pid: 4343, start: 'a' }]);
  assert.strictEqual(readFileSync(victim, 'utf8'), 'VICTIM', 'a symlink at the old temp name must not be followed');
  assert.strictEqual(statSync(path).mode & 0o777, 0o600);
  const planted = basenameOf(`${path}.${process.pid}.tmp`);
  assert.deepStrictEqual(readdirSync(dir).sort(), [basenameOf(path), planted].sort(), 'no temp residue besides the planted link');
  got.lock.release();
});
const basenameOf = (p) => p.split('/').pop();

test('PT-C13 — a stale lock that is not a trusted regular file is refused, kills nothing and stays in place', () => {
  const { repo } = mkRepo();
  for (const how of ['world-writable', 'symlink']) {
    const dir = scratch(); const bystander = longSleep(true);
    const path = staleLock(repo, dir, { pgids: [{ pgid: bystander, start: startNorm(bystander) }] });
    if (how === 'world-writable') chmodSync(path, 0o666);
    else { const real = join(scratch(), 'real.lock'); writeFileSync(real, readFileSync(path)); unlinkSync(path); symlinkSync(real, path); }
    const got = acquireLock({ repo, runId: newRunId(), dir });
    assert.strictEqual(got.ok, false, how);
    assert.match(got.reason, /untrusted/);
    assert.ok(isAlive(bystander), `${how}: nothing may be killed`);
    assert.ok(existsSync(path));
  }
});

test('PT-C14 — takeover never signals its own process group, identity entry', async () => {
  // runs in a child with its own group: the pre-fix code would SIGKILL that whole group, i.e. the child
  const { repo } = mkRepo(); const dir = scratch(); const script = join(scratch(), 'self.mjs');
  writeFileSync(script, `
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { acquireLock, lockPathFor } from ${JSON.stringify(pathToFileURL(join(here, 'process-safety', 'gate-lock.mjs')).href)};
const own = Number(spawnSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).stdout.trim());
writeFileSync(lockPathFor(${JSON.stringify(repo)}, ${JSON.stringify(dir)}), JSON.stringify({ pid: 99999999, lstart: 'x', runId: '0123456789abcdef', repo: ${JSON.stringify(repo)}, pgids: [{ pgid: own, start: null }], descendants: [] }));
const got = acquireLock({ repo: ${JSON.stringify(repo)}, runId: 'fedcba9876543210', dir: ${JSON.stringify(dir)} });
console.log(JSON.stringify({ ok: got.ok })); got.lock && got.lock.release();`);
  const c = spawn(process.execPath, [script], { detached: true, stdio: ['ignore', 'pipe', 'inherit'] }); kids.push(c.pid);
  let out = ''; c.stdout.on('data', (d) => { out += d; });
  const [code, signal] = await new Promise((r) => c.on('exit', (a, b) => r([a, b])));
  assert.deepStrictEqual([code, signal], [0, null]);
  assert.deepStrictEqual(JSON.parse(out), { ok: true });
});

test('PT-C14 — a recorded group is killed when its leader start time matches, spared when it differs (pgid recycling)', async () => {
  const { repo } = mkRepo();
  const hit = longSleep(true), recycled = longSleep(true);
  const dir = scratch();
  staleLock(repo, dir, { pgids: [{ pgid: hit, start: startNorm(hit) }, { pgid: recycled, start: 'Thu Jan 1 00:00:00 1970' }] });
  const got = acquireLock({ repo, runId: newRunId(), dir });
  assert.strictEqual(got.ok, true);
  assert.ok(await waitFor(() => !isAlive(hit)), 'identity match: group killed');
  assert.ok(isAlive(recycled), 'identity mismatch and no marker carrier: group skipped');
  got.lock.release();
});

test('PT-C14 — a group whose recorded start is null is spared unless a member carries the stale marker', async () => {
  const { repo } = mkRepo(); const dir = scratch();
  const unknown = longSleep(true);
  staleLock(repo, dir, { pgids: [{ pgid: unknown, start: null }] });
  const got = acquireLock({ repo, runId: newRunId(), dir });
  assert.strictEqual(got.ok, true);
  assert.ok(isAlive(unknown));
  got.lock.release();
});

test('PT-C14 — a mismatching leader start is still killed when a group member carries the stale marker (scrubbed siblings die too)', async () => {
  const { repo } = mkRepo(); const dir = scratch(); const m = mark(); const staleRun = newRunId();
  // the leader carries the stale marker; its sibling in the same group has a scrubbed environment
  const leaderSrc = "require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},60000)',process.env.SIB],{stdio:'ignore',env:{}});setTimeout(()=>{},60000)";
  const leader = spawn(process.execPath, ['-e', leaderSrc], { detached: true, stdio: 'ignore', env: { ...process.env, QK_RUN_ID: staleRun, SIB: m } });
  leader.unref(); kids.push(leader.pid);
  assert.ok(await waitFor(() => pgrepMarker(m).length > 0), 'scrubbed sibling started');
  const sibling = pgrepMarker(m)[0];
  staleLock(repo, dir, { runId: staleRun, pgids: [{ pgid: leader.pid, start: 'Thu Jan 1 00:00:00 1970' }] });
  const got = acquireLock({ repo, runId: newRunId(), dir });
  assert.strictEqual(got.ok, true);
  assert.ok(await waitFor(() => !isAlive(sibling) && !isAlive(leader.pid)), 'the whole recorded group, including the scrubbed sibling, must die');
  got.lock.release();
});

test('PT-C14 — addPgid records the leader start time; removePgid drops a reaped group', () => {
  const { repo } = mkRepo(); const dir = scratch(); const pid = longSleep(true);
  const { lock } = acquireLock({ repo, runId: newRunId(), dir });
  lock.addPgid(pid); lock.addPgid(4242);
  assert.deepStrictEqual(JSON.parse(readFileSync(lock.path, 'utf8')).pgids, [{ pgid: pid, start: startNorm(pid) }, { pgid: 4242, start: null }]);
  lock.removePgid(pid); lock.removePgid(999999);
  assert.deepStrictEqual(JSON.parse(readFileSync(lock.path, 'utf8')).pgids, [{ pgid: 4242, start: null }]);
  lock.release();
});

test('PT-C15 — takeover restores a moved-aside lock whose lstart differs from the judged one', () => {
  const live = { pid: process.pid, lstart: processStart(process.pid), runId: newRunId(), repo: '/r', pgids: [], descendants: [] };
  const dir = scratch(); const path = join(dir, 'qk-gate-x.lock'); writeFileSync(path, JSON.stringify(live));
  let swept = false;
  const out = takeOverStale(path, { ...live, lstart: 'Thu Jan 1 00:00:00 1970' }, { sweep: () => { swept = true; } });
  assert.strictEqual(out, null);
  assert.strictEqual(swept, false);
  assert.deepStrictEqual(JSON.parse(readFileSync(path, 'utf8')), live);
  assert.deepStrictEqual(readdirSync(dir), ['qk-gate-x.lock']);
});

test('PT-C15 — if the moved-aside lock cannot be put back, takeover reports it and keeps the record', () => {
  const live = { pid: process.pid, lstart: processStart(process.pid), runId: newRunId(), repo: '/r', pgids: [], descendants: [] };
  const dir = scratch(); const path = join(dir, 'qk-gate-x.lock'); writeFileSync(path, JSON.stringify(live));
  const out = takeOverStale(path, { pid: deadPid(), lstart: 'x', runId: newRunId(), pgids: [], descendants: [] }, { link: () => { const e = new Error('exists'); e.code = 'EEXIST'; throw e; } });
  assert.match(out, /could not be restored/);
  assert.ok(readdirSync(dir).some((f) => f.endsWith('.stale')), 'the displaced record is kept, not destroyed');
});

test('PT-C15 — the stale run is swept while its record still exists, and the record is removed afterwards', () => {
  const dir = scratch(); const path = join(dir, 'qk-gate-x.lock');
  const held = { pid: deadPid(), lstart: 'x', runId: newRunId(), repo: '/r', pgids: [], descendants: [] };
  writeFileSync(path, JSON.stringify(held));
  let during;
  const out = takeOverStale(path, held, { sweep: () => { during = readdirSync(dir); } });
  assert.strictEqual(out, null);
  assert.strictEqual(during.length, 1, 'the claimed record exists during the sweep');
  assert.deepStrictEqual(readdirSync(dir), [], 'and is gone afterwards');
});

test('lock schema — no legacy formats: bare-number pgids, missing or malformed descendants and malformed entries are corrupt; no kill happens', async () => {
  const ok = { pid: 5, lstart: 'x', runId: newRunId(), repo: '/r', pgids: [{ pgid: 7, start: 's' }, { pgid: 8, start: null }], descendants: [{ pid: 9, start: 's' }] };
  assert.deepStrictEqual(parseLock(JSON.stringify(ok)), ok);
  const { descendants, ...noDesc } = ok; void descendants;
  for (const bad of [{ ...ok, pgids: [7] }, { ...ok, pgids: [{ pgid: 7, start: 's' }, 8] }, noDesc, { ...ok, descendants: 'junk' },
    { ...ok, pgids: [{ pgid: '7', start: 's' }] }, { ...ok, pgids: [{ pgid: 7, start: 5 }] }, { ...ok, pgids: [null] }, { ...ok, descendants: [3] }, { ...ok, descendants: [{ pid: 9 }] }]) {
    assert.strictEqual(parseLock(JSON.stringify(bad)), null, JSON.stringify(bad));
  }
  const { repo } = mkRepo(); const dir = scratch(); const g = longSleep(true);
  writeFileSync(lockPathFor(repo, dir), JSON.stringify({ ...ok, pid: deadPid(), pgids: [g], descendants: [] }));
  const got = acquireLock({ repo, runId: newRunId(), dir });
  assert.strictEqual(got.ok, false);
  assert.ok(isAlive(g), 'a bare-number pgid is never killed');
});

// ---- gate repair round 1 (breaker round 4): PT-C13 non-regular file, PT-C15 stranded record, PT-C12/C14 gaps ----

test('PT-C13 — a FIFO at the lock path is refused promptly, never opened for reading, and kills nothing', () => {
  // harm: opening a FIFO for reading blocks forever (no verdict); runs in a child so a hang fails by timeout
  const { repo } = mkRepo(); const dir = scratch(); const bystander = longSleep(true);
  const path = lockPathFor(repo, dir);
  assert.strictEqual(spawnSync('mkfifo', [path]).status, 0);
  chmodSync(path, 0o600);
  const script = join(scratch(), 'fifo.mjs');
  writeFileSync(script, `
import { acquireLock } from ${JSON.stringify(pathToFileURL(join(here, 'process-safety', 'gate-lock.mjs')).href)};
const got = acquireLock({ repo: ${JSON.stringify(repo)}, runId: 'fedcba9876543210', dir: ${JSON.stringify(dir)} });
console.log(JSON.stringify(got));`);
  const r = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
  assert.strictEqual(r.signal, null, 'the referee must not block on the FIFO');
  const got = JSON.parse(r.stdout);
  assert.strictEqual(got.ok, false);
  assert.match(got.reason, /unreadable or corrupt|untrusted/);
  assert.ok(isAlive(bystander));
  assert.ok(statSync(path).isFIFO(), 'the planted node is left in place');
});

test('PT-C13 — readLock opens with the owner check on the descriptor: a file of another uid is not read', () => {
  const dir = scratch(); const path = join(dir, 'qk-gate-x.lock');
  const rec = { pid: 5, lstart: 'x', runId: newRunId(), repo: '/r', pgids: [], descendants: [] };
  writeFileSync(path, JSON.stringify(rec), { mode: 0o600 });
  assert.deepStrictEqual(readLock(path, process.getuid()), rec);
  assert.strictEqual(readLock(path, process.getuid() + 1), null);
  assert.strictEqual(readLock(join(dir, 'absent')), undefined);
});

const strandedPath = (path, claimer) => `${path}.${claimer}.stale`;

test('PT-C15 — a record stranded by a referee killed during takeover is swept (group, descendant, marker) and then removed', async () => {
  const { repo } = mkRepo(); const dir = scratch(); const hit = longSleep(true);
  const path = lockPathFor(repo, dir);
  const file = strandedPath(path, deadPid());
  writeFileSync(file, JSON.stringify({ pid: deadPid(), lstart: 'x', runId: newRunId(), repo, pgids: [{ pgid: hit, start: startNorm(hit) }], descendants: [] }), { mode: 0o600 });
  const got = acquireLock({ repo, runId: newRunId(), dir });
  assert.strictEqual(got.ok, true);
  assert.ok(await waitFor(() => !isAlive(hit)), 'the stranded run\'s group is killed');
  assert.deepStrictEqual(readdirSync(dir), lockFiles(dir), 'the stranded record is removed after the sweep');
  got.lock.release();
});

test('PT-C15 — a stranded record is left alone while its claimer is alive, and when its holder is live', () => {
  const { repo } = mkRepo(); const dir = scratch(); const bystander = longSleep(true);
  const path = lockPathFor(repo, dir);
  const rec = (over) => JSON.stringify({ pid: deadPid(), lstart: 'x', runId: newRunId(), repo, pgids: [{ pgid: bystander, start: startNorm(bystander) }], descendants: [], ...over });
  const midTakeover = strandedPath(path, process.pid);           // claimer (this process) is alive: a takeover is in progress
  writeFileSync(midTakeover, rec(), { mode: 0o600 });
  const got = acquireLock({ repo, runId: newRunId(), dir });
  assert.strictEqual(got.ok, true);
  assert.ok(isAlive(bystander), 'an in-progress takeover is not interfered with');
  assert.ok(existsSync(midTakeover));
  got.lock.release(); unlinkSync(midTakeover);
  const live = { pid: process.pid, lstart: processStart(process.pid) };
  const liveFile = strandedPath(path, deadPid());
  writeFileSync(liveFile, rec(live), { mode: 0o600 });
  const second = acquireLock({ repo, runId: newRunId(), dir });
  assert.strictEqual(second.ok, false, 'a live run displaced by a dead claimer is put back and respected');
  assert.match(second.reason, /another gate run is active/);
  assert.ok(isAlive(bystander));
  assert.ok(!existsSync(liveFile));
});

test('PT-C13/C15 — an untrusted stranded record (world-writable, symlink, FIFO) is refused, kills nothing', () => {
  const { repo } = mkRepo(); const path = lockPathFor(repo, scratch());
  for (const how of ['world-writable', 'symlink', 'fifo']) {
    const dir = scratch(); const bystander = longSleep(true);
    const p = lockPathFor(repo, dir); const file = strandedPath(p, deadPid());
    const body = JSON.stringify({ pid: deadPid(), lstart: 'x', runId: newRunId(), repo, pgids: [{ pgid: bystander, start: startNorm(bystander) }], descendants: [] });
    if (how === 'fifo') { spawnSync('mkfifo', [file]); }
    else if (how === 'symlink') { const real = join(scratch(), 'r'); writeFileSync(real, body, { mode: 0o600 }); symlinkSync(real, file); }
    else { writeFileSync(file, body); chmodSync(file, 0o666); }
    const got = acquireLock({ repo, runId: newRunId(), dir });
    assert.strictEqual(got.ok, false, how);
    assert.match(got.reason, /untrusted/, how);
    assert.ok(isAlive(bystander), how);
  }
  void path;
});

test('PT-C14 — forged pgids (0, 1, negative, non-integer, own group) in a record are never signalled', () => {
  const signalled = [];
  const own = Number(spawnSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).stdout.trim());
  const forged = [0, 1, -1, -own, 1.5, NaN, Infinity, '7', null, undefined, own, { pgid: 0, start: null }, { pgid: 1, start: null }, { pgid: -5, start: 'x' }, { pgid: 2.5, start: null }, { pgid: own, start: null }, { pgid: own, start: startNorm(process.pid) }];
  sweepStale({ runId: newRunId(), pgids: forged, descendants: [] }, { kill: (g) => signalled.push(g) });
  assert.deepStrictEqual(signalled, []);
  const marked = longSleep(true);                                 // positive control: a live group with a matching start time is signalled
  sweepStale({ runId: newRunId(), pgids: [{ pgid: marked, start: startNorm(marked) }], descendants: [] }, { kill: (g) => signalled.push(g) });
  assert.deepStrictEqual(signalled, [marked]);
});

test('PT-C12 — temp file names are random per write, created exclusively with mode 0600', () => {
  const dir = scratch(); const path = join(dir, 'qk-gate-x.lock');
  const a = writeTemp(path, { a: 1 }), b = writeTemp(path, { a: 2 });
  assert.notStrictEqual(a, b);
  for (const t of [a, b]) {
    assert.match(t.slice(path.length), /^\.\d+\.[0-9a-f]{12}\.tmp$/);
    assert.strictEqual(statSync(t).mode & 0o777, 0o600);
  }
  assert.deepStrictEqual(JSON.parse(readFileSync(b, 'utf8')), { a: 2 });
  const fixed = () => Buffer.from('aabbccddeeff', 'hex');
  writeTemp(path, {}, fixed);
  assert.throws(() => writeTemp(path, { x: 1 }, fixed), { code: 'EEXIST' }, 'an existing name is never overwritten or followed');
});

// ---- gate repair round 2 (breaker round 5): PT-C16 leftover temp files of a killed writer ----

const tempPath = (path, pid, hex = 'abcdef012345') => `${path}.${pid}.${hex}.tmp`;

test('PT-C16 — a temp file left by a dead writer (SIGKILL mid lock write) is removed, and the run proceeds and releases to an empty dir', () => {
  const { repo } = mkRepo(); const dir = scratch();
  const path = lockPathFor(repo, dir);
  const leftover = tempPath(path, deadPid());
  writeFileSync(leftover, '{"pid":', { mode: 0o600 });
  const got = acquireLock({ repo, runId: newRunId(), dir });
  assert.strictEqual(got.ok, true);
  assert.ok(!existsSync(leftover), 'the dead writer\'s temp file is removed');
  got.lock.release();
  assert.deepStrictEqual(readdirSync(dir), [], 'INV-PT-12: the lock dir is empty after release');
});

test('PT-C16 — a temp file whose writer is alive, another repo\'s temp file, and non-matching names are left untouched', () => {
  const { repo } = mkRepo(); const dir = scratch();
  const path = lockPathFor(repo, dir);
  const keep = [
    tempPath(path, process.pid),                                        // writer alive
    join(dir, `qk-gate-0000000000000000.lock.${deadPid()}.abcdef012345.tmp`), // another repository's lock
    `${path}.${deadPid()}.ABCDEF012345.tmp`,                            // not 12 lowercase hex
    `${path}.${deadPid()}.abcdef01234.tmp`,                             // 11 hex
    `${path}.${deadPid()}.abcdef012345.tmp.bak`,                        // extra suffix
    `${path}.x.abcdef012345.tmp`,                                       // non-numeric pid
  ];
  for (const f of keep) writeFileSync(f, 'x', { mode: 0o600 });
  const got = acquireLock({ repo, runId: newRunId(), dir });
  assert.strictEqual(got.ok, true);
  for (const f of keep) assert.ok(existsSync(f), f);
  got.lock.release();
});

test('PT-C16 — an untrusted temp file (symlink, FIFO, group/world-writable) is left untouched and does not block the run', () => {
  for (const how of ['symlink', 'fifo', 'world-writable', 'group-writable']) {
    const { repo } = mkRepo(); const dir = scratch();
    const path = lockPathFor(repo, dir); const file = tempPath(path, deadPid());
    const target = join(scratch(), 'precious'); writeFileSync(target, 'keep', { mode: 0o600 });
    if (how === 'fifo') spawnSync('mkfifo', [file]);
    else if (how === 'symlink') symlinkSync(target, file);
    else { writeFileSync(file, 'x'); chmodSync(file, how === 'world-writable' ? 0o666 : 0o660); }
    const got = acquireLock({ repo, runId: newRunId(), dir });
    assert.strictEqual(got.ok, true, how);
    assert.ok(lstatSync(file), `${how} left in place`);
    assert.strictEqual(readFileSync(target, 'utf8'), 'keep', how);
    got.lock.release();
  }
});

test('PT-C16 — a temp file owned by another uid is left untouched (uid check)', () => {
  const { repo } = mkRepo(); const dir = scratch();
  const path = lockPathFor(repo, dir); const file = tempPath(path, deadPid());
  writeFileSync(file, 'x', { mode: 0o600 });
  assert.strictEqual(reapTempFiles(path, { uid: process.getuid() + 1 }), undefined);
  assert.ok(existsSync(file));
  reapTempFiles(path, { uid: process.getuid() });
  assert.ok(!existsSync(file));
});
