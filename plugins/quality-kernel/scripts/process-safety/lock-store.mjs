// Lock-file storage for the repository lock (spec: docs/specs/gate-process-tree/contract.md, PT-C2..C7):
// one file per repository, keyed by the git common directory so every worktree shares it.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync, readFileSync, linkSync, unlinkSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

const RUN_ID_RE = /^[0-9a-f]{16}$/;

function commonDir(repo) {
  const r = spawnSync('git', ['-C', repo, 'rev-parse', '--git-common-dir'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git common dir unavailable for ${repo}`);
  return realpathSync(resolve(repo, r.stdout.trim()));
}
export function lockPathFor(repo, dir) {
  const key = createHash('sha1').update(commonDir(repo)).digest('hex').slice(0, 16);
  return join(dir, `qk-gate-${key}.lock`);
}

const parseJson = (raw) => { try { return JSON.parse(raw); } catch { return null; } };
const isLock = (j) => Boolean(j) && Number.isInteger(j.pid) && j.pid > 0 && typeof j.runId === 'string' && RUN_ID_RE.test(j.runId) && Array.isArray(j.pgids);
// Lock-file text -> the parsed lock, or null when malformed.
export function parseLock(raw) {
  const j = parseJson(raw);
  return isLock(j) ? j : null;
}
// undefined = no file, null = unreadable/malformed, else the parsed lock.
export function readLock(path) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); } catch (e) { return e.code === 'ENOENT' ? undefined : null; }
  return parseLock(raw);
}
export const tmpFor = (path) => `${path}.${process.pid}.tmp`;
// Create the lock with its full content or not at all: write a temp file, then link() it into place
// (link fails with EEXIST if a lock exists, and no reader ever sees a partial file).
export function createExclusive(path, payload) {
  const tmp = tmpFor(path);
  writeFileSync(tmp, JSON.stringify(payload));
  try { linkSync(tmp, path); return true; }
  catch (e) { if (e.code === 'EEXIST') return false; throw e; }
  finally { try { unlinkSync(tmp); } catch { /* best-effort */ } }
}
