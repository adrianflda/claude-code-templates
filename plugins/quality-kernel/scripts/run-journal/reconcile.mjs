// Resume = the journal checked against git, read-only (spec §5, INV-1..INV-6). Git is the oracle: the
// journal is trusted only where git confirms it. Nothing here writes to a repo or a worktree — every
// git call runs with --no-optional-locks (not even the index is refreshed) and through ./git.mjs (no
// inherited GIT_* variable, no grafts or replace objects, no commit-graph, no repo-run programs).
import { lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { orgRepoDir } from '../org.mjs';
import { git as journalGit } from './git.mjs';

// Thrown for anything that makes the verdict unverifiable (exit 2), as opposed to a divergence (exit 1).
export class Indeterminate extends Error {}

// Runs git and returns { status, out } only for the exit codes the caller declares as answers
// (`answers`, default [0]); anything else — a crash, a signal, a broken repo — is Indeterminate.
function git(dir, args, answers = [0]) {
  const r = journalGit(dir, ['--no-optional-locks', ...args], { maxBuffer: 16 * 1024 * 1024 });
  if (r.error || !answers.includes(r.status)) {
    throw new Indeterminate(`git ${args[0]} failed in ${dir}: ${(r.stderr || '').trim() || r.error?.message || `exit ${r.status}`}`);
  }
  return { status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
const real = (p) => realpathSync.native(p);

function resolveRepos(org, repos) {
  const dirs = {};
  for (const { name } of repos) {
    const r = orgRepoDir(org, name);
    if (r.error) throw new Indeterminate(r.error);
    dirs[name] = r.dir;
  }
  return dirs;
}

// A worktree: a real (non-symlinked) sibling directory of the org whose git common dir is the repo's .git.
// null when it does not exist; throws when it exists but cannot be trusted as the repo's worktree.
function resolveWorktree(org, name, repoDir) {
  const dir = join(org, name);
  let st;
  try { st = lstatSync(dir); } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new Indeterminate(`cannot inspect worktree ${dir}: ${e.message}`);
  }
  if (!st.isDirectory() || real(dir) !== join(real(org), name)) throw new Indeterminate(`worktree ${dir} is not a real directory of the org — refused`);
  let got = null;
  try { got = real(git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']).out); } catch { got = null; }
  if (got !== join(real(repoDir), '.git')) throw new Indeterminate(`worktree ${dir} does not belong to repo ${repoDir} — refused`);
  return dir;
}

// Commits in `range` with the task ids of their `QK-Task:` trailers, newest first.
// First parent only: commits merged in from elsewhere (e.g. main, carrying an earlier run's trailers)
// are not this branch's work. Limit: a fast-forward onto such commits puts them on the first-parent chain.
function trailered(dir, range) {
  return git(dir, ['log', '--first-parent', '--no-show-signature', '--format=%H%x1f%(trailers:key=QK-Task,valueonly,separator=%x1e)', range, '--']).out
    .split('\n').filter(Boolean).map((l) => {
      const [sha, ids] = l.split('\x1f');
      return { sha, ids: (ids || '').split('\x1e').map((s) => s.trim()).filter(Boolean) };
    });
}
const commitsOf = (list, taskId) => list.filter((c) => c.ids.includes(taskId)).map((c) => c.sha);

const ACTIVE = new Set(['in_progress', 'committed', 'gate_red']);
// Whether branch `ref` exists. `rev-parse --verify` exits 1 both for a missing ref and for a broken one,
// so existence is read from for-each-ref (silent when the ref is absent, a warning when it is broken)
// and an existing ref must then resolve to a commit: anything else is Indeterminate, never "missing".
// Not detectable: an unreadable refs directory, which git skips silently (it reads as a missing ref).
function branchExists(dir, ref) {
  const { out, err } = git(dir, ['for-each-ref', '--format=%(refname)', ref]);
  if (err) throw new Indeterminate(`git reports a problem with ${ref} in ${dir}: ${err}`);
  if (!out.split('\n').includes(ref)) return false;
  git(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return true;
}

// `git status` runs the clean filter (or long-running process) of any filter driver an attribute names,
// for every stat-dirty file — code chosen by repo config and the worktree's .gitattributes. Every driver
// configured anywhere git reads config is emptied for the call (an empty command is no filter); a name
// that cannot be overridden safely makes the verdict indeterminate.
function noFilters(dir) {
  const { out } = git(dir, ['config', '-z', '--name-only', '--get-regexp', '^filter\\.'], [0, 1]);
  const names = new Set(out.split('\0').filter(Boolean).map((k) => k.replace(/^filter\./, '').replace(/\.[^.]*$/, '')));
  for (const n of names) if (/[=\n]/.test(n)) throw new Indeterminate(`filter driver name ${JSON.stringify(n)} cannot be disabled — refused`);
  return [...names].flatMap((n) => ['-c', `filter.${n}.clean=`, '-c', `filter.${n}.smudge=`, '-c', `filter.${n}.process=`, '-c', `filter.${n}.required=false`]);
}

// -> { divergence } | { blocked } | {} for one task.
function checkTask(org, t, repoDir, base) {
  const ref = `refs/heads/${t.branch}`;
  // A task that never committed (pending, or blocked before its first commit) may not have its branch
  // yet (§5.2, §8.5): nothing to check.
  const unstarted = !t.head_sha && (t.state === 'pending' || t.state === 'blocked');
  if (!branchExists(repoDir, ref)) return unstarted ? {} : { divergence: { task_id: t.task_id, kind: 'branch_missing', branch: t.branch } };
  if (t.head_sha) {
    const known = git(repoDir, ['rev-parse', '--verify', '--quiet', `${t.head_sha}^{commit}`], [0, 1]).status === 0;
    if (!known || git(repoDir, ['merge-base', '--is-ancestor', t.head_sha, ref], [0, 1]).status !== 0) {
      return { divergence: { task_id: t.task_id, kind: 'sha_unreachable', sha: t.head_sha } };
    }
  }
  const after = commitsOf(trailered(repoDir, `${t.head_sha || base}..${ref}`), t.task_id);
  if (after.length) return { divergence: { task_id: t.task_id, kind: t.state === 'gate_green' ? 'commits_after_green' : 'orphan_commits', commits: after } };
  if (!ACTIVE.has(t.state)) return {};
  const wt = resolveWorktree(org, t.worktree, repoDir);
  if (!wt) return { divergence: { task_id: t.task_id, kind: 'worktree_missing', worktree: t.worktree } };
  const head = git(wt, ['symbolic-ref', '-q', 'HEAD'], [0, 1]);
  if (head.status !== 0 || head.out !== ref) {
    return { divergence: { task_id: t.task_id, kind: 'worktree_wrong_branch', worktree: t.worktree, expected: ref, actual: head.status === 0 ? head.out : 'detached' } };
  }
  // §8.6: uncommitted work is a human's call, not a divergence — the task waits, the run continues.
  if (git(wt, [...noFilters(wt), 'status', '--porcelain', '--ignore-submodules=dirty']).out) return { blocked: { task_id: t.task_id, reason: 'dirty_worktree', worktree: t.worktree } };
  return {};
}

// Commits on journaled branches whose QK-Task id is not a task of this run: work the journal never saw.
function unknownTaskCommits(state, dirs, bases) {
  const found = new Map();
  const branches = new Set(Object.values(state.tasks).map((t) => `${t.repo}\0${t.branch}`));
  for (const key of [...branches].sort()) {
    const [repo, branch] = key.split('\0');
    const ref = `refs/heads/${branch}`;
    if (!branchExists(dirs[repo], ref)) continue; // reported as branch_missing by its tasks
    for (const c of trailered(dirs[repo], `${bases[repo]}..${ref}`)) {
      for (const id of c.ids.filter((x) => !Object.hasOwn(state.tasks, x))) {
        if (!found.has(id)) found.set(id, new Set());
        found.get(id).add(c.sha);
      }
    }
  }
  return [...found.keys()].sort().map((id) => ({ task_id: id, kind: 'orphan_commits', commits: [...found.get(id)] }));
}

// -> { done, continue, blocked: [{ task_id, reason }], divergences } ; throws Indeterminate.
export function reconcile(org, state) {
  if (!state.run) throw new Indeterminate('journal has no run_started');
  const dirs = resolveRepos(org, state.run.repos);
  const bases = Object.fromEntries(state.run.repos.map((r) => [r.name, r.base_sha]));
  const plan = { done: [], continue: [], blocked: [], divergences: [] };
  for (const t of Object.values(state.tasks).sort((a, b) => a.task_id.localeCompare(b.task_id))) {
    const r = checkTask(org, t, dirs[t.repo], bases[t.repo]);
    if (r.divergence) plan.divergences.push(r.divergence);
    else if (r.blocked) plan.blocked.push(r.blocked);
    else if (t.state === 'gate_green') plan.done.push(t.task_id);
    else if (t.state === 'blocked') plan.blocked.push({ task_id: t.task_id, reason: t.reason || 'journaled' });
    else plan.continue.push(t.task_id);
  }
  plan.divergences.push(...unknownTaskCommits(state, dirs, bases));
  return plan;
}
