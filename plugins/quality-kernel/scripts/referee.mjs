#!/usr/bin/env node
// Re-executing verification referee — M0 + M3 (trusted-harness).
// Spec: docs/agentic-harness/spec-m0-referee.v1.md (+ v2) · M3: review-m0m1.v2.md
//
// It does NOT trust any agent's "done" claim. It re-executes the project's verify command and
// reads the real exit status. Fail-closed. M3 adds oracle-integrity: when a base ref is given it
// ALSO runs the verify command with the BASE test-harness overlaid on the HEAD code, so a change
// that neuters/deletes its own tests (or weakens a verify script) cannot hide a real code bug.
//
// Usage:  referee.mjs --repo <dir> [--base <ref>]
// Exit:   0 = PASS · 1 = real FAIL · 2 = indeterminate (fail-closed)

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, statSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { globToRegExp } from './route.mjs';

// Files that constitute the verification HARNESS (the oracle), restored from base in the trusted
// run so the change under test cannot tamper with them: test files, package manifests/locks,
// tool/CI config, shell verify scripts, and the quality-kernel config itself.
const HARNESS_GLOBS = [
  '**/*.test.*', '**/*.spec.*', '**/__tests__/**', '**/*_test.*', '**/test_*.*',
  '**/package.json', '**/package-lock.json', '**/pnpm-lock.yaml', '**/yarn.lock',
  '**/*.config.*', '**/.quality-kernel/**', '**/*.sh',
];
const isHarness = (p) => HARNESS_GLOBS.some((g) => globToRegExp(g).test(p));

function emit(v) { process.stdout.write(JSON.stringify(v) + '\n'); }
function ledgerAppend(repoDir, record) {
  try {
    const dir = join(repoDir, '.quality-kernel');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'evidence-ledger.jsonl'),
      JSON.stringify({ ts: Math.round(Date.now()) / 1000, source: 'referee', ...record }) + '\n');
  } catch { /* audit write must never affect the verdict */ }
}
function indeterminate(reason) { emit({ pass: false, indeterminate: true, evidence: null, reason }); process.exit(2); }

// --- args ---
const args = process.argv.slice(2);
let repo = null, base = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--repo') repo = args[++i];
  else if (args[i] === '--base') base = args[++i];
}
if (!repo) indeterminate('missing --repo <dir>');
if (!existsSync(repo) || !statSync(repo).isDirectory()) indeterminate(`repo not found or not a directory: ${repo}`);

// --- load the verify command, PREFERRING the committed base/HEAD ref (immutable to the change) ---
function parseVerify(text, whence) {
  try {
    const j = JSON.parse(text);
    if (j && typeof j.verify === 'string' && j.verify.trim()) return j.verify.trim();
  } catch (e) { indeterminate(`unreadable tools.json (${whence}): ${e.message}`); }
  return null;
}
function loadVerify(dir, ref) {
  const g = spawnSync('git', ['-C', dir, 'show', `${ref}:.quality-kernel/tools.json`], { encoding: 'utf8' });
  if (g.status === 0) { const v = parseVerify(g.stdout, `git ${ref}`); if (v) return v; }
  for (const p of [join(dir, '.quality-kernel', 'tools.json'), join(dir, 'tools.json')]) {
    if (existsSync(p)) { const v = parseVerify(readFileSync(p, 'utf8'), p); if (v) return v; }
  }
  return null;
}
const verify = loadVerify(repo, base || 'HEAD');
if (!verify) indeterminate('no verify command declared (.quality-kernel/tools.json "verify")');

const childEnv = { ...process.env };
delete childEnv.NODE_TEST_CONTEXT; // re-execution must not inherit the caller's test-runner state

// Run the verify command in `cwd`, read the REAL exit status, fail-closed on could-not-run.
function runVerify(cwd, label) {
  const r = spawnSync(verify, { cwd, shell: true, encoding: 'utf8', env: childEnv, timeout: 300000 });
  if (r.error || r.status === null || r.status === undefined) {
    indeterminate(`verify (${label}) could not complete: "${verify}" (${r.signal ? `timed out (${r.signal})` : (r.error ? r.error.message : 'no exit status')})`);
  }
  if ((r.status === 127 || r.status === 126) && !(r.stdout && r.stdout.trim())) {
    indeterminate(`verify (${label}) not executable (exit ${r.status}): "${verify}"`);
  }
  return r.status;
}

// Build HEAD code + BASE harness in a temp dir (oracle-integrity). Returns the dir, or null if
// not a git repo / base missing (then the trusted run is skipped, e.g. for non-git fixtures).
function buildTrustedTree(dir, ref) {
  const isGit = spawnSync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' }).status === 0;
  if (!isGit) return null;
  if (spawnSync('git', ['-C', dir, 'rev-parse', '--verify', ref], { encoding: 'utf8' }).status !== 0) return null;
  const tmp = mkdtempSync(join(tmpdir(), 'qk-trusted-'));
  const arch = spawnSync('bash', ['-c', `git -C ${JSON.stringify(dir)} archive HEAD | tar -x -C ${JSON.stringify(tmp)}`], { encoding: 'utf8' });
  if (arch.status !== 0) { rmSync(tmp, { recursive: true, force: true }); return null; }
  const ls = spawnSync('git', ['-C', dir, 'ls-tree', '-r', '--name-only', ref], { encoding: 'utf8' });
  if (ls.status !== 0) { rmSync(tmp, { recursive: true, force: true }); return null; }
  for (const p of ls.stdout.split('\n').filter(Boolean).filter(isHarness)) {
    const show = spawnSync('git', ['-C', dir, 'show', `${ref}:${p}`], { encoding: 'buffer' });
    if (show.status === 0) { const d = join(tmp, p); mkdirSync(dirname(d), { recursive: true }); writeFileSync(d, show.stdout); }
  }
  return tmp;
}

// 1) HEAD as-is (catches head bugs / broken tests the change introduced).
const headExit = runVerify(repo, 'head');
// 2) HEAD code + BASE harness (catches a change that neutered/deleted its own tests to go green).
let trustedExit = null;
if (base) {
  const tmp = buildTrustedTree(repo, base);
  if (tmp) { try { trustedExit = runVerify(tmp, 'base-harness'); } finally { rmSync(tmp, { recursive: true, force: true }); } }
}

const pass = headExit === 0 && (trustedExit === null || trustedExit === 0);
ledgerAppend(repo, { command: verify, exit_code: headExit, trusted_exit: trustedExit, pass });
emit({
  pass,
  evidence: { command: verify, exit_code: headExit, trustedHarnessExit: trustedExit },
  reason: pass
    ? `verify passed (head${trustedExit === null ? '' : ' + base-harness'}, re-executed)`
    : headExit !== 0
      ? `verify suite failed with exit ${headExit} (re-executed)`
      : `verify passed on the change's own harness but FAILED (exit ${trustedExit}) under the base harness — the change likely neutered its tests`,
});
process.exit(pass ? 0 : 1);
