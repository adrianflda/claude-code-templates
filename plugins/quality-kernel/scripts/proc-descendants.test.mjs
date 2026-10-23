import { test, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePsTable, parseProcStat, readProcTable, trackStep, killablePids } from './process-safety/proc-descendants.mjs';
import { createRunner, newRunId } from './process-safety/proc-tree.mjs';
import { newMarker, pgrepMarker, pkillMarker, waitFor } from './proc-test-kit.mjs';

const markers = []; const dirs = [];
const mark = () => { const m = newMarker(); markers.push(m); return m; };
after(() => { for (const m of markers) pkillMarker(m); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const E = (pid, ppid, start = 's') => ({ pid, ppid, start });

// --- table parsing ---
test('PT-A15 — parsePsTable reads pid, ppid and the multi-word lstart start time', () => {
  const out = parsePsTable('  101     1 Thu Oct 22 10:00:01 2026\n  202   101 Thu Oct 22 10:00:02 2026\n\n');
  assert.deepStrictEqual(out, [E(101, 1, 'Thu Oct 22 10:00:01 2026'), E(202, 101, 'Thu Oct 22 10:00:02 2026')]);
});
test('PT-A15 — parsePsTable ignores malformed lines', () => {
  assert.deepStrictEqual(parsePsTable('garbage\n  5\n x y z\n'), []);
});
test('PT-A15 (Linux) — parseProcStat takes ppid and starttime after the LAST ")" of a comm with spaces and parens', () => {
  const fields = ['S', '77', '10', '10', '0', '-1', '4194560', '1', '0', '0', '0', '0', '0', '0', '0', '20', '0', '1', '0', '987654'];
  assert.deepStrictEqual(parseProcStat(555, `555 (a b) c) ${fields.join(' ')} 1 2 3`), E(555, 77, '987654'));
  assert.strictEqual(parseProcStat(1, 'nonsense'), null);
});
test('PT-A15 (Linux) — readProcTable walks a fake /proc, skipping non-numeric dirs and unreadable entries', () => {
  const root = mkdtempSync(join(tmpdir(), 'qk-fproc-')); dirs.push(root);
  const stat = (pid, ppid, st) => `${pid} (x) S ${ppid} 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${st} 0`;
  for (const [pid, ppid, st] of [[10, 1, 111], [11, 10, 222]]) { mkdirSync(join(root, String(pid))); writeFileSync(join(root, String(pid), 'stat'), stat(pid, ppid, st)); }
  mkdirSync(join(root, 'self')); mkdirSync(join(root, '12'));
  const t = readProcTable(root).sort((a, b) => a.pid - b.pid);
  assert.deepStrictEqual(t, [E(10, 1, '111'), E(11, 10, '222')]);
});

// --- tracking ---
test('PT-A15 — trackStep adds children and the whole chain below the root, and not unrelated processes', () => {
  const t = trackStep(new Map(), [E(100, 1), E(101, 100), E(102, 101), E(200, 1), E(201, 200)], 100);
  assert.deepStrictEqual([...t.keys()].sort(), [100, 101, 102]);
  assert.deepStrictEqual(t.get(102), { ppid: 101, start: 's' });
});
test('PT-A15 — a tracked process stays tracked after it is reparented (ppid 1) and its new children are tracked', () => {
  const first = trackStep(new Map(), [E(100, 1), E(101, 100)], 100);
  const later = trackStep(first, [E(101, 1), E(150, 101)], 100); // shell 100 is gone, 101 reparented to init
  assert.deepStrictEqual([...later.keys()].sort(), [100, 101, 150]);
});
test('PT-A17 — a reused pid (different start time) is not treated as the tracked process nor as its child chain', () => {
  const first = trackStep(new Map(), [E(100, 1, 'a'), E(101, 100, 'a')], 100);
  const later = trackStep(first, [E(101, 1, 'ZZZ'), E(300, 101, 'b')], 100); // 101 now is a different process
  assert.strictEqual(later.get(101).start, 'a', 'the record keeps the original start time');
  assert.ok(!later.has(300), 'a child of an impostor pid is not a descendant');
});
test('PT-A17 — killablePids returns only alive, same-start pids; never <= 1 and never self', () => {
  const tracked = new Map([[100, { ppid: 1, start: 'a' }], [101, { ppid: 100, start: 'a' }], [102, { ppid: 100, start: 'a' }], [1, { ppid: 0, start: 'a' }], [process.pid, { ppid: 1, start: 'a' }], [0, { ppid: 0, start: 'a' }]]);
  const table = [E(100, 1, 'a'), E(101, 100, 'DIFFERENT'), E(1, 0, 'a'), E(process.pid, 1, 'a'), E(0, 0, 'a')]; // 102 is gone
  assert.deepStrictEqual(killablePids(tracked, table), [100]);
});

// --- end to end through the runner (real /usr/bin/perl: its env is invisible to ps on macOS) ---
const perl = (m, escape) => `/usr/bin/perl -e 'use POSIX; sleep 1; ${escape}; sleep 60' ${m}`;
const mkRunner = (over = {}) => { const runId = newRunId(); return createRunner({ runId, env: { ...process.env, QK_RUN_ID: runId }, timeoutMs: 60000, ...over }); };
for (const [name, escape] of [['setpgrp(0,0)', 'setpgrp(0,0)'], ['POSIX::setsid()', 'POSIX::setsid()']]) {
  test(`PT-A15/A16 — a perl descendant that called ${name} after 1 s is killed when the command exits 0`, async () => {
    const m = mark();
    const out = await mkRunner().run(`${perl(m, escape)} & sleep 2; exit 0`, tmpdir());
    assert.strictEqual(out.code, 0);
    assert.deepStrictEqual(await waitFor(() => pgrepMarker(m).length === 0, { timeoutMs: 2000 }), true, 'perl escapee must be dead');
  });
  test(`PT-A15/A16 — a perl descendant that called ${name} is killed when the command times out`, async () => {
    const m = mark();
    const out = await mkRunner({ timeoutMs: 3000 }).run(`${perl(m, escape)} & sleep 60`, tmpdir());
    assert.strictEqual(out.timedOut, true);
    assert.deepStrictEqual(await waitFor(() => pgrepMarker(m).length === 0, { timeoutMs: 2000 }), true, 'perl escapee must be dead');
  });
}
test('PT-A16 — killAll (abnormal exit path) also kills a tracked escapee', async () => {
  const m = mark(); const r = mkRunner();
  const p = r.run(`${perl(m, 'setpgrp(0,0)')} & sleep 60`, tmpdir());
  await new Promise((res) => setTimeout(res, 2200));       // the perl process has escaped its group by now
  r.killAll('SIGKILL');
  await p;
  assert.deepStrictEqual(await waitFor(() => pgrepMarker(m).length === 0, { timeoutMs: 2000 }), true);
});
