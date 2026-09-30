#!/usr/bin/env node
// /init-workspace phase 3 — re-execute every proposed gate config and label it.
//
// It runs the agent-proposed `verify` commands, so it refuses to run unless a human approved THIS
// proposal: `--approved <proposal commit sha>` (the skill shows every command first and waits for the
// OK), and the config at the branch tip (workspace.json + repos/) must be identical to that commit's.
// For each app with repos/<name>/tools.json it runs qk-gate on the repo's base branch tip (base..base:
// the suite runs twice in the referee's temp trees), pinned to the proposal, with --no-ledger so
// nothing is written into the product repo. Labels:
//   verified         the suite ran and passed
//   runs-but-fails   the suite ran and failed on today's base (a finding: flaky or broken suite)
//   cannot-run-here  it could not run (Docker unavailable, missing tool, timeout, repo/base missing)
//   no-gate-config   no tools.json was proposed (needs-local-env / no-tests)
//   forbidden        the entry is also in `forbidden` — never run
// The labels, bound to the config tree id, are committed to the proposal branch (verification.json,
// init-report.json and a re-rendered INIT-REPORT.md). main is never written.
//
// Usage: ws-verify.mjs --org <dir> --branch <init/...> --approved <proposal sha>
// Spec: docs/agentic-harness/spec-init-workspace.v1.md §4 phase 3.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, readVerifiedBlob } from './safe-git.mjs';
import { readWorkspaceManifest, resolveWorkspaceRef, isRepoName } from './workspace.mjs';
import { renderReport } from './ws-propose.mjs';
import { isEntrypoint } from './entrypoint.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const FULL_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const out = (dir, args) => { const r = git(dir, args); return r.status === 0 ? r.stdout.trim() : null; };
const commitOf = (dir, ref) => out(dir, ['rev-parse', '--verify', '-q', '--end-of-options', `${ref}^{commit}`]);
// The identity of the gate config: the repos/ tree and the workspace.json blob.
const configId = (ws, rev) => `${out(ws, ['rev-parse', '--verify', '-q', '--end-of-options', `${rev}:repos`]) || '-'}:${out(ws, ['rev-parse', '--verify', '-q', '--end-of-options', `${rev}:workspace.json`]) || '-'}`;

let dockerState;
function dockerAvailable() {
  if (dockerState === undefined) {
    const r = spawnSync('docker', ['info'], { encoding: 'utf8', timeout: 20000 });
    dockerState = r.status === 0 ? { ok: true } : { ok: false, why: ((r.stderr || '') + (r.error ? r.error.message : '')).trim().split('\n').pop() || `exit ${r.status}` };
  }
  return dockerState;
}

function verifyApp(org, ws, sha, name, spec) {
  const r = readVerifiedBlob(ws, sha, `repos/${name}/tools.json`);
  if (r.error) return { name, label: 'cannot-run-here', reason: `workspace integrity: ${r.error}` };
  if (r.absent) return { name, label: 'no-gate-config', reason: 'no tools.json proposed for this repo' };
  let tools = {};
  try { tools = JSON.parse(r.text); } catch { return { name, label: 'cannot-run-here', reason: 'tools.json is not valid JSON' }; }
  const dir = join(org, name);
  if (!isRepoName(name) || !existsSync(dir)) return { name, label: 'cannot-run-here', reason: `repo not found at ${dir}` };
  const base = spec && spec.base;
  const tip = base && (commitOf(dir, `refs/remotes/origin/${base}`) || commitOf(dir, `refs/heads/${base}`));
  if (!tip) return { name, label: 'cannot-run-here', reason: `base branch "${base}" not found` };
  if (tools.localEnv === 'docker-existing' || /\bdocker\b/.test(tools.verify || '')) {
    const d = dockerAvailable();
    if (!d.ok) return { name, label: 'cannot-run-here', base, baseSha: tip, reason: `docker is not available here (${d.why})` };
  }
  const g = spawnSync('node', [join(here, 'qk-gate.mjs'), '--repo', dir, '--base', tip, '--head', tip, '--workspace', ws, '--workspace-ref', sha, '--no-ledger'], { encoding: 'utf8' });
  let v = null;
  try { v = JSON.parse((g.stdout || '').trim().split('\n').filter(Boolean).pop()); } catch { /* null */ }
  const reason = (v && v.referee && v.referee.reason) || (v && v.notes && v.notes.join(' ')) || `qk-gate exit ${g.status}`;
  // exit 3 = the suite passed but a critical change needs the breaker; base..base changes nothing.
  const label = g.status === 0 || g.status === 3 ? 'verified' : g.status === 1 ? 'runs-but-fails' : 'cannot-run-here';
  return { name, label, exit: g.status, base, baseSha: tip, reason: label === 'runs-but-fails' ? `the suite failed when re-executed on ${base} (a broken or flaky suite): ${reason}` : reason };
}

export function verify({ org, branch, approved, author } = {}) {
  if (!branch || branch === 'main' || !branch.startsWith('init/')) throw new Error('verify runs on a proposal branch (init/...), never on main');
  const ws = join(org, 'workspace');
  const sha = existsSync(ws) ? resolveWorkspaceRef(ws, branch) : null;
  if (!sha) throw new Error(`branch "${branch}" does not resolve in ${ws}`);
  if (typeof approved !== 'string' || !FULL_SHA.test(approved) || !commitOf(ws, approved)
    || git(ws, ['merge-base', '--is-ancestor', approved, sha]).status !== 0) {
    throw new Error('refusing to run proposed commands: pass --approved <the proposal commit sha> after a human reviewed every verify command');
  }
  if (configId(ws, approved) !== configId(ws, sha)) throw new Error(`the gate config on ${branch} changed since it was approved (${approved.slice(0, 12)}) — review it again`);
  const m = readWorkspaceManifest(ws, sha);
  if (!m) throw new Error(`no usable workspace.json on ${branch}`);
  dockerState = undefined;
  const results = Object.entries(m.repos).map(([name, spec]) => (m.forbidden.includes(name)
    ? { name, label: 'forbidden', reason: 'forbidden in the workspace — never run' }
    : verifyApp(org, ws, sha, name, spec)));
  const configTree = out(ws, ['rev-parse', '--verify', '-q', '--end-of-options', `${sha}:repos`]) || '';

  const tmp = mkdtempSync(join(tmpdir(), 'qk-verify-'));
  const wt = join(tmp, 'wt');
  const add = git(ws, ['worktree', 'add', '-q', wt, branch]);
  if (add.status !== 0) { rmSync(tmp, { recursive: true, force: true }); throw new Error(`cannot check out ${branch}: ${(add.stderr || '').trim()}`); }
  try {
    const verification = { branch, proposalSha: approved, verifiedAt: sha, configTree, results };
    writeFileSync(join(wt, 'verification.json'), JSON.stringify(verification, null, 2) + '\n');
    const dataBlob = readVerifiedBlob(ws, sha, 'init-report.json');
    if (dataBlob.text) {
      const data = { ...JSON.parse(dataBlob.text), verification };
      writeFileSync(join(wt, 'init-report.json'), JSON.stringify(data, null, 2) + '\n');
      writeFileSync(join(wt, 'INIT-REPORT.md'), renderReport(data));
    }
    git(wt, ['add', '-A']);
    const args = author ? ['-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`] : [];
    const c = git(wt, [...args, 'commit', '-q', '--allow-empty', '-m', `✅ test: re-execution labels for the workspace proposal (${branch})`]);
    if (c.status !== 0) throw new Error(`cannot commit the verification: ${(c.stderr || '').trim()}`);
    return { branch, proposalSha: approved, sha: git(wt, ['rev-parse', 'HEAD']).stdout.trim(), configTree, results };
  } finally {
    git(ws, ['worktree', 'remove', '--force', wt]);
    git(ws, ['worktree', 'prune']);
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (isEntrypoint(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n) => { const i = args.indexOf(n); return i === -1 ? undefined : args[i + 1]; };
  try { process.stdout.write(JSON.stringify(verify({ org: opt('--org'), branch: opt('--branch'), approved: opt('--approved') }), null, 2) + '\n'); }
  catch (e) { process.stderr.write(`${e.message}\n`); process.exit(2); }
}
