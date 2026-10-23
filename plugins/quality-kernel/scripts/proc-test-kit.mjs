// Test-only helpers for the gate-process-tree suites: unique markers, process-table probes and a
// bounded poll. Every probe reads the real process table; nothing here is a production seam.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export const newMarker = () => `qkpt_${randomUUID()}`;
export const pgrepMarker = (mark) => {
  const r = spawnSync('pgrep', ['-f', mark], { encoding: 'utf8' });
  return (r.stdout || '').split('\n').filter(Boolean).map(Number);
};
export const pkillMarker = (mark) => { spawnSync('pkill', ['-9', '-f', mark]); };
export const isAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};
// Poll `pred` until it returns a truthy value or the bound elapses; returns the last value.
export async function waitFor(pred, { timeoutMs = 5000, stepMs = 25 } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await pred();
    if (v || Date.now() >= end) return v;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
// A portable long-lived process whose argv carries `mark` (found by pgrep -f).
export const markedSleep = (mark, secs = 60) => `node -e "setTimeout(()=>{},${secs * 1000})" ${mark}`;
