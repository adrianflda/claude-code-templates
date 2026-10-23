// Taking over a stale repository lock (spec: docs/specs/gate-process-tree/contract.md, PT-C5, PT-C6, PT-C13..C15):
// kill every recorded process group whose identity still holds, every recorded descendant still alive with
// its recorded start time (PT-A17), and every process carrying the run's marker.
import { renameSync, linkSync, unlinkSync, lstatSync } from 'node:fs';
import { killGroup, killRecorded, sweepByMarker, pidsCarryingMarker, pgidsOf, startTimeOf } from './proc-tree.mjs';
import { readLock, untrustedReason } from './lock-store.mjs';

// A pgids entry is {pgid, start} or, in locks written before PT-C14, a plain number without identity.
const asEntry = (g) => (g !== null && typeof g === 'object' ? { pgid: g.pgid, start: g.start ?? null, legacy: false } : { pgid: g, start: null, legacy: true });

function sweepStale(stale) {
  const carriers = pidsCarryingMarker(stale.runId);
  const markedGroups = pgidsOf(carriers);
  const own = pgidsOf([process.pid]);
  for (const { pgid, start, legacy } of stale.pgids.map(asEntry)) {
    if (!Number.isInteger(pgid) || pgid <= 1 || own.has(pgid)) continue;
    const identified = legacy || (start !== null && startTimeOf(pgid) === start) || markedGroups.has(pgid);
    if (!identified) continue; // PT-C14: the pgid may have been recycled for an unrelated group
    try { killGroup(pgid, 'SIGKILL'); } catch { /* not ours / gone */ }
  }
  killRecorded(stale.descendants);
  sweepByMarker(stale.runId, carriers);
}

const sameLock = (a, b) => Boolean(a) && a.pid === b.pid && a.runId === b.runId && (a.lstart ?? null) === (b.lstart ?? null);

// PT-C13: a stale lock is honoured only if it is a regular file we own that others cannot write.
function lockDistrust(path, uid) {
  let st;
  try { st = lstatSync(path); } catch (e) { return e.code === 'ENOENT' ? null : `cannot inspect ${e.message}`; }
  const why = untrustedReason(st, uid, 'file');
  return why ? `repository lock ${path} is untrusted (${why}); refusing to act on it` : null;
}

// Claim a lock judged stale by renaming it away (only one racer can win the rename), then confirm that
// what we moved is the lock we judged (PT-C15); if not, put it back. Returns null (callers retry) or the
// reason the run must refuse. `sweep` and `link` are injectable for tests.
export function takeOverStale(path, held, { sweep = sweepStale, link = linkSync, uid = process.getuid() } = {}) {
  const distrust = lockDistrust(path, uid);
  if (distrust) return distrust;
  const claimed = `${path}.${process.pid}.stale`;
  try { renameSync(path, claimed); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  if (!sameLock(readLock(claimed), held)) {
    try { link(claimed, path); } catch (e) {
      return `repository lock ${path} was replaced while it was being taken over and the displaced record could not be restored (${e.message}); it is kept at ${claimed}`;
    }
    try { unlinkSync(claimed); } catch { /* best-effort */ }
    return null;
  }
  sweep(held); // PT-C15: before the record goes away, so a crash here leaves it for diagnosis
  unlinkSync(claimed);
  return null;
}
