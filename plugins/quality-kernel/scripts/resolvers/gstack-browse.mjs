#!/usr/bin/env node
// F1 — gstack $B browser-engine resolver/bootstrap for the quality-kernel live oracle.
//
// The pipeline-breaker verifies a UI-observable invariant by shelling out to gstack's compiled
// `$B` (browse) binary. This module ONLY locates the binary and runs one command against it; `$B`
// itself auto-spawns and reuses its persistent Chromium daemon (state in <cwd>/.gstack/browse.json),
// so we do not manage the daemon lifecycle here. No dependency on Aside (the fallback engine only).
//
// Truth model (gstack browse driver contract): `$B` ALWAYS exits 0 — truth is on stdout. This module
// returns raw stdout/stderr/status untouched; the caller (gstack-probe.mjs) judges the run from the
// `GSTACK_STEP_OK` sentinel / `[error` lines. `ran:false` means the process could not START at all.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

// Default local-target pattern: the consent gate treats these hosts as "local" (mutating them does
// not hit a real account), so the autonomous breaker may drive them without an interactive prompt.
export const DEFAULT_LOCAL_PATTERN = 'localhost|127\\.0\\.0\\.1|\\[::1\\]|\\.test$|\\.localhost$';

// Resolve the `$B` binary: explicit arg > env GSTACK_BROWSE_BIN > config.browserEngine.bin > null.
// Returns an existing path, or null (UI probes unavailable → the breaker falls back to HTTP/CLI probes).
export function resolveBrowseBin({ bin = null, config = null } = {}) {
  const candidate =
    bin ||
    process.env.GSTACK_BROWSE_BIN ||
    (config && config.browserEngine && config.browserEngine.bin) ||
    null;
  if (!candidate) return null;
  return existsSync(candidate) ? candidate : null;
}

// Run one `$B` command. Returns { ran, stdout, stderr, status, error }.
// `ran` is false ONLY when the process could not start (missing binary / spawn error / timeout); a
// `$B` that ran but printed an `[error` line still has ran:true — that is judged from stdout, not here.
export function runBrowse(bin, args, { cwd = process.cwd(), timeoutMs = 30000 } = {}) {
  if (!bin) return { ran: false, stdout: '', stderr: '', status: null, error: 'no browse binary resolved' };
  const r = spawnSync(bin, args, { cwd, encoding: 'utf8', timeout: timeoutMs });
  if (r.error || r.status === null) {
    return {
      ran: false,
      stdout: r.stdout || '',
      stderr: r.stderr || '',
      status: r.status ?? null,
      error: r.error ? r.error.message : 'process did not exit',
    };
  }
  return { ran: true, stdout: r.stdout || '', stderr: r.stderr || '', status: r.status, error: null };
}

// Synchronous sleep (no event loop) — used to pace daemon warmup retries.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Warm the `$B` daemon before a probe. The FIRST command against a cold daemon spawns it and can
// exit non-zero with "Daemon busy — did not answer /health within ~8s" while Chromium is still
// launching (first launch also pays macOS XProtect verification). That is a boot race, not a broken
// instrument — so we retry a cheap `goto about:blank` until it succeeds or the budget elapses. Once
// ready, subsequent commands are ~sub-second. Returns { ready, attempts, last }.
export function ensureDaemon(bin, { cwd = process.cwd(), timeoutMs = 30000, budgetMs = 60000, warmCmd = ['goto', 'about:blank'] } = {}) {
  if (!bin) return { ready: false, attempts: 0, last: null, error: 'no browse binary resolved' };
  const deadline = Date.now() + budgetMs;
  let last = null;
  let attempts = 0;
  do {
    attempts += 1;
    last = runBrowse(bin, warmCmd, { cwd, timeoutMs });
    if (last.ran && last.status === 0) return { ready: true, attempts, last };
    if (Date.now() < deadline) sleepSync(1500);
  } while (Date.now() < deadline);
  return { ready: false, attempts, last };
}

// Consent gate: require a local test/staging target. Mutating a non-local URL would hit the user's
// real account, which gstack gates behind an interactive prompt — incompatible with an autonomous,
// blind breaker. `pattern` is a RegExp source string (config.browserEngine.testUrlPattern).
export function isLocalTarget(url, pattern = DEFAULT_LOCAL_PATTERN) {
  let re;
  try {
    re = new RegExp(pattern);
  } catch {
    return false;
  }
  try {
    const host = new URL(url).hostname;
    return re.test(host);
  } catch {
    return false; // not a parseable URL → not a valid local target (fail-closed)
  }
}
