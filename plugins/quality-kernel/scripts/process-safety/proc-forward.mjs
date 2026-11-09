// Runs child scripts while forwarding termination signals to them (spec:
// docs/specs/gate-process-tree/contract.md, PT-A12). A blocking spawnSync would let a SIGTERM aimed at
// the parent kill it by default disposition and orphan the child and every tree under it, so the child
// is async and SIGINT/SIGTERM/SIGHUP are forwarded; the child cleans up and exits, then the parent
// exits 128+signal (SIGKILLing the child if it is still alive after the grace).
import { spawn } from 'node:child_process';
import { TERMINATION_SIGNALS } from './proc-tree.mjs';

export const FORWARD_GRACE_MS = 10000;

// The last non-empty stdout line parsed as JSON, or null.
export function lastJsonLine(out) {
  try { return JSON.parse(out.trim().split('\n').filter(Boolean).pop()); } catch { return null; }
}

// Installs the signal handlers at once. `runJson(script, args, { stderr })` -> Promise<{ code, json }>.
export function createForwarder({ graceMs = FORWARD_GRACE_MS } = {}) {
  let current = null, terminatingWith = null;
  for (const [sig, code] of TERMINATION_SIGNALS) {
    process.on(sig, () => {
      if (terminatingWith !== null) return;
      terminatingWith = code;
      if (!current) process.exit(code);
      current.kill(sig);
      setTimeout(() => { try { current.kill('SIGKILL'); } catch { /* gone */ } process.exit(code); }, graceMs).unref();
    });
  }
  function runJson(script, args, { stderr }) {
    return new Promise((resolve) => {
      const child = spawn('node', [script, ...args], { stdio: ['ignore', 'pipe', stderr] });
      current = child;
      let out = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d) => { out += d; });
      const settle = (code) => {
        current = null;
        if (terminatingWith !== null) process.exit(terminatingWith);
        resolve({ code, json: lastJsonLine(out) });
      };
      child.on('error', () => settle(null));
      child.on('close', (code) => settle(code));
    });
  }
  return { runJson };
}
