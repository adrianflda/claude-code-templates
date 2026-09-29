#!/usr/bin/env node
// Org-level gate for workspace mode: one feature = the same branch name across the repos a
// workspace lists (see workspace.mjs for the trust model). The workspace ref is resolved ONCE to a
// commit SHA; every listed app repo that has the branch is gated with qk-gate against
// base = merge-base(<declared base>, <branch>) and that pinned workspace commit. Verdicts are
// aggregated into one exit code.
//
// Usage: qk-org-gate.mjs --workspace <dir> --branch <name> [--workspace-ref <ref>]
// Exit:  0 = every gated repo passed · 1 = a repo really failed · 2 = indeterminate · 3 = passed but
//        a critical change needs the live breaker. Precedence 1 > 2 > 3 > 0.
//
// Three phases, because the code a gate executes runs with the user's rights and could touch the
// OTHER repos of the feature: (1) PLAN — every repo's head, base, merge-base and skip decision is
// resolved before any gate runs; (2) RUN — each planned repo is gated at the commits pinned in (1);
// (3) RE-CHECK — every ref read in (1), and the workspace ref, must be unchanged, else the repo (or
// the whole feature) is indeterminate. A real failure is always reported as one. Config blobs are
// hash-verified when read (safe-git.mjs). NOT covered (execution-trust limit; per-repo isolation is
// the real fix): commit/tree objects rewritten in place with valid content (can change which config
// blob a later repo reads), dirs shared with the real repo through linkPaths (node_modules), and the
// plugin's own scripts — all writable by code executed while gating an earlier repo.
//
// Fail-closed: anything listed that cannot be verified is exit 2, never "skipped" — a listed repo
// that is not cloned or not a git repo, a repo symlinked from outside the org folder, a forbidden /
// invalid-name / non-"app" entry, a missing or malformed base branch, a feature branch that exists
// only on origin or differs from it, no merge-base, or a qk-gate that crashes. Only a repo that
// exists and has no such branch (locally or on origin) is skipped; if nothing ran, exit 2.
// Harness repos are not gated; an app gated without its harness on the same branch gets a note.

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { git } from './safe-git.mjs';
import { readWorkspaceManifest, resolveWorkspaceRef, isRepoName } from './workspace.mjs';
import { isEntrypoint } from './entrypoint.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const GATE_NAME = { 0: 'pass', 1: 'fail', 2: 'indeterminate', 3: 'blocked-needs-breaker' };
const EXITS = [0, 1, 2, 3];
const SEVERITY = [1, 2, 3, 0]; // most to least severe

// A qk-gate exit outside 0-3 (crash, signal, spawn failure) is indeterminate.
export const normalizeExit = (status) => (EXITS.includes(status) ? status : 2);

// The feature's exit code from the per-repo results. Nothing gated, or any result without a valid
// exit code, is 2 (unless a real failure is also present).
export function aggregate(repos) {
  const counted = repos.filter((r) => r.status !== 'skipped');
  if (!counted.length) return 2;
  if (counted.some((r) => r.exit === 1)) return 1;
  if (counted.some((r) => !EXITS.includes(r.exit))) return 2;
  return SEVERITY.find((c) => counted.some((r) => r.exit === c)) ?? 2;
}

const isBranchName = (dir, name) => typeof name === 'string' && !!name && !name.startsWith('-') && name !== 'HEAD'
  && !/[~^:@{}]/.test(name) && git(dir, ['check-ref-format', '--branch', name]).status === 0;
const commitOf = (dir, qualified) => {
  const r = git(dir, ['rev-parse', '--verify', '-q', '--end-of-options', `${qualified}^{commit}`]);
  return r.status === 0 ? r.stdout.trim() : null;
};

// Phase 1 for one repo: a final result (rejected / skipped / failed) or a plan to run.
function planRepo(root, manifest, name, spec, branch) {
  const reject = (reason) => ({ result: { name, status: 'rejected', exit: 2, reason } });
  if (!isRepoName(name)) return reject('invalid repo name in the manifest');
  if (manifest.forbidden.includes(name)) return reject('listed in repos but forbidden');
  if (!spec || typeof spec !== 'object') return reject('manifest entry must be an object');
  if (spec.role !== 'app') return reject(`role ${JSON.stringify(spec.role)} is not gated (only "app")`);

  const dir = join(root, name);
  const baseBranch = spec.base ?? null;
  const fail = (reason, extra = {}) => ({ result: { name, status: 'ran', exit: 2, baseBranch, reason, ...extra } });
  if (!existsSync(dir)) return fail(`listed repo not found at ${dir}`);
  if (dirname(realpathSync(dir)) !== realpathSync(root)) return reject(`resolves outside the org folder (${realpathSync(dir)})`);
  const top = git(dir, ['rev-parse', '--show-toplevel']);
  if (top.status !== 0 || realpathSync(top.stdout.trim()) !== realpathSync(dir)) return fail(`${dir} is not a git repository`);

  const headRef = `refs/heads/${branch}`;
  const remoteHeadRef = `refs/remotes/origin/${branch}`;
  const head = commitOf(dir, headRef);
  const remoteHead = commitOf(dir, remoteHeadRef);
  if (!head && !remoteHead) return { result: { name, status: 'skipped', baseBranch, reason: `no branch "${branch}"` } };
  if (!head) return fail(`branch "${branch}" exists only on origin — check it out locally to gate it`);
  if (remoteHead && remoteHead !== head) return fail(`local branch "${branch}" differs from origin/${branch} — which one to verify is ambiguous`);
  if (baseBranch === null || baseBranch === '') return fail('no base branch declared in the manifest');
  if (!isBranchName(dir, baseBranch)) return fail(`invalid base branch ${JSON.stringify(baseBranch)} in the manifest`);
  const baseRef = [`refs/remotes/origin/${baseBranch}`, `refs/heads/${baseBranch}`].find((r) => commitOf(dir, r));
  if (!baseRef) return fail(`base branch "${baseBranch}" not found locally or on origin`);
  const baseTip = commitOf(dir, baseRef);
  const mb = git(dir, ['merge-base', '--end-of-options', baseTip, head]);
  if (mb.status !== 0) return fail(`no merge-base between ${baseRef} and ${branch}`, { baseRef });
  return { plan: { name, spec, dir, baseBranch, baseRef, base: mb.stdout.trim(), head, pinned: { [headRef]: head, [remoteHeadRef]: remoteHead, [baseRef]: baseTip } } };
}

// Phase 2 for one planned repo: qk-gate at the pinned head, base and workspace commit.
function runPlan(p, manifest, branch) {
  const r = spawnSync('node', [join(here, 'qk-gate.mjs'), '--repo', p.dir, '--base', p.base, '--head', p.head,
    '--workspace', manifest.dir, '--workspace-ref', manifest.sha], { encoding: 'utf8' });
  let verdict = null;
  try { verdict = JSON.parse((r.stdout || '').trim().split('\n').filter(Boolean).pop()); } catch { /* null */ }
  const src = verdict && verdict.referee && verdict.referee.evidence && verdict.referee.evidence.toolsSource;
  let exit = normalizeExit(r.status);
  // A contract taken from the workspace must be the pinned commit's; anything else is not trusted.
  const offPin = src && src.source === 'workspace' && src.sha !== manifest.sha;
  if (offPin && exit !== 1) exit = 2;
  return {
    name: p.name, status: 'ran', exit, ...(offPin ? { offPin: `verified against workspace ${src.sha}, not the pinned ${manifest.sha}` } : {}),
    baseBranch: p.baseBranch, baseRef: p.baseRef, base: p.base,
    head: branch, headSha: p.head, gate: verdict ? verdict.gate : null, tier: verdict ? verdict.tier : null,
    configSha: src && src.sha ? src.sha : null, configRef: src && src.ref ? src.ref : null,
    reason: verdict && verdict.referee ? verdict.referee.reason : (verdict && verdict.notes && verdict.notes.join(' ')) || `qk-gate produced no verdict (exit ${r.status})`,
  };
}

// Phase 3 for one planned repo: the refs that were pinned in phase 1, now. Returns the moved ones.
const movedRefs = (p) => Object.entries(p.pinned).filter(([ref, sha]) => commitOf(p.dir, ref) !== sha).map(([ref]) => ref);

function harnessNote(root, manifest, name, spec, branch) {
  const harness = spec && spec.harness;
  if (harness === undefined) return null;
  if (!isRepoName(harness)) return `${name}: invalid harness name ${JSON.stringify(harness)} (not checked)`;
  if (manifest.forbidden.includes(harness)) return `${name}: harness "${harness}" is forbidden (not checked)`;
  const hdir = join(root, harness);
  if (!existsSync(hdir) || !commitOf(hdir, `refs/heads/${branch}`)) {
    return `${name}: harness "${harness}" has no branch "${branch}" — were its E2E specs updated with the change?`;
  }
  return null;
}

function main(argv) {
  let workspace, branch = null, ref = 'main';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--workspace') workspace = argv[++i] ?? '';
    else if (argv[i] === '--branch') branch = argv[++i];
    else if (argv[i] === '--workspace-ref') ref = argv[++i];
  }
  const finish = (result, code) => {
    process.stdout.write(JSON.stringify({ gate: GATE_NAME[code], exit: code, ...result }) + '\n');
    process.exit(code);
  };
  if (!workspace || !branch) finish({ reason: 'need --workspace <dir> --branch <name> [--workspace-ref <ref>]' }, 2);
  const manifest = existsSync(workspace) ? readWorkspaceManifest(workspace, ref) : null;
  if (!manifest) finish({ reason: `no usable workspace.json at ref "${ref}" in ${workspace}` }, 2);
  if (!isBranchName(manifest.dir, branch)) finish({ reason: `--branch ${JSON.stringify(branch)} is not a valid branch name` }, 2);

  const root = dirname(manifest.dir);
  // (1) PLAN every repo before any code runs.
  const entries = Object.entries(manifest.repos).map(([name, spec]) => ({ name, spec, ...planRepo(root, manifest, name, spec, branch) }));
  // (2) RUN the planned repos at their pinned commits.
  for (const e of entries) if (e.plan) e.result = runPlan(e.plan, manifest, branch);
  // (3) RE-CHECK every pinned ref and the workspace ref.
  const notes = [];
  for (const e of entries) {
    if (!e.plan) continue;
    const moved = movedRefs(e.plan);
    if (moved.length) {
      notes.push(`${e.name}: ${moved.join(', ')} moved during the run — code executed by a gate may have changed it; not trusted`);
      e.result.refsMoved = moved;
      if (e.result.exit !== 1) e.result.exit = 2;
    }
    const n = harnessNote(root, manifest, e.name, e.spec, branch);
    if (n) notes.push(n);
  }
  const repos = entries.map((e) => e.result);
  const workspaceMoved = resolveWorkspaceRef(manifest.dir, ref) !== manifest.sha;
  if (workspaceMoved) notes.push(`workspace ref "${ref}" moved during the run (was ${manifest.sha}) — code executed by a gate may have rewritten the workspace; not trusted`);

  const out = { branch, workspace: { dir: manifest.dir, ref, sha: manifest.sha }, repos, notes };
  if (!repos.some((x) => x.status !== 'skipped')) out.reason = `no listed repo has branch "${branch}" — nothing was verified`;
  let code = aggregate(repos);
  if (workspaceMoved && code !== 1) code = 2;
  finish(out, code);
}

if (isEntrypoint(import.meta.url)) main(process.argv.slice(2));
