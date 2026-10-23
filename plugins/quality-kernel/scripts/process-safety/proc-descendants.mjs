// Descendant tracking for gate commands (spec: docs/specs/gate-process-tree/contract.md, PT-A15..A17).
//
// Process groups and the QK_RUN_ID marker both miss a descendant that left its group (setpgrp, setsid)
// and hides its environment (macOS: Apple platform binaries such as /usr/bin/perl). So while a command
// runs, periodic process-table snapshots record every descendant with its pid, ppid and START TIME, and
// keep it tracked after it leaves the group or is reparented. At the end the survivors are killed, but
// only if the pid still has the recorded start time (a reused pid is never signalled). Residual limit:
// a process created and detached within one snapshot interval is never seen. Linux is INFERRED.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';

const SNAPSHOT_MS = 200; // contract: at most 500 ms between snapshots; ps itself costs some of the margin
const MAX_KILL_PASSES = 5;

// `ps -A -o pid=,ppid=,lstart=` -> [{pid, ppid, start}]; lstart is five words.
export function parsePsTable(stdout) {
  const out = [];
  for (const line of stdout.split('\n')) {
    const t = line.trim().split(/\s+/);
    const pid = Number(t[0]), ppid = Number(t[1]);
    if (t.length >= 3 && Number.isInteger(pid) && Number.isInteger(ppid)) out.push({ pid, ppid, start: t.slice(2).join(' ') });
  }
  return out;
}

// /proc/<pid>/stat: "pid (comm) state ppid ... starttime(field 22) ..."; comm may contain spaces and ")".
export function parseProcStat(pid, text) {
  const close = text.lastIndexOf(')');
  if (close < 0) return null;
  const rest = text.slice(close + 2).split(' ');
  const ppid = Number(rest[1]), start = rest[19];
  return Number.isInteger(ppid) && start ? { pid, ppid, start } : null;
}
export function readProcTable(root = '/proc') {
  const out = [];
  for (const name of readdirSync(root)) {
    if (!/^\d+$/.test(name)) continue;
    try { const e = parseProcStat(Number(name), readFileSync(`${root}/${name}/stat`, 'latin1')); if (e) out.push(e); } catch { /* gone */ }
  }
  return out;
}
function snapshotTable() {
  if (existsSync('/proc/self/stat')) return readProcTable();
  const ps = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,lstart='], { encoding: 'utf8', maxBuffer: 64 << 20, env: { ...process.env, LC_ALL: 'C' } });
  return parsePsTable(ps.stdout || '');
}

// Adds to `tracked` (pid -> {ppid, start}) every process in `table` that is the root or a child of a
// tracked process. A parent counts only if its current start time equals the recorded one, so a reused
// pid can neither be mistaken for a tracked process nor extend the chain. Records are never dropped.
export function trackStep(tracked, table, rootPid) {
  const byPid = new Map(table.map((e) => [e.pid, e]));
  const next = new Map(tracked);
  const parentTracked = (ppid) => { const rec = next.get(ppid), cur = byPid.get(ppid); return !!rec && !!cur && rec.start === cur.start; };
  const qualifies = (e) => {
    const rec = next.get(e.pid);
    if (rec && rec.start === e.start) return false; // already tracked
    return (e.pid === rootPid && !rec) || parentTracked(e.ppid);
  };
  for (let grew = true; grew;) {
    grew = false;
    for (const e of table) if (qualifies(e)) { next.set(e.pid, { ppid: e.ppid, start: e.start }); grew = true; }
  }
  return next;
}

// PT-A17: pids that are still alive with the recorded start time. Never pid <= 1 and never this process.
export function killablePids(tracked, table) {
  const startOf = new Map(table.map((e) => [e.pid, e.start]));
  return [...tracked].filter(([pid, rec]) => pid > 1 && pid !== process.pid && startOf.get(pid) === rec.start).map(([pid]) => pid);
}

const sigkill = (pid) => { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } };

// One tracker per command. start() begins the snapshots, stop() ends them, killRemaining() is PT-A16.
export function createTracker({ rootPid, snapshot = snapshotTable, intervalMs = SNAPSHOT_MS, kill = sigkill }) {
  let tracked = new Map(), timer = null;
  const observe = () => { const table = snapshot(); tracked = trackStep(tracked, table, rootPid); return table; };
  return {
    start() { observe(); timer = setInterval(observe, intervalMs); timer.unref(); },
    stop() { clearInterval(timer); },
    killRemaining() {
      for (let pass = 0; pass < MAX_KILL_PASSES; pass++) {
        const pids = killablePids(tracked, observe());
        if (!pids.length) return;
        pids.forEach(kill);
      }
    },
  };
}
