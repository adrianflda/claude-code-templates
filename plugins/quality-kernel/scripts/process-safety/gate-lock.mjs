// Repository lock for the referee (spec: docs/specs/gate-process-tree/contract.md, PT-C2..C7, PT-C12..C15).
// One lock file per repository (keyed by the git common directory, so every worktree shares it); the
// schema lives in lock-store.mjs. A holder is live only if its pid exists AND its start time still equals
// the recorded `lstart` (PID reuse => stale). Taking over a stale lock kills what the dead run left behind.
import { unlinkSync } from 'node:fs';
import { lockPathFor, readLock, replaceLock, createExclusive, ensureLockDir, defaultLockDir } from './lock-store.mjs';
import { startTimeOf } from './proc-tree.mjs';
import { processStart, classifyLock } from './lock-liveness.mjs';
import { takeOverStale, reapStranded, reapTempFiles, lockDistrust } from './lock-takeover.mjs';

export { lockPathFor, processStart, classifyLock, defaultLockDir };

// null = the holder may be taken over (stale), else the refusal reason.
function holderRefusal(held, path, uid) {
  if (held === null) return lockDistrust(path, uid) || `repository lock ${path} is unreadable or corrupt; refusing to guess (remove it if no gate run is active)`;
  if (classifyLock(held) !== 'live') return null;
  return `another gate run is active for this repository (pid ${held.pid}, started ${held.lstart || 'unknown'}, lock ${path})`;
}

export function acquireLock({ repo, runId, dir, uid = process.getuid() }) {
  let path;
  try { ensureLockDir(dir, uid); path = lockPathFor(repo, dir); }
  catch (e) { return { ok: false, reason: `cannot create the repository lock: ${e.message}` }; }
  reapTempFiles(path, { uid });
  const stranded = reapStranded(path, { uid });
  if (stranded) return { ok: false, reason: stranded };
  const payload = { pid: process.pid, lstart: processStart(process.pid), runId, repo, pgids: [], descendants: [] };
  for (let attempt = 0; attempt < 3; attempt++) {
    if (createExclusive(path, payload)) return { ok: true, lock: ownedLock(path, payload) };
    const held = readLock(path);
    if (held === undefined) continue;
    const reason = holderRefusal(held, path, uid);
    if (reason) return { ok: false, reason };
    const refusal = takeOverStale(path, held);
    if (refusal) return { ok: false, reason: refusal };
  }
  return { ok: false, reason: `another gate run is active for this repository (lock ${path} changed hands repeatedly)` };
}

function ownedLock(path, payload) {
  const pgids = [];
  let descendants = [];
  const persist = () => replaceLock(path, { ...payload, pgids, descendants });
  return {
    path,
    // Decision 18: persisted at every spawn through temp file + rename, so a SIGKILL mid-command is recoverable.
    // PT-C14: the leader's start time is recorded with the pgid, so a recycled pgid is recognisable.
    addPgid(g) {
      if (pgids.some((e) => e.pgid === g)) return;
      pgids.push({ pgid: g, start: startTimeOf(g) });
      persist();
    },
    // PT-C14: a reaped group no longer needs to be killed by a later takeover.
    removePgid(g) {
      const i = pgids.findIndex((e) => e.pgid === g);
      if (i < 0) return;
      pgids.splice(i, 1);
      persist();
    },
    // PT-A18: the tracked descendants, replaced atomically; an unchanged set is not rewritten.
    setDescendants(list) {
      if (JSON.stringify(list) === JSON.stringify(descendants)) return;
      descendants = list;
      persist();
    },
    release() {
      const cur = readLock(path);
      if (cur && cur.runId === payload.runId && cur.pid === payload.pid) { try { unlinkSync(path); } catch { /* gone */ } }
    },
  };
}
