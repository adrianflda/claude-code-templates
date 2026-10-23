// Repository lock for the referee (spec: docs/specs/gate-process-tree/contract.md, PT-C2..C7).
// One lock file per repository (keyed by the git common directory, so every worktree shares it):
// {pid, lstart, runId, repo, pgids[]}. A holder is live only if its pid exists AND its start time
// still equals the recorded `lstart` (PID reuse => stale). Taking over a stale lock kills every
// process group the dead run recorded and every process carrying its marker.
import { writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs';
import { lockPathFor, readLock, tmpFor, createExclusive } from './lock-store.mjs';
import { processStart, classifyLock } from './lock-liveness.mjs';
import { takeOverStale } from './lock-takeover.mjs';

export { lockPathFor, processStart, classifyLock };

// null = the holder may be taken over (stale), else the refusal reason.
function holderRefusal(held, path) {
  if (held === null) return `repository lock ${path} is unreadable or corrupt; refusing to guess (remove it if no gate run is active)`;
  if (classifyLock(held) !== 'live') return null;
  return `another gate run is active for this repository (pid ${held.pid}, started ${held.lstart || 'unknown'}, lock ${path})`;
}

export function acquireLock({ repo, runId, dir }) {
  let path;
  try { mkdirSync(dir, { recursive: true }); path = lockPathFor(repo, dir); }
  catch (e) { return { ok: false, reason: `cannot create the repository lock: ${e.message}` }; }
  const payload = { pid: process.pid, lstart: processStart(process.pid), runId, repo, pgids: [], descendants: [] };
  for (let attempt = 0; attempt < 3; attempt++) {
    if (createExclusive(path, payload)) return { ok: true, lock: ownedLock(path, payload) };
    const held = readLock(path);
    if (held === undefined) continue;
    const reason = holderRefusal(held, path);
    if (reason) return { ok: false, reason };
    takeOverStale(path, held);
  }
  return { ok: false, reason: `another gate run is active for this repository (lock ${path} changed hands repeatedly)` };
}

function ownedLock(path, payload) {
  const pgids = [];
  let descendants = [];
  const persist = () => {
    const tmp = tmpFor(path);
    writeFileSync(tmp, JSON.stringify({ ...payload, pgids, descendants }));
    renameSync(tmp, path);
  };
  return {
    path,
    // Decision 18: persisted at every spawn through temp file + rename, so a SIGKILL mid-command is recoverable.
    addPgid(g) {
      if (pgids.includes(g)) return;
      pgids.push(g);
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
