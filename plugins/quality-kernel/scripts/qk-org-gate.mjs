#!/usr/bin/env node
// Org-level gate: one feature = the same branch name across the app repos the org guide lists (see
// org.mjs for the trust model). The org config is pinned ONCE by content; every listed app repo
// that has the branch is gated with qk-gate against base = merge-base(<declared base>, <branch>)
// and its org config. Verdicts are aggregated into one exit code.
//
// Usage: qk-org-gate.mjs --org <dir> --branch <name>
// Exit:  0 = every gated repo passed · 1 = a repo really failed · 2 = indeterminate · 3 = passed but
//        a critical change needs the live breaker. Precedence 1 > 2 > 3 > 0.
//
// Three phases, because the code a gate executes runs with the user's rights and could touch the
// OTHER repos of the feature: (1) PLAN — every repo's head, base, merge-base and skip decision is
// resolved before any gate runs; (2) RUN — each planned repo is gated at the commits pinned in (1);
// (3) RE-CHECK — every ref read in (1), and the org config pin, must be unchanged, else the repo (or
// the whole feature) is indeterminate. A real failure is always reported as one. NOT covered
// (execution-trust limit; per-repo isolation is the real fix): code executed while gating an earlier
// repo can rewrite git objects in place, dirs shared through linkPaths (node_modules), or the
// plugin's own scripts.
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
import { readOrgManifest, orgPin, orgRepoDir, isRepoName } from './org.mjs';
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
  // A harness is checked through its app (harnessNote), not gated itself.
  if (spec.role === 'harness') return { result: { name, status: 'skipped', reason: 'harness: checked with its app, not gated itself' } };
  if (spec.role !== 'app') return reject(`role ${JSON.stringify(spec.role)} is not gated (only "app")`);

  const dir = join(root, name);
  const baseBranch = spec.base ?? null;
  const fail = (reason, extra = {}) => ({ result: { name, status: 'ran', exit: 2, baseBranch, reason, ...extra } });
  if (!existsSync(dir)) return fail(`listed repo not found at ${dir}`);
  const entry = orgRepoDir(root, name);
  if (entry.error) return reject(entry.error);
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

// Phase 2 for one planned repo: qk-gate at the pinned head and base, with the org config.
function runPlan(p, manifest, branch) {
  const r = spawnSync('node', [join(here, 'qk-gate.mjs'), '--repo', p.dir, '--base', p.base, '--head', p.head,
    '--org', manifest.dir], { encoding: 'utf8' });
  let verdict = null;
  try { verdict = JSON.parse((r.stdout || '').trim().split('\n').filter(Boolean).pop()); } catch { /* null */ }
  const src = verdict && verdict.referee && verdict.referee.evidence && verdict.referee.evidence.toolsSource;
  let exit = normalizeExit(r.status);
  // A contract taken from the org must be the config pinned in phase 1; anything else is not trusted.
  const offPin = src && src.source === 'org' && src.pin !== manifest.pin;
  if (offPin && exit !== 1) exit = 2;
  return {
    name: p.name, status: 'ran', exit, ...(offPin ? { offPin: `verified against org config ${src.pin}, not the pinned ${manifest.pin}` } : {}),
    baseBranch: p.baseBranch, baseRef: p.baseRef, base: p.base,
    head: branch, headSha: p.head, gate: verdict ? verdict.gate : null, tier: verdict ? verdict.tier : null,
    configPin: src && src.pin ? src.pin : null, configRef: src && src.ref ? src.ref : null,
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
  let orgArg, branch = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--org') orgArg = argv[++i] ?? '';
    else if (argv[i] === '--branch') branch = argv[++i];
  }
  const finish = (result, code) => {
    process.stdout.write(JSON.stringify({ gate: GATE_NAME[code], exit: code, ...result }) + '\n');
    process.exit(code);
  };
  if (!orgArg || !branch) finish({ reason: 'need --org <dir> --branch <name>' }, 2);
  const manifest = existsSync(orgArg) ? readOrgManifest(orgArg) : null;
  if (!manifest) finish({ reason: `no usable org guide (.claude/org-workspace/guide.json) in ${orgArg} — run /org-init (org-workspace plugin)` }, 2);
  try { manifest.pin = orgPin(manifest.dir); } catch (e) { finish({ reason: e.message }, 2); }
  if (branch === 'HEAD' || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) || branch.includes('..') || branch.endsWith('/') || branch.endsWith('.lock')) finish({ reason: `--branch ${JSON.stringify(branch)} is not a valid branch name` }, 2);

  const root = manifest.dir;
  // (1) PLAN every repo before any code runs.
  const entries = Object.entries(manifest.repos).map(([name, spec]) => ({ name, spec, ...planRepo(root, manifest, name, spec, branch) }));
  // (2) RUN the planned repos at their pinned commits.
  for (const e of entries) if (e.plan) e.result = runPlan(e.plan, manifest, branch);
  // (3) RE-CHECK every pinned ref and the org config pin.
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
  let pinNow = null;
  try { pinNow = orgPin(manifest.dir); } catch { /* unreadable now = moved */ }
  const orgMoved = pinNow !== manifest.pin;
  if (orgMoved) notes.push(`the org config changed during the run (pin was ${manifest.pin.slice(0, 12)}) — code executed by a gate may have rewritten it; not trusted`);

  const out = { branch, org: { dir: manifest.dir, pin: manifest.pin }, repos, notes };
  if (!repos.some((x) => x.status !== 'skipped')) out.reason = `no listed repo has branch "${branch}" — nothing was verified`;
  let code = aggregate(repos);
  if (orgMoved && code !== 1) code = 2;
  finish(out, code);
}

if (isEntrypoint(import.meta.url)) main(process.argv.slice(2));
