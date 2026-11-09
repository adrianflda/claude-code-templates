#!/usr/bin/env node
// Composed quality gate (M0 + M1): classify blast-radius (route.mjs) AND verify by
// re-execution (referee.mjs), in one command. This is the usable entry for the two teeth
// built so far. Spec chain: docs/agentic-harness/{spec,plan,tasks}-m{0,1}-*.v1.md
//
// Usage: qk-gate.mjs --repo <dir> --base <ref> [--head <ref>] [--org <dir>]
//        Flags are passed through to route + referee. With --org (see org.mjs), the org config is
//        hashed ONCE here and that pin is what both receive (each refuses a mismatch), so the change
//        is classified and verified against the same config; it is re-checked after the run.
// Exit:  0 = verified pass · 1 = verified fail · 2 = indeterminate (fail-closed)
//
// NOTE (honest limitation): when route flags a CRITICAL change, the live "breaker" oracle is
// also required before merge. That gate IS built — `breaker-gate.mjs` (M2) enforces it — but it is
// deliberately NOT invoked from here: this entry point does what M0+M1 can, namely real
// re-execution + deterministic risk classification. It flags the unmet breaker requirement in
// `notes` and via exit 3 rather than pretending to satisfy it. For an enforced critical merge,
// call `breaker-gate.mjs --breaker ...` instead of this script.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { orgPin } from './org.mjs';
import { createForwarder } from './process-safety/proc-forward.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const repoIdx = argv.indexOf('--repo');
const baseIdx = argv.indexOf('--base');
const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; };

const earlyIndeterminate = (note) => {
  process.stdout.write(JSON.stringify({ gate: 'indeterminate', refereePass: null, tier: 'critical', requiresBreaker: true, requiresHumanReview: false, referee: null, route: null, notes: [note] }) + '\n');
  process.exit(2);
};

// Pin the org config once (route and referee must read the same config).
// An --org token without a usable value is explicit mode that cannot work: fail closed.
const orgFlagGiven = argv.includes('--org');
const orgDir = flag('--org');
let passthrough = argv.filter((a, i) => a !== '--org-pin' && argv[i - 1] !== '--org-pin'); // the pin is computed here, never taken from the caller
let org = null; // { dir, pin } when pinned
const pinOf = (dir) => { try { return orgPin(dir); } catch (e) { return { error: e.message }; } };
if (orgFlagGiven) {
  if (!orgDir || orgDir.startsWith('--')) earlyIndeterminate('empty --org value (org mode needs the path of the org folder)');
  const pin = pinOf(orgDir);
  if (typeof pin !== 'string') earlyIndeterminate(`org config of ${orgDir} cannot be pinned: ${pin.error}`);
  org = { dir: orgDir, pin };
  passthrough = [...passthrough, '--org-pin', pin];
}

// PT-A12: children run async and SIGINT/SIGTERM/SIGHUP are forwarded to them (see proc-forward.mjs).
const forwarder = createForwarder();
// the referee's stderr (e.g. the memory-guard warning) stays visible; route's is discarded as before
const runJson = (script) => forwarder.runJson(join(here, script), passthrough, { stderr: script === 'referee.mjs' ? 'inherit' : 'ignore' });

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
// Code the gate executed runs with the user's rights: if the org config changed during the run,
// the pinned config may no longer be what the org says — the verdict cannot be trusted.
const orgMoved = org && pinOf(org.dir) !== org.pin;
if (orgMoved) notes.push(`the org config changed during the run (pin was ${org.pin.slice(0, 12)}) — code executed by the gate may have rewritten it; indeterminate`);
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
else if (orgMoved) code = 2;
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
  ...(org ? { org } : {}),
  notes,
}) + '\n');
process.exit(code);
