// Taking over a stale repository lock (spec: docs/specs/gate-process-tree/contract.md, PT-C5..C6): kill
// every process group the dead run recorded, every recorded descendant still alive with its recorded
// start time (PT-A17), and every process carrying its marker.
import { renameSync, linkSync, unlinkSync } from 'node:fs';
import { killGroup, killRecorded, sweepByMarker } from './proc-tree.mjs';
import { readLock } from './lock-store.mjs';

function sweepStale(stale) {
  for (const g of stale.pgids) {
    if (!Number.isInteger(g) || g <= 1) continue;
    try { killGroup(g, 'SIGKILL'); } catch { /* not ours / gone */ }
  }
  killRecorded(Array.isArray(stale.descendants) ? stale.descendants : []);
  sweepByMarker(stale.runId);
}

const sameLock = (a, b) => Boolean(a) && a.pid === b.pid && a.runId === b.runId;

// Claim a lock judged stale by renaming it away (only one racer can win the rename), then confirm that
// what we moved is the lock we judged; if a fresh live lock slipped in, put it back. Callers retry.
export function takeOverStale(path, held) {
  const claimed = `${path}.${process.pid}.stale`;
  try { renameSync(path, claimed); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  if (!sameLock(readLock(claimed), held)) {
    try { linkSync(claimed, path); } catch { /* a newer lock already exists */ }
    try { unlinkSync(claimed); } catch { /* best-effort */ }
    return;
  }
  unlinkSync(claimed);
  sweepStale(held);
}
