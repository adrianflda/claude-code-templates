// Lock-file storage for the repository lock (spec: docs/specs/gate-process-tree/contract.md, PT-C2..C7, PT-C12):
// one file per repository, keyed by the git common directory so every worktree shares it.
//
// Lock schema: {pid, lstart, runId, repo, pgids: [{pgid, start} | legacy number], descendants: [{pid, start}]}.
// parseLock is the only reader; it normalises `descendants` to [] for locks written before PT-A18.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, linkSync, unlinkSync, realpathSync, renameSync, openSync, writeSync, closeSync, mkdirSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const RUN_ID_RE = /^[0-9a-f]{16}$/;
const GROUP_OR_WORLD_WRITABLE = 0o022;

function commonDir(repo) {
  const r = spawnSync('git', ['-C', repo, 'rev-parse', '--git-common-dir'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git common dir unavailable for ${repo}`);
  return realpathSync(resolve(repo, r.stdout.trim()));
}
export function lockPathFor(repo, dir) {
  const key = createHash('sha1').update(commonDir(repo)).digest('hex').slice(0, 16);
  return join(dir, `qk-gate-${key}.lock`);
}

// PT-C12/C13: the reason `st` (an lstat result) cannot be trusted as ours, or null.
export function untrustedReason(st, uid, kind) {
  if (kind === 'dir' ? !st.isDirectory() : !st.isFile()) return `is not a real ${kind === 'dir' ? 'directory' : 'file'} (symbolic link or other type)`;
  if (st.uid !== uid) return `is not owned by uid ${uid}`;
  if (st.mode & GROUP_OR_WORLD_WRITABLE) return 'is group- or world-writable';
  return null;
}
// PT-C12: create (0700) if absent, then require a real directory we own that others cannot write.
export function ensureLockDir(dir, uid = process.getuid()) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const why = untrustedReason(lstatSync(dir), uid, 'dir');
  if (why) throw new Error(`lock directory ${dir} ${why}`);
  return dir;
}
export const defaultLockDir = (base = tmpdir(), uid = process.getuid()) => ensureLockDir(join(base, `qk-gate-${uid}`), uid);

const parseJson = (raw) => { try { return JSON.parse(raw); } catch { return null; } };
const isLock = (j) => Boolean(j) && Number.isInteger(j.pid) && j.pid > 0 && typeof j.runId === 'string' && RUN_ID_RE.test(j.runId) && Array.isArray(j.pgids);
// Lock-file text -> the parsed lock, or null when malformed.
export function parseLock(raw) {
  const j = parseJson(raw);
  return isLock(j) ? { ...j, descendants: Array.isArray(j.descendants) ? j.descendants : [] } : null;
}
// undefined = no file, null = unreadable/malformed, else the parsed lock.
export function readLock(path) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); } catch (e) { return e.code === 'ENOENT' ? undefined : null; }
  return parseLock(raw);
}
// PT-C12: a fresh temp file, created exclusively (never through a link), mode 0600, unpredictable name.
function writeTemp(path, payload) {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600);
  try { writeSync(fd, JSON.stringify(payload)); } finally { closeSync(fd); }
  return tmp;
}
// Replace the lock atomically: temp file, then rename.
export function replaceLock(path, payload) {
  const tmp = writeTemp(path, payload);
  try { renameSync(tmp, path); } catch (e) { try { unlinkSync(tmp); } catch { /* best-effort */ } throw e; }
}
// Create the lock with its full content or not at all: write a temp file, then link() it into place
// (link fails with EEXIST if a lock exists, and no reader ever sees a partial file).
export function createExclusive(path, payload) {
  const tmp = writeTemp(path, payload);
  try { linkSync(tmp, path); return true; }
  catch (e) { if (e.code === 'EEXIST') return false; throw e; }
  finally { try { unlinkSync(tmp); } catch { /* best-effort */ } }
}
