// Taking over a stale repository lock (spec: docs/specs/gate-process-tree/contract.md, PT-C5, PT-C6, PT-C13..C16):
// kill every recorded process group whose identity still holds, every recorded descendant still alive with
// its recorded start time (PT-A17), and every process carrying the run's marker.
import { randomBytes } from 'node:crypto';
import { renameSync, linkSync, unlinkSync, lstatSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { killGroup, killRecorded, sweepByMarker, pidsCarryingMarker, pgidsOf, startTimeOf } from './proc-tree.mjs';
import { readLock, untrustedReason, createExclusive } from './lock-store.mjs';
import { classifyLock, processStart } from './lock-liveness.mjs';

// `kill` is injectable so tests can assert which groups are (not) signalled.
export function sweepStale(stale, { kill = killGroup } = {}) {
  const carriers = pidsCarryingMarker(stale.runId);
  const markedGroups = pgidsOf(carriers);
  const own = pgidsOf([process.pid]);
  for (const entry of stale.pgids) {
    if (entry === null || typeof entry !== 'object') continue; // parseLock rejects these; injected records stay safe
    const { pgid, start = null } = entry;
    if (!Number.isInteger(pgid) || pgid <= 1 || own.has(pgid)) continue;
    const identified = (start !== null && startTimeOf(pgid) === start) || markedGroups.has(pgid);
    if (!identified) continue; // PT-C14: the pgid may have been recycled for an unrelated group
    try { kill(pgid, 'SIGKILL'); } catch { /* not ours / gone */ }
  }
  killRecorded(stale.descendants);
  sweepByMarker(stale.runId, carriers);
}

const sameLock = (a, b) => Boolean(a) && a.pid === b.pid && a.runId === b.runId && (a.lstart ?? null) === (b.lstart ?? null);

// PT-C13: a stale lock is honoured only if it is a regular file we own that others cannot write.
export function lockDistrust(path, uid) {
  let st;
  try { st = lstatSync(path); } catch (e) { return e.code === 'ENOENT' ? null : `cannot inspect ${e.message}`; }
  const why = untrustedReason(st, uid, 'file');
  return why ? `repository lock ${path} is untrusted (${why}); refusing to act on it` : null;
}

// PT-C6: takeovers are serialised by a token (`<lock>.takeover`, created exclusively through link()).
// Without it a racer that judged an old stale record could rename away the LIVE lock another racer had
// just created in its place; while that lock was out, a third racer created its own and two runs
// proceeded (observed: six racers, two winners). While a racer holds the token and the lock still is the
// record it judged, nobody else can remove that record, so the rename below only ever moves the judged
// lock. A token left by a dead claimer (a referee killed mid-takeover) is reaped by the next racer.
// Residual: two racers reaping the same dead token at once can, in the worst interleaving, both end up
// holding a token — that needs a referee killed mid-takeover AND a three-way race on its token.
const tokenPathFor = (path) => `${path}.takeover`;
const busy = (path) => `another gate run is active for this repository (it is taking over the stale lock ${path})`;

// The token record = ours; null = retry; a string = the reason the run must refuse.
function claimToken(path, uid) {
  const token = tokenPathFor(path);
  const mine = { pid: process.pid, lstart: processStart(process.pid), runId: randomBytes(8).toString('hex'), repo: '', pgids: [], descendants: [] };
  if (createExclusive(token, mine)) return mine;
  const cur = readLock(token, uid);
  if (cur === undefined) return null;
  if (cur === null) return `takeover token ${token} is unreadable, corrupt or untrusted; refusing to guess (remove it if no gate run is active)`;
  if (classifyLock(cur) === 'live') return busy(path);
  const reaped = `${token}.${process.pid}.reap`;
  try { renameSync(token, reaped); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  if (!sameLock(readLock(reaped, uid), cur)) { try { linkSync(reaped, token); } catch { /* another racer holds a fresh token */ } }
  try { unlinkSync(reaped); } catch { /* best-effort */ }
  return null;
}
function releaseToken(path, mine, uid) {
  const token = tokenPathFor(path);
  if (sameLock(readLock(token, uid), mine)) { try { unlinkSync(token); } catch { /* gone */ } }
}

// Claim a lock judged stale: under the takeover token, re-check that the lock is still the record judged,
// rename it away, confirm that what we moved is the lock we judged (PT-C15; defensive under the token)
// and, if not, put it back. Returns null (callers retry) or the reason the run must refuse. `sweep`,
// `link` and `rename` are injectable for tests.
export function takeOverStale(path, held, { sweep = sweepStale, link = linkSync, rename = renameSync, uid = process.getuid() } = {}) {
  const distrust = lockDistrust(path, uid);
  if (distrust) return distrust;
  const mine = claimToken(path, uid);
  if (mine === null || typeof mine === 'string') return mine;
  try {
    if (!sameLock(readLock(path, uid), held)) return null; // replaced since it was judged: never move it
    return moveAsideAndSweep(path, held, { sweep, link, rename, uid });
  } finally { releaseToken(path, mine, uid); }
}

function moveAsideAndSweep(path, held, { sweep, link, rename, uid }) {
  const claimed = `${path}.${process.pid}.stale`;
  try { rename(path, claimed); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  if (!sameLock(readLock(claimed, uid), held)) {
    try { link(claimed, path); } catch (e) {
      return `repository lock ${path} was replaced while it was being taken over and the displaced record could not be restored (${e.message}); it is kept at ${claimed}`;
    }
    try { unlinkSync(claimed); } catch { /* best-effort */ }
    return null;
  }
  sweep(held); // PT-C15: before the record goes away, so a crash here leaves it for diagnosis
  try { unlinkSync(claimed); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return null;
}

const pidExists = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };

// PT-C15: records stranded by a referee killed between "moved aside" and "removed" (`<lock>.<claimer>.stale`).
// Each one whose claimer is dead is read under the PT-C13 trust checks; if its holder is stale it is claimed by
// rename (one racer wins), swept, then removed; if its holder is live the displaced lock is put back. A record
// whose claimer is alive is a takeover in progress and is left alone. Returns null or the refusal reason.
export function reapStranded(path, { sweep = sweepStale, link = linkSync, uid = process.getuid() } = {}) {
  const dir = dirname(path), prefix = `${basename(path)}.`;
  for (const name of readdirSync(dir)) {
    const m = name.startsWith(prefix) && /^(\d+)\.stale$/.exec(name.slice(prefix.length));
    if (!m || pidExists(Number(m[1]))) continue;
    const file = join(dir, name);
    const distrust = lockDistrust(file, uid);
    if (distrust) return distrust;
    const claimed = `${path}.${process.pid}.stale`;
    try { renameSync(file, claimed); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    const rec = readLock(claimed, uid);
    if (!rec) return `stranded record ${file} is unreadable or corrupt; refusing to guess (kept at ${claimed})`;
    if (classifyLock(rec) === 'live') {
      try { link(claimed, path); } catch { return `a live run's lock was displaced and could not be restored; it is kept at ${claimed}`; }
    } else sweep(rec);
    unlinkSync(claimed);
  }
  return null;
}

// PT-C16: temp files (`<lock>.<pid>.<12 hex>.tmp`, see writeTemp) left by a writer killed mid lock write.
// Only this repository's names, only regular files we own that others cannot write (lstat, no link is
// followed), only when the writer pid is dead; anything else is not a lock record and is left untouched.
export function reapTempFiles(path, { uid = process.getuid() } = {}) {
  const dir = dirname(path), prefix = `${basename(path)}.`;
  for (const name of readdirSync(dir)) {
    const m = name.startsWith(prefix) && /^(\d+)\.[0-9a-f]{12}\.tmp$/.exec(name.slice(prefix.length));
    if (!m || pidExists(Number(m[1]))) continue;
    const file = join(dir, name);
    try { if (!untrustedReason(lstatSync(file), uid, 'file')) unlinkSync(file); } catch { /* gone or not ours to judge */ }
  }
}
