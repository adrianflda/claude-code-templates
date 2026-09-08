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

// --- load the project-declared verify command, PREFERRING the committed base/HEAD ref ---
// Red-team finding: if the verify command is read from the working tree, the same change under
// test can weaken it (e.g. `{"verify":"true"}`) and force a pass. Reading it from the committed
// ref makes the oracle immutable to the change being judged. Falls back to the worktree only for
// non-git dirs (fixtures) or a first-time setup with no committed config.
function parseVerify(text, whence) {
  try {
    const j = JSON.parse(text);
    if (j && typeof j.verify === 'string' && j.verify.trim()) return j.verify.trim();
  } catch (e) { indeterminate(`unreadable tools.json (${whence}): ${e.message}`); }
  return null;
}
function loadVerify(dir, ref) {
  const g = spawnSync('git', ['-C', dir, 'show', `${ref}:.quality-kernel/tools.json`], { encoding: 'utf8' });
  if (g.status === 0) { const v = parseVerify(g.stdout, `git ${ref}`); if (v) return { verify: v, from: `git:${ref}` }; }
  for (const p of [join(dir, '.quality-kernel', 'tools.json'), join(dir, 'tools.json')]) {
    if (existsSync(p)) { const v = parseVerify(readFileSync(p, 'utf8'), p); if (v) return { verify: v, from: 'worktree' }; }
  }
  return null;
}
const loaded = loadVerify(repo, base || 'HEAD');
if (!loaded) indeterminate('no verify command declared (.quality-kernel/tools.json "verify")');
const verify = loaded.verify;

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
const r = spawnSync(verify, { cwd: repo, shell: true, encoding: 'utf8', env: childEnv, timeout: 300000 });

// Could-not-run cases → indeterminate (fail-closed), NOT a test failure:
//  - spawn error (r.error), timeout (r.signal set), or no readable status (null/undefined)
if (r.error || r.status === null || r.status === undefined) {
  const why = r.signal ? `timed out (${r.signal})` : (r.error ? r.error.message : 'no exit status');
  indeterminate(`verify command could not complete: "${verify}" (${why})`);
}
// 127/126 = shell "command not found / not executable" => could-not-run — UNLESS the suite
// actually produced output, in which case honor the non-zero exit as a real failure.
if ((r.status === 127 || r.status === 126) && !(r.stdout && r.stdout.trim())) {
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
