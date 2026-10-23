#!/usr/bin/env node
// Composed quality gate (M0 + M1): classify blast-radius (route.mjs) AND verify by
// re-execution (referee.mjs), in one command. This is the usable entry for the two teeth
// built so far. Spec chain: docs/agentic-harness/{spec,plan,tasks}-m{0,1}-*.v1.md
//
// Usage: qk-gate.mjs --repo <dir> --base <ref> [--head <ref>]
// Exit:  0 = verified pass · 1 = verified fail · 2 = indeterminate (fail-closed)
//
// NOTE (honest limitation): when route flags a CRITICAL change, the live "breaker" oracle is
// also required before merge. That gate IS built — `breaker-gate.mjs` (M2) enforces it — but it is
// deliberately NOT invoked from here: this entry point does what M0+M1 can, namely real
// re-execution + deterministic risk classification. It flags the unmet breaker requirement in
// `notes` and via exit 3 rather than pretending to satisfy it. For an enforced critical merge,
// call `breaker-gate.mjs --breaker ...` instead of this script.

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const repoIdx = argv.indexOf('--repo');
const baseIdx = argv.indexOf('--base');
const passthrough = argv; // route + referee accept the same --repo/--base/--head flags

// The gate must stay responsive while a child runs: with a blocking spawnSync a SIGTERM aimed at the
// gate would kill it by default disposition and orphan the referee and every tree under it (PT-A12).
// So the child is async, and SIGINT/SIGTERM/SIGHUP are forwarded to it; the referee kills its trees on
// those signals and exits, then the gate exits 128+signal.
const SIGNALS = [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]];
const FORWARD_GRACE_MS = 10000;
let current = null, terminatingWith = null;

function runJson(script) {
  return new Promise((resolve) => {
    // the referee's stderr (e.g. the memory-guard warning) stays visible; route's is discarded as before
    const child = spawn('node', [join(here, script), ...passthrough], { stdio: ['ignore', 'pipe', script === 'referee.mjs' ? 'inherit' : 'ignore'] });
    current = child;
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    const settle = (code) => {
      current = null;
      if (terminatingWith !== null) process.exit(terminatingWith);
      let json = null;
      try { json = JSON.parse(out.trim().split('\n').filter(Boolean).pop()); } catch { /* leave null */ }
      resolve({ code, json });
    };
    child.on('error', () => settle(null));
    child.on('close', (code) => settle(code));
  });
}
for (const [sig, code] of SIGNALS) {
  process.on(sig, () => {
    if (terminatingWith !== null) return;
    terminatingWith = code;
    if (!current) process.exit(code);
    current.kill(sig);
    setTimeout(() => { try { current.kill('SIGKILL'); } catch { /* gone */ } process.exit(code); }, FORWARD_GRACE_MS).unref();
  });
}

if (repoIdx === -1 || baseIdx === -1) {
  process.stdout.write(JSON.stringify({ pass: false, error: 'need --repo <dir> --base <ref> [--head <ref>]' }) + '\n');
  process.exit(2);
}

const route = await runJson('route.mjs');

// Risk classification failing closed is NOT "a breaker is required". route's operational error path
// (opError) still emits a JSON body with requiresBreaker:true, so reading only route.json would
// downgrade an exit-2 classification failure into a mere breaker requirement — and a later
// BREAKER_PASS could then green a change whose blast radius was never established. Block here.
if (route.code !== 0) {
  process.stdout.write(JSON.stringify({
    gate: 'indeterminate',
    refereePass: null,
    tier: route.json ? route.json.tier : 'critical',
    requiresBreaker: true,
    requiresHumanReview: false,
    referee: null,
    route: route.json,
    notes: [`risk classification failed closed (route exit ${route.code}): ${route.json && route.json.error ? route.json.error : 'no route verdict'}`],
  }) + '\n');
  process.exit(2);
}

const ref = await runJson('referee.mjs');

const verdict = ref.json || { pass: false, indeterminate: true, reason: 'referee produced no verdict' };
const refPass = ref.code === 0;
// The referee is the single source of truth for "were any tests overlaid from head?" — it forces
// human review regardless of route's (independently-globbed) tier, closing the custom-testGlobs gap
// where route would not recognize a repo's own test root (panel V4).
const overlaidTests = (verdict.evidence && Array.isArray(verdict.evidence.overlaidTests)) ? verdict.evidence.overlaidTests : [];
const requiresBreaker = (route.json ? !!route.json.requiresBreaker : true) || overlaidTests.length > 0; // fail-safe if route errored
// A test change is a CONTRACT change: no breaker verdict can stand in for the human who owns the
// contract. Exported so breaker-gate can tell the two exit-3 causes apart (a passing breaker closes
// the critical-surface cause, never this one).
const requiresHumanReview = overlaidTests.length > 0;
const notes = [];
if (route.json ? !!route.json.requiresBreaker : true) {
  notes.push('CRITICAL surface: the live breaker is required before merge and is NOT enforced in this invocation. Re-run through breaker-gate.mjs with --breaker to enforce it. Exit 3 = do-not-merge until it passes.');
}
if (overlaidTests.length) {
  notes.push(`Test file(s) modified and overlaid from head (${overlaidTests.join(', ')}) — a test change is a contract change: human review required before merge (Option B). Exit 3.`);
}

// The EXIT CODE is the gate (Constitution P1: "if a rule matters, it's code" — a prose note is not).
//   1/2 = referee blocked (real fail / indeterminate)
//   3   = referee passed BUT a required gate (the live breaker on a critical change) is unenforced here
//   0   = verified green with no unmet gate
let code;
if (!refPass) code = verdict.indeterminate ? 2 : 1;
else if (requiresBreaker) code = 3;
else code = 0;

process.stdout.write(JSON.stringify({
  gate: code === 0 ? 'pass' : code === 3 ? 'blocked-needs-breaker' : code === 2 ? 'indeterminate' : 'fail',
  refereePass: refPass,
  tier: route.json ? route.json.tier : 'critical',
  requiresBreaker,
  requiresHumanReview,
  referee: verdict,
  route: route.json,
  notes,
}) + '\n');
process.exit(code);
