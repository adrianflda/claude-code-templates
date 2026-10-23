// Runs gate commands, each in its own process group (spec: docs/specs/gate-process-tree/contract.md).
import { spawn } from 'node:child_process';
import { killGroup, groupAlive, sweepByMarker } from './proc-group.mjs';
import { createTracker } from './proc-descendants.mjs';

export const KILL_GRACE_MS = 5000;
const DRAIN_MS = 1000; // bounded wait for stdout EOF once the group is dead (a scrubbed escapee may still hold it)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs commands, each in its own process group. `env` must already carry the marker. `onGroup(pgid)`
// is invoked synchronously at spawn so the lock can persist it (Decision 18).
export function createRunner({ runId, env, timeoutMs, graceMs = KILL_GRACE_MS, onGroup = () => {}, onTracked = () => {} }) {
  const live = new Set(), trackers = new Set();
  const killAll = (sig) => { for (const g of live) killGroup(g, sig); sweepByMarker(runId); for (const t of trackers) t.killRemaining(); };

  function run(cmd, cwd) {
    return new Promise((resolve) => {
      let c, pgid, timer, tracker, timedOut = false, hasStdout = false, done = false;
      const finish = (r) => {
        if (done) return;
        done = true; clearTimeout(timer); live.delete(pgid);
        if (tracker) { tracker.stop(); trackers.delete(tracker); onTracked([]); }
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
      // The pgid is persisted first (Decision 18): the snapshot below blocks for tens of milliseconds.
      tracker = createTracker({ rootPid: pgid, onChange: onTracked }); // PT-A15: sees descendants that later leave the group
      trackers.add(tracker); tracker.start();
      // PT-A4/A6/A16: kill the group, then marker carriers, then tracked descendants still alive.
      const reap = () => { killGroup(pgid, 'SIGKILL'); sweepByMarker(runId); tracker.killRemaining(); };

      // PT-A1/A2: SIGTERM the group, then SIGKILL after the grace if any member is still alive. The
      // shell leader usually dies on SIGTERM at once, so liveness is the GROUP's, not the leader's.
      timer = setTimeout(async () => {
        timedOut = true;
        killGroup(pgid, 'SIGTERM');
        const deadline = Date.now() + graceMs;
        while (groupAlive(pgid) && Date.now() < deadline) await sleep(50);
        reap();
        finish({});
      }, timeoutMs);

      // 'exit', not 'close': a background member holding the pipes open delays 'close' (VERIFIED).
      c.on('exit', async (code, signal) => {
        if (timedOut) return;
        clearTimeout(timer);
        reap(); // PT-A4/A6/A16: reap every straggler
        await Promise.race([stdoutClosed, sleep(DRAIN_MS)]);
        finish({ code, signal });
      });
    });
  }
  return { run, killAll };
}
