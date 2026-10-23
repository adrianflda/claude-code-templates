// Process-group primitives for the gate (spec: docs/specs/gate-process-tree/contract.md): signal a
// group, test its liveness, and find or kill every process carrying the run marker. Linux is INFERRED.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';

export function killGroup(pgid, sig) {
  try { process.kill(-pgid, sig); } catch (e) { if (e.code !== 'ESRCH') throw e; }
}
export function groupAlive(pgid) {
  try { process.kill(-pgid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
}

// Pids of own-user processes whose environment carries `needle`. macOS: BSD-style `ps axeww` appends
// the environment (OBSERVED on Darwin 27; the dashed `-Aeww` form does NOT show it there). Linux:
// /proc/<pid>/environ (INFERRED).
export function procfsPidsCarrying(needle, root = '/proc') {
  const out = [];
  for (const name of readdirSync(root)) {
    if (!/^\d+$/.test(name)) continue;
    try { if (readFileSync(`${root}/${name}/environ`, 'latin1').includes(needle)) out.push(Number(name)); } catch { /* gone or not ours */ }
  }
  return out;
}
// Pids on `ps -o pid=,command=` lines that carry `needle`, minus `psPid` (the ps process itself).
export function parsePsPids(stdout, needle, psPid) {
  const out = [];
  for (const line of stdout.split('\n')) {
    if (!line.includes(needle)) continue;
    const pid = Number(line.trim().split(/\s+/)[0]);
    if (pid && pid !== psPid) out.push(pid);
  }
  return out;
}
function psPidsCarrying(needle) {
  const ps = spawnSync('ps', ['axeww', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 64 << 20 });
  return parsePsPids(ps.stdout || '', needle, ps.pid);
}
const pidsCarrying = (needle) => (existsSync('/proc/self/environ') ? procfsPidsCarrying(needle) : psPidsCarrying(needle));
// PT-A6 / PT-C4: SIGKILL every process carrying the run marker (never this process).
export function sweepByMarker(runId) {
  for (const pid of pidsCarrying(`QK_RUN_ID=${runId}`)) {
    if (pid === process.pid) continue;
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}
