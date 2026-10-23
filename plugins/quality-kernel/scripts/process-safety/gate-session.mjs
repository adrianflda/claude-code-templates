// Process-safety lifecycle of one referee run (spec: docs/specs/gate-process-tree/contract.md): the
// run marker, the temp trees, the memory guard, the repository lock and the command runner. This is the
// referee's only entry into process-safety/; the referee keeps the verification logic, this module owns
// everything that must be torn down on every exit path the process controls (PT-A9..A13).
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { newRunId, createRunner, installCleanup } from './proc-tree.mjs';
import { acquireLock } from './gate-lock.mjs';
import { runMemoryGuard } from './mem-guard.mjs';

export { resolveTimeoutSeconds, unsupportedPlatformReason } from './proc-tree.mjs';

const NOT_EXECUTABLE_CODES = new Set([126, 127]);
const incompleteDetail = (r) => (r.error ? r.error.message : (r.signal ? `killed by ${r.signal}` : 'no exit status'));
// A runner result -> the indeterminate reason, or null when the command produced a usable exit code.
export function commandFailure(r, { label, cmd, timeoutSeconds }) {
  if (r.timedOut) return `${label} timed out after ${timeoutSeconds}s; process tree killed: "${cmd}"`;
  if (r.error || r.code === null) return `${label} could not complete: "${cmd}" (${incompleteDetail(r)})`;
  if (NOT_EXECUTABLE_CODES.has(r.code) && !r.hasStdout) return `${label} not executable (exit ${r.code}): "${cmd}"`;
  return null;
}

// Installs the cleanup before anything can be spawned. `onFatal(err)` reports an uncaught exception.
export function openSession({ onFatal }) {
  const runId = newRunId();
  const trees = new Set();
  let runner = null, lock = null;
  installCleanup({
    cleanup: () => {
      if (runner) runner.killAll('SIGKILL');
      if (lock) lock.release();
      for (const t of trees) { try { rmSync(t, { recursive: true, force: true }); } catch { /* best-effort */ } }
    },
    onFatal,
  });
  // PT-A13: the launching process died (even by SIGKILL) -> kill every tree, release the lock, exit.
  const launcherPid = process.ppid;
  setInterval(() => { if (process.ppid !== launcherPid) process.exit(129); }, 1000).unref();

  return {
    runId,
    // A fresh temp directory, removed by the cleanup if the caller does not remove it first.
    tempTree() { const d = mkdtempSync(join(tmpdir(), randomBytes(6).toString('hex'))); trees.add(d); return d; },
    // PT-C1: the memory guard, then the repository lock, then the runner -> null, or the refusal reason.
    // `env` must already carry the run marker.
    preflight({ repo, env, timeoutMs }) {
      const guard = runMemoryGuard();
      if (!guard.ok) return guard.reason;
      const acquired = acquireLock({ repo, runId, dir: process.env.QK_LOCK_DIR || tmpdir() });
      if (!acquired.ok) return acquired.reason;
      lock = acquired.lock;
      runner = createRunner({ runId, env, timeoutMs, onGroup: (pgid) => lock.addPgid(pgid), onTracked: (list) => lock.setDescendants(list) });
      return null;
    },
    run: (cmd, cwd) => runner.run(cmd, cwd),
  };
}
