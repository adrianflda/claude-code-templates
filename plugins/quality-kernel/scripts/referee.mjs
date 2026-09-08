#!/usr/bin/env node
// Re-executing verification referee — M0.
// Spec: docs/agentic-harness/spec-m0-referee.v1.md · Plan: plan-m0-referee.v1.md
//
// It does NOT trust any agent's "done" claim. It re-executes the project's verify command
// itself, reads the real exit status, and returns a typed verdict. Fail-closed.
//
// Usage:  referee.mjs --repo <dir> [--base <ref>]
// Exit:   0 = PASS · 1 = real FAIL (suite ran and failed) · 2 = indeterminate (fail-closed)

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, statSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

function emit(verdict) {
  process.stdout.write(JSON.stringify(verdict) + '\n');
}

// The referee is the AUTHORITATIVE source of exit codes in the evidence ledger: it
// re-executes and reads the real status, unlike the Bash PostToolUse hook (whose payload
// carries no exit code). Append a typed record; never block on a ledger write.
function ledgerAppend(repoDir, record) {
  try {
    const dir = join(repoDir, '.quality-kernel');
    mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ ts: Math.round(Date.now()) / 1000, source: 'referee', ...record }) + '\n';
    appendFileSync(join(dir, 'evidence-ledger.jsonl'), line);
  } catch { /* audit write must never affect the verdict */ }
}
// Indeterminate → fail-closed (Constitution P5). Exit 2.
function indeterminate(reason) {
  emit({ pass: false, indeterminate: true, evidence: null, reason });
  process.exit(2);
}

// --- args ---
const args = process.argv.slice(2);
let repo = null;
let base = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--repo') repo = args[++i];
  else if (args[i] === '--base') base = args[++i];
}
if (!repo) indeterminate('missing --repo <dir>');
if (!existsSync(repo) || !statSync(repo).isDirectory()) indeterminate(`repo not found or not a directory: ${repo}`);

// --- load the project-declared verify command (DC1) ---
function loadVerify(dir) {
  for (const p of [join(dir, '.quality-kernel', 'tools.json'), join(dir, 'tools.json')]) {
    if (!existsSync(p)) continue;
    try {
      const j = JSON.parse(readFileSync(p, 'utf8'));
      if (j && typeof j.verify === 'string' && j.verify.trim()) return j.verify.trim();
    } catch (e) {
      indeterminate(`unreadable config ${p}: ${e.message}`);
    }
  }
  return null;
}
const verify = loadVerify(repo);
if (!verify) indeterminate('no verify command declared (.quality-kernel/tools.json or tools.json → "verify")');

// --- advisory diff (M0: not used to scope — DC2 runs the full suite; kept for evidence/future) ---
let changed = null;
if (base) {
  const d = spawnSync('git', ['-C', repo, 'diff', '--name-only', `${base}...HEAD`], { encoding: 'utf8' });
  if (d.status === 0) changed = d.stdout.split('\n').filter(Boolean);
}

// --- re-execute the verify command IN the repo, read the REAL exit status ---
// Run in a CLEAN environment, independent of whoever invoked the referee. In particular
// strip NODE_TEST_CONTEXT so a verify command that itself uses `node --test` behaves
// identically whether the referee was called standalone or from inside another test run.
// The referee's job is an independent re-execution; it must not inherit the caller's
// test-runner state.
const childEnv = { ...process.env };
delete childEnv.NODE_TEST_CONTEXT;
const r = spawnSync(verify, { cwd: repo, shell: true, encoding: 'utf8', env: childEnv });

// Could-not-run cases → indeterminate (fail-closed), NOT a test failure:
//  - spawn error (r.error) or no readable status (null/undefined)
//  - shell 127 (command not found) / 126 (not executable): the verify command could not be run
if (r.error || r.status === null || r.status === undefined) {
  indeterminate(`verify command could not run: "${verify}" (${r.error ? r.error.message : 'no exit status'})`);
}
if (r.status === 127 || r.status === 126) {
  indeterminate(`verify command not executable (exit ${r.status}): "${verify}"`);
}

const exit = r.status;
const pass = exit === 0;
ledgerAppend(repo, { command: verify, exit_code: exit, pass });
emit({
  pass,
  evidence: { command: verify, exit_code: exit, changed },
  reason: pass
    ? 'verify suite passed (re-executed by the referee)'
    : `verify suite failed with exit ${exit} (re-executed by the referee)`,
});
process.exit(pass ? 0 : 1);
