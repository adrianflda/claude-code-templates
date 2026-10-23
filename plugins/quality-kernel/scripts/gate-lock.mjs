// Repository lock for the referee (spec: docs/specs/gate-process-tree/contract.md, PT-C2..C7).
// One lock file per repository (keyed by the git common directory, so every worktree shares it):
// {pid, lstart, runId, repo, pgids[]}. A holder is live only if its pid exists AND its start time
// still equals the recorded `lstart` (PID reuse => stale). Taking over a stale lock kills every
// process group the dead run recorded and every process carrying its marker.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync, readFileSync, renameSync, linkSync, unlinkSync, realpathSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { killGroup, sweepByMarker } from './proc-tree.mjs';

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

// Process start time, the PID-reuse discriminator. null when unreadable (pid gone or no ps).
export function processStart(pid) {
  const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
  const s = (r.stdout || '').trim();
  return r.status === 0 && s ? s : null;
}
function pidExists(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
}
// 'live' | 'stale'. An unreadable current start time keeps the holder live (never kill on doubt).
export function classifyLock(lock, { exists = pidExists, start = processStart } = {}) {
  if (!exists(lock.pid)) return 'stale';
  const now = start(lock.pid);
  return lock.lstart && now && now !== lock.lstart ? 'stale' : 'live';
}

// undefined = no file, null = unreadable/malformed, else the parsed lock.
function readLock(path) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return undefined; return null; }
  try {
    const j = JSON.parse(raw);
    const ok = j && Number.isInteger(j.pid) && j.pid > 0 && typeof j.runId === 'string' && RUN_ID_RE.test(j.runId) && Array.isArray(j.pgids);
    return ok ? j : null;
  } catch { return null; }
}
const tmpFor = (path) => `${path}.${process.pid}.tmp`;
// Create the lock with its full content or not at all: write a temp file, then link() it into place
// (link fails with EEXIST if a lock exists, and no reader ever sees a partial file).
function createExclusive(path, payload) {
  const tmp = tmpFor(path);
  writeFileSync(tmp, JSON.stringify(payload));
  try { linkSync(tmp, path); return true; }
  catch (e) { if (e.code === 'EEXIST') return false; throw e; }
  finally { try { unlinkSync(tmp); } catch { /* best-effort */ } }
}
function sweepStale(stale) {
  for (const g of stale.pgids) {
    if (!Number.isInteger(g) || g <= 1) continue;
    try { killGroup(g, 'SIGKILL'); } catch { /* not ours / gone */ }
  }
  sweepByMarker(stale.runId);
}

export function acquireLock({ repo, runId, dir }) {
  let path;
  try { mkdirSync(dir, { recursive: true }); path = lockPathFor(repo, dir); }
  catch (e) { return { ok: false, reason: `cannot create the repository lock: ${e.message}` }; }
  const payload = { pid: process.pid, lstart: processStart(process.pid), runId, repo, pgids: [] };
  for (let attempt = 0; attempt < 3; attempt++) {
    if (createExclusive(path, payload)) return { ok: true, lock: ownedLock(path, payload) };
    const held = readLock(path);
    if (held === undefined) continue;
    if (held === null) return { ok: false, reason: `repository lock ${path} is unreadable or corrupt; refusing to guess (remove it if no gate run is active)` };
    if (classifyLock(held) === 'live') {
      return { ok: false, reason: `another gate run is active for this repository (pid ${held.pid}, started ${held.lstart || 'unknown'}, lock ${path})` };
    }
    // Stale. Claim it by renaming it away (only one racer can win the rename), then confirm that what
    // we moved is the stale lock we judged; if a fresh live lock slipped in, put it back.
    const claimed = `${path}.${process.pid}.stale`;
    try { renameSync(path, claimed); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    const moved = readLock(claimed);
    if (!moved || moved.pid !== held.pid || moved.runId !== held.runId) {
      try { linkSync(claimed, path); } catch { /* a newer lock already exists */ }
      try { unlinkSync(claimed); } catch { /* best-effort */ }
      continue;
    }
    unlinkSync(claimed);
    sweepStale(held);
  }
  return { ok: false, reason: `another gate run is active for this repository (lock ${path} changed hands repeatedly)` };
}

function ownedLock(path, payload) {
  const pgids = [];
  return {
    path,
    // Decision 18: persisted at every spawn through temp file + rename, so a SIGKILL mid-command is recoverable.
    addPgid(g) {
      if (pgids.includes(g)) return;
      pgids.push(g);
      const tmp = tmpFor(path);
      writeFileSync(tmp, JSON.stringify({ ...payload, pgids }));
      renameSync(tmp, path);
    },
    release() {
      const cur = readLock(path);
      if (cur && cur.runId === payload.runId && cur.pid === payload.pid) { try { unlinkSync(path); } catch { /* gone */ } }
    },
  };
}
