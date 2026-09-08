#!/usr/bin/env node
// Composed quality gate (M0 + M1): classify blast-radius (route.mjs) AND verify by
// re-execution (referee.mjs), in one command. This is the usable entry for the two teeth
// built so far. Spec chain: docs/agentic-harness/{spec,plan,tasks}-m{0,1}-*.v1.md
//
// Usage: qk-gate.mjs --repo <dir> [--base <ref>]
// Exit:  0 = verified pass · 1 = verified fail · 2 = indeterminate (fail-closed)
//
// NOTE (honest limitation): when route flags a CRITICAL change, the live "breaker" oracle is
// also required before merge — that gate is milestone M2 and is NOT yet enforced here. This
// gate does what M0+M1 can: real re-execution + deterministic risk classification. It flags the
// M2 requirement in `notes` rather than pretending to satisfy it.

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const repoIdx = argv.indexOf('--repo');
const passthrough = argv; // route + referee accept the same --repo/--base flags

function runJson(script) {
  const r = spawnSync('node', [join(here, script), ...passthrough], { encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse((r.stdout || '').trim().split('\n').filter(Boolean).pop()); } catch { /* leave null */ }
  return { code: r.status, json };
}

if (repoIdx === -1) {
  process.stdout.write(JSON.stringify({ pass: false, error: 'need --repo <dir> [--base <ref>]' }) + '\n');
  process.exit(2);
}

const route = runJson('route.mjs');
const ref = runJson('referee.mjs');

const verdict = ref.json || { pass: false, indeterminate: true, reason: 'referee produced no verdict' };
const pass = ref.code === 0;
const notes = [];
if (route.json && route.json.requiresBreaker) {
  notes.push('CRITICAL surface: the live breaker (M2) is required before merge and is not yet enforced by this gate.');
}

process.stdout.write(JSON.stringify({
  pass,
  tier: route.json ? route.json.tier : 'critical',       // fail-safe if route errored
  requiresBreaker: route.json ? route.json.requiresBreaker : true,
  referee: verdict,
  route: route.json,
  notes,
}) + '\n');

// Verdict comes from the referee (the gate). Route is advisory rigor context.
process.exit(ref.code === 0 ? 0 : (verdict.indeterminate ? 2 : 1));
