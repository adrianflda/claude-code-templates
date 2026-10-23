// Process-tree control for the referee (spec: docs/specs/gate-process-tree/contract.md).
//
// A command runs in its own process group (detached spawn), so one kill(-pgid) reaches the shell, npm,
// vitest and its workers. Members that left the group are found through the run marker
// (QK_RUN_ID=<hex> in every command's environment). Linux is INFERRED, win32 is refused (fail-closed).
// Residual limit: a process that leaves the group AND scrubs its environment escapes every mechanism here.
import { randomBytes } from 'node:crypto';

// The pieces live in proc-group.mjs and proc-runner.mjs; other modules import them only through this one
// (enforced by import-graph.test.mjs).
export { killGroup, groupAlive, sweepByMarker, procfsPidsCarrying } from './proc-group.mjs';
export { KILL_GRACE_MS, createRunner } from './proc-runner.mjs';

export const DEFAULT_TIMEOUT_SECONDS = 300;
const MIN_TIMEOUT_SECONDS = 1, MAX_TIMEOUT_SECONDS = 3600;
export const TERMINATION_SIGNALS = [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]; // 128 + signal number

// PT-B1..B3: absent -> 300; present (even null) must be an integer 1..3600; never clamped or defaulted.
export function resolveTimeoutSeconds(tools) {
  if (!Object.hasOwn(tools, 'timeoutSeconds')) return { seconds: DEFAULT_TIMEOUT_SECONDS };
  const v = tools.timeoutSeconds;
  if (!Number.isInteger(v) || v < MIN_TIMEOUT_SECONDS || v > MAX_TIMEOUT_SECONDS) {
    return { error: `tools.json "timeoutSeconds" must be an integer between ${MIN_TIMEOUT_SECONDS} and ${MAX_TIMEOUT_SECONDS} at base (got ${JSON.stringify(v)})` };
  }
  return { seconds: v };
}

// PT-A14: the gate relies on POSIX process groups and signals.
export function unsupportedPlatformReason(platform) {
  return platform === 'win32'
    ? 'unsupported platform win32: the gate needs POSIX process groups and signals to guarantee that no command outlives the run'
    : null;
}

export const newRunId = () => randomBytes(8).toString('hex');

// PT-A9/A10/A11: on any exit path the referee controls, kill every tree and release the lock.
// `cleanup` is synchronous and runs at most once.
export function installCleanup({ cleanup, onFatal = () => {}, proc = process }) {
  let ran = false;
  const once = () => { if (!ran) { ran = true; cleanup(); } };
  proc.on('exit', once);
  for (const [sig, code] of TERMINATION_SIGNALS) proc.on(sig, () => { once(); proc.exit(code); });
  proc.on('uncaughtException', (err) => {
    once();
    try { proc.stderr.write(`${err && err.stack ? err.stack : err}\n`); onFatal(err); } finally { proc.exit(2); }
  });
}
