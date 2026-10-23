import './hermetic-git.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { lockPathFor, processStart, classifyLock, acquireLock } from './gate-lock.mjs';
import { newRunId } from './proc-tree.mjs';
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
  assert.deepStrictEqual(body, { pid: process.pid, lstart: processStart(process.pid), runId, repo, pgids: [] });
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
import { acquireLock } from ${JSON.stringify(pathToFileURL(join(here, 'gate-lock.mjs')).href)};
import { newRunId } from ${JSON.stringify(pathToFileURL(join(here, 'proc-tree.mjs')).href)};
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
