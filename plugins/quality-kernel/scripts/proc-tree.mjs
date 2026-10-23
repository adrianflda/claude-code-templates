// Process-tree control for the referee (spec: docs/specs/gate-process-tree/contract.md).
//
// A command runs in its own process group (detached spawn), so one kill(-pgid) reaches the shell, npm,
// vitest and its workers. Members that left the group are found through the run marker
// (QK_RUN_ID=<hex> in every command's environment). Linux is INFERRED, win32 is refused (fail-closed).
// Residual limit: a process that leaves the group AND scrubs its environment escapes every mechanism here.
import { spawn, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

export const KILL_GRACE_MS = 5000;
export const DEFAULT_TIMEOUT_SECONDS = 300;
const MIN_TIMEOUT_SECONDS = 1, MAX_TIMEOUT_SECONDS = 3600;
const DRAIN_MS = 1000; // bounded wait for stdout EOF once the group is dead (a scrubbed escapee may still hold it)
const SIGNALS = [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]; // 128 + signal number

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

export function killGroup(pgid, sig) {
  try { process.kill(-pgid, sig); } catch (e) { if (e.code !== 'ESRCH') throw e; }
}
export function groupAlive(pgid) {
  try { process.kill(-pgid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
}

// Pids of own-user processes whose environment carries `needle`. macOS: BSD-style `ps axeww` appends
// the environment (OBSERVED on Darwin 27; the dashed `-Aeww` form does NOT show it there). Linux:
// /proc/<pid>/environ (INFERRED).
function pidsCarrying(needle) {
  const out = [];
  if (existsSync('/proc/self/environ')) {
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      try { if (readFileSync(`/proc/${name}/environ`, 'latin1').includes(needle)) out.push(Number(name)); } catch { /* gone or not ours */ }
    }
    return out;
  }
  const ps = spawnSync('ps', ['axeww', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 64 << 20 });
  for (const line of (ps.stdout || '').split('\n')) {
    if (!line.includes(needle)) continue;
    const pid = Number(line.trim().split(/\s+/)[0]);
    if (pid && pid !== ps.pid) out.push(pid);
  }
  return out;
}
// PT-A6 / PT-C4: SIGKILL every process carrying the run marker (never this process).
export function sweepByMarker(runId) {
  for (const pid of pidsCarrying(`QK_RUN_ID=${runId}`)) {
    if (pid === process.pid) continue;
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

// Runs commands, each in its own process group. `env` must already carry the marker. `onGroup(pgid)`
// is invoked synchronously at spawn so the lock can persist it (Decision 18).
export function createRunner({ runId, env, timeoutMs, graceMs = KILL_GRACE_MS, onGroup = () => {} }) {
  const live = new Set();
  const killAll = (sig) => { for (const g of live) killGroup(g, sig); sweepByMarker(runId); };

  function run(cmd, cwd) {
    return new Promise((resolve) => {
      let c, pgid, timer, timedOut = false, hasStdout = false, done = false;
      const finish = (r) => {
        if (done) return;
        done = true; clearTimeout(timer); live.delete(pgid);
        resolve({ code: null, signal: null, timedOut, hasStdout, ...r });
      };
      try { c = spawn(cmd, { cwd, shell: true, detached: true, env, stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch (error) { finish({ error }); return; }
      c.on('error', (error) => finish({ error }));
      if (c.pid === undefined) return;
      pgid = c.pid;
      live.add(pgid);
      const stdoutClosed = new Promise((r) => c.stdout.once('close', r));
      c.stdout.on('data', (d) => { if (!hasStdout && /\S/.test(d.toString())) hasStdout = true; });
      c.stderr.resume();
      try { onGroup(pgid); }
      catch (error) { killGroup(pgid, 'SIGKILL'); finish({ error }); return; }

      // PT-A1/A2: SIGTERM the group, then SIGKILL after the grace if any member is still alive. The
      // shell leader usually dies on SIGTERM at once, so liveness is the GROUP's, not the leader's.
      timer = setTimeout(async () => {
        timedOut = true;
        killGroup(pgid, 'SIGTERM');
        const deadline = Date.now() + graceMs;
        while (groupAlive(pgid) && Date.now() < deadline) await sleep(50);
        killGroup(pgid, 'SIGKILL'); sweepByMarker(runId);
        finish({});
      }, timeoutMs);

      // 'exit', not 'close': a background member holding the pipes open delays 'close' (VERIFIED).
      c.on('exit', async (code, signal) => {
        if (timedOut) return;
        clearTimeout(timer);
        killGroup(pgid, 'SIGKILL'); sweepByMarker(runId); // PT-A4/A6: reap every straggler
        await Promise.race([stdoutClosed, sleep(DRAIN_MS)]);
        finish({ code, signal });
      });
    });
  }
  return { run, killAll, live };
}

// PT-A9/A10/A11: on any exit path the referee controls, kill every tree and release the lock.
// `cleanup` is synchronous and runs at most once.
export function installCleanup({ cleanup, onFatal = () => {}, proc = process }) {
  let ran = false;
  const once = () => { if (!ran) { ran = true; cleanup(); } };
  proc.on('exit', once);
  for (const [sig, code] of SIGNALS) proc.on(sig, () => { once(); proc.exit(code); });
  proc.on('uncaughtException', (err) => {
    once();
    try { proc.stderr.write(`${err && err.stack ? err.stack : err}\n`); onFatal(err); } finally { proc.exit(2); }
  });
}
