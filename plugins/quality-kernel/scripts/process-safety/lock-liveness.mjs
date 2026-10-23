// Holder liveness for the repository lock: a holder is live only if its pid exists AND its start time
// still equals the recorded `lstart` (PID reuse => stale).
import { spawnSync } from 'node:child_process';

// Process start time, the PID-reuse discriminator. null when unreadable (pid gone or no ps).
export function processStart(pid) {
  const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
  const s = (r.stdout || '').trim();
  return r.status === 0 && s ? s : null;
}
function pidExists(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
}
const startChanged = (lock, now) => Boolean(lock.lstart && now && now !== lock.lstart);
// 'live' | 'stale'. An unreadable current start time keeps the holder live (never kill on doubt).
export function classifyLock(lock, { exists = pidExists, start = processStart } = {}) {
  if (!exists(lock.pid)) return 'stale';
  return startChanged(lock, start(lock.pid)) ? 'stale' : 'live';
}
