// Where a run journal lives and how it is written (spec §2, §4): <org>/.quality-kernel/runs/<run>/journal.jsonl,
// appended one fsynced line at a time under a short lock, with optimistic concurrency on the record count.
import { randomBytes } from 'node:crypto';
import { closeSync, constants as fsc, fstatSync, fsyncSync, ftruncateSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './git.mjs';
import { classifyLock, createExclusive, processStart, readLock } from '../process-safety/gate-session.mjs';
import { emptyState, fold, validate } from './schema.mjs';

export const RUN_ID = /^[0-9a-f]{16}$/;
const MAX_JOURNAL = 16 * 1024 * 1024;
const MAX_RECORD = 64 * 1024;
const NEWLINE = 0x0a;
// How long an append waits for a live holder before giving up with exit 3. Tests shorten it.
const LOCK_WAIT_MS = Math.min(Math.max(Number(process.env.QK_JOURNAL_LOCK_WAIT_MS) || 5000, 0), 60000);

const runsDir = (org) => join(org, '.quality-kernel', 'runs');
export const journalPath = (org, runId) => join(runsDir(org), runId, 'journal.jsonl');

// Each directory on the way must be a real directory (never a symlink out of the org folder).
function realDir(path, create) {
  if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
  let st;
  try { st = lstatSync(path); } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
  if (!st.isDirectory()) throw new Error(`${path} is not a real directory (symlink or other type) — refused`);
  return true;
}
function runDir(org, runId, create) {
  if (!RUN_ID.test(runId || '')) throw new Error('run id must be 16 hex characters');
  for (const p of [join(org, '.quality-kernel'), runsDir(org), join(runsDir(org), runId)]) {
    if (!realDir(p, create)) return null;
  }
  return join(runsDir(org), runId);
}

// The journal's bytes (empty when absent). Opened O_NOFOLLOW|O_NONBLOCK (a FIFO in its place must not
// block a resume forever) and accepted only as a regular file of bounded size.
function readBytes(org, runId) {
  if (!runDir(org, runId, false)) return Buffer.alloc(0);
  let fd;
  try { fd = openSync(journalPath(org, runId), fsc.O_RDONLY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK); } catch (e) { if (e.code === 'ENOENT') return Buffer.alloc(0); throw e; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_JOURNAL) throw new Error('journal is not a regular file or is too large — refused');
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

// Journal -> { state, seq, tornTail, completeBytes } or { error }. Bytes after the last newline are a
// torn tail (a write that never completed): reported, never parsed. The complete lines must be valid
// UTF-8 — a lossy decode would accept a damaged line and later truncate at a wrong offset.
export function loadRun(org, runId) {
  const buf = readBytes(org, runId);
  const completeBytes = buf.lastIndexOf(NEWLINE) + 1;
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, completeBytes)); } catch { return { error: 'journal is not valid UTF-8' }; }
  const f = fold(text, runId);
  return f.error ? f : { ...f, tornTail: completeBytes < buf.length, completeBytes };
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const sameHolder = (a, b) => Boolean(a && b) && a.pid === b.pid && a.lstart === b.lstart;

// Remove a dead holder's lock without ever deleting one we have not identified: move it aside
// atomically, and delete it only if it is still that holder's; otherwise put it back.
export function takeOverStale(path, stale) {
  const aside = `${path}.stale.${process.pid}.${randomBytes(6).toString('hex')}`;
  try { renameSync(path, aside); } catch { return; } // already gone: someone else took it over
  try {
    if (!sameHolder(readLock(aside), stale)) {
      // Raced: a new holder locked in between. Put its lock back; if yet another lock already exists,
      // that holder's pre-write ownership check fails and it writes nothing (exit 3).
      try { linkSync(aside, path); } catch { /* EEXIST */ }
    }
  } finally { try { unlinkSync(aside); } catch { /* best-effort */ } }
}

function lock(dir, runId) {
  const path = join(dir, 'journal.lock');
  const me = { pid: process.pid, lstart: processStart(process.pid), runId, pgids: [], descendants: [] };
  for (const deadline = Date.now() + LOCK_WAIT_MS; ; sleep(10)) {
    if (createExclusive(path, me)) {
      return {
        owned: () => sameHolder(readLock(path), me),
        // Never throws: a record already written must not be reported as a failure.
        release: () => { try { if (sameHolder(readLock(path), me)) unlinkSync(path); } catch { /* best-effort */ } },
      };
    }
    const held = readLock(path);
    if (held && classifyLock(held) === 'stale') takeOverStale(path, held);
    if (Date.now() >= deadline) return null;
  }
}

// Append `record` if the journal holds exactly `expectSeq` records and `record` validates.
// -> { code: 0, seq } | { code: 2, error } (invalid) | { code: 3, error } (conflict).
// `beforeWrite` is a test seam: it runs while the lock is held, after every check but the ownership one.
export function append(org, runId, expectSeq, record, { beforeWrite } = {}) {
  const line = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(line) > MAX_RECORD) return { code: 2, error: 'record too large' };
  // §2: the org folder holds repos, it is never inside one (the journal must not land in a tracked tree).
  // Only git's own "not a git repository" answer clears it; any other failure (unreadable or unsupported
  // repo, dubious ownership, git missing) could be a repo it failed to read: refused (fail closed).
  const inRepo = git(org, ['rev-parse', '--git-dir']);
  if (inRepo.error) return { code: 2, error: `cannot run git to check ${org}: ${inRepo.error.message}` };
  if (inRepo.status === 0) return { code: 2, error: `${org} is inside a git repository, not an org folder — refused` };
  if (inRepo.status !== 128 || !/not a git repository/i.test(inRepo.stderr || '')) {
    return { code: 2, error: `cannot tell whether ${org} is inside a git repository (${(inRepo.stderr || '').trim() || `exit ${inRepo.status}`}) — refused` };
  }
  // A first append that cannot succeed must not leave a run directory behind (it would be listed as open).
  if (!runDir(org, runId, false)) {
    if (expectSeq !== 0) return { code: 3, error: `expected seq ${expectSeq}, journal has 0` };
    const why = validate(record, emptyState(), runId);
    if (why) return { code: 2, error: why };
  }
  const dir = runDir(org, runId, true);
  const held = lock(dir, runId);
  if (!held) return { code: 3, error: 'journal lock busy' };
  try {
    const folded = loadRun(org, runId);
    if (folded.error) return { code: 2, error: `journal is corrupt: ${folded.error}` };
    if (folded.seq !== expectSeq) return { code: 3, error: `expected seq ${expectSeq}, journal has ${folded.seq}` };
    const why = validate(record, folded.state, runId);
    if (why) return { code: 2, error: why };
    beforeWrite?.();
    if (!held.owned()) return { code: 3, error: 'journal lock was lost before writing — nothing written' };
    // A journal the reader would refuse must never be written: refuse the record instead (§4).
    if (folded.completeBytes + Buffer.byteLength(line) > MAX_JOURNAL) return { code: 2, error: 'journal is full (16 MiB) — record refused' };
    const created = folded.seq === 0 && !folded.tornTail;
    const fd = openSync(journalPath(org, runId), fsc.O_WRONLY | fsc.O_APPEND | fsc.O_CREAT | fsc.O_NOFOLLOW | fsc.O_NONBLOCK, 0o600);
    try {
      if (!fstatSync(fd).isFile()) return { code: 2, error: 'journal is not a regular file — refused' };
      // §4: a torn tail (crash mid-write) is cut back to the byte after the last complete line.
      if (folded.tornTail) ftruncateSync(fd, folded.completeBytes);
      const bytes = Buffer.from(line);
      if (writeSync(fd, bytes) !== bytes.length) {
        ftruncateSync(fd, folded.completeBytes); // a short write leaves nothing behind
        return { code: 2, error: 'short write (disk full?) — nothing written' };
      }
      try { fsyncSync(fd); } catch (e) {
        return { code: 2, error: `record written but not confirmed durable (fsync: ${e.code || e.message}) — fold before retrying` };
      }
    } finally { closeSync(fd); }
    if (created) fsyncDir(dir);
    return { code: 0, seq: folded.seq + 1 };
  } finally { held.release(); }
}

// A new file's directory entry is durable only once its directory is fsynced.
function fsyncDir(dir) {
  let fd;
  try { fd = openSync(dir, fsc.O_RDONLY); fsyncSync(fd); } catch { /* not supported here: best-effort */ } finally { if (fd !== undefined) closeSync(fd); }
}

// Runs of the org whose journal has no run_finished (an unreadable journal counts as open: look at it).
// A run directory without a journal file never recorded anything (e.g. a crash before the first write).
const hasJournal = (org, id) => { try { lstatSync(journalPath(org, id)); return true; } catch (e) { return e.code !== 'ENOENT'; } };
export function openRuns(org) {
  if (!realDir(join(org, '.quality-kernel'), false) || !realDir(runsDir(org), false)) return [];
  return readdirSync(runsDir(org)).filter((id) => RUN_ID.test(id) && hasJournal(org, id)).filter((id) => {
    try { const f = loadRun(org, id); return Boolean(f.error) || !f.state.finished; } catch { return true; }
  }).sort();
}
