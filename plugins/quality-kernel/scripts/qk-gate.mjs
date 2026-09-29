#!/usr/bin/env node
// Composed quality gate (M0 + M1): classify blast-radius (route.mjs) AND verify by
// re-execution (referee.mjs), in one command. This is the usable entry for the two teeth
// built so far. Spec chain: docs/agentic-harness/{spec,plan,tasks}-m{0,1}-*.v1.md
//
// Usage: qk-gate.mjs --repo <dir> --base <ref> [--head <ref>] [--workspace <dir>] [--workspace-ref <ref>]
//        Flags are passed through to route + referee. With --workspace (see workspace.mjs), the
//        workspace ref is resolved ONCE here to a commit SHA and that SHA is what both receive, so
//        the change is classified and verified against the same workspace config.
// Exit:  0 = verified pass · 1 = verified fail · 2 = indeterminate (fail-closed)
//
// NOTE (honest limitation): when route flags a CRITICAL change, the live "breaker" oracle is
// also required before merge — that gate is milestone M2 and is NOT yet enforced here. This
// gate does what M0+M1 can: real re-execution + deterministic risk classification. It flags the
// M2 requirement in `notes` rather than pretending to satisfy it.

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveWorkspaceRef } from './workspace.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const repoIdx = argv.indexOf('--repo');
const baseIdx = argv.indexOf('--base');
const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; };

const earlyIndeterminate = (note) => {
  process.stdout.write(JSON.stringify({ gate: 'indeterminate', refereePass: null, tier: 'critical', requiresBreaker: true, requiresHumanReview: false, referee: null, route: null, notes: [note] }) + '\n');
  process.exit(2);
};

// Pin the workspace commit once (route and referee must read the same workspace config).
// A --workspace token without a usable value is explicit mode that cannot work: fail closed.
const wsFlagGiven = argv.includes('--workspace');
const workspaceDir = flag('--workspace');
let passthrough = argv; // route + referee accept the same --repo/--base/--head/--workspace* flags
let workspace = null; // { dir, ref, sha } when pinned
if (wsFlagGiven) {
  if (!workspaceDir || workspaceDir.startsWith('--')) earlyIndeterminate('empty --workspace value (workspace mode needs the path of the workspace repo)');
  const wsRef = flag('--workspace-ref') ?? 'main';
  const sha = resolveWorkspaceRef(workspaceDir, wsRef);
  if (!sha) earlyIndeterminate(`workspace ref "${wsRef}" does not resolve to a commit in ${workspaceDir} (a branch as origin/<ref> or refs/heads/<ref> — both must agree when both exist — or a full commit SHA)`);
  workspace = { dir: workspaceDir, ref: wsRef, sha };
  passthrough = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--workspace-ref') { i++; continue; }
    passthrough.push(argv[i]);
  }
  passthrough.push('--workspace-ref', sha);
}

function runJson(script) {
  const r = spawnSync('node', [join(here, script), ...passthrough], { encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse((r.stdout || '').trim().split('\n').filter(Boolean).pop()); } catch { /* leave null */ }
  return { code: r.status, json };
}

if (repoIdx === -1 || baseIdx === -1) {
  process.stdout.write(JSON.stringify({ pass: false, error: 'need --repo <dir> --base <ref> [--head <ref>]' }) + '\n');
  process.exit(2);
}

const route = runJson('route.mjs');

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

const ref = runJson('referee.mjs');

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
// Code the gate executed runs with the user's rights: if the workspace ref moved during the run,
// the pinned config may no longer be what the workspace says — the verdict cannot be trusted.
const workspaceMoved = workspace && resolveWorkspaceRef(workspace.dir, workspace.ref) !== workspace.sha;
if (workspaceMoved) notes.push(`workspace ref "${workspace.ref}" moved during the run (was ${workspace.sha}) — code executed by the gate may have rewritten the workspace; indeterminate`);
if (route.json ? !!route.json.requiresBreaker : true) {
  notes.push('CRITICAL surface: the live breaker (M2) is required before merge and is NOT yet enforced. Exit 3 = do-not-merge until M2 lands.');
}
if (overlaidTests.length) {
  notes.push(`Test file(s) modified and overlaid from head (${overlaidTests.join(', ')}) — a test change is a contract change: human review required before merge (Option B). Exit 3.`);
}

// The EXIT CODE is the gate (Constitution P1: "if a rule matters, it's code" — a prose note is not).
//   1/2 = referee blocked (real fail / indeterminate)
//   3   = referee passed BUT a required gate (the M2 breaker on a critical change) is unenforced
//   0   = verified green with no unmet gate
let code;
if (!refPass) code = verdict.indeterminate ? 2 : 1;
else if (workspaceMoved) code = 2;
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
  ...(workspace ? { workspace } : {}),
  notes,
}) + '\n');
process.exit(code);
