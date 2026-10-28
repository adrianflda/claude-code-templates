// Scope resolution: decide exactly which change is under review and where its files can be read.
//
// A scope has a base commit, a head (a commit, the index, or the working tree), the parsed diff
// between them, and a `root` directory holding the head version of the files for the reviewers
// to explore. `repoCommandsAllowed` is false whenever the head is not the developer's own
// checkout: the harness never runs repo-configured commands (lint, typecheck) against code it
// fetched from a pull request, because those commands execute repo-controlled configuration.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerCleanup } from './cleanup.mjs';
import { diffStats, parseDiff } from './diff.mjs';
import { emptyTree, git, gitLines, gitOk, gitValue, repoRoot, resolveSha, shortSha } from './git.mjs';
import { matchesAny } from './glob.mjs';
import { getReviewed } from './state.mjs';

export const MODES = ['auto', 'staged', 'working', 'branch', 'base', 'pr'];

export class ScopeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScopeError';
  }
}

const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--find-renames', '--diff-filter=ACMRD'];

/** Changed paths between two points, as { path, oldPath, status } without reading content. */
function changedPaths(rangeArgs, cwd) {
  const out = git(['-c', 'core.quotepath=false', 'diff', '--name-status', '-z', '--find-renames', '--diff-filter=ACMRD', ...rangeArgs], { cwd });
  const parts = out.split('\0').filter((p) => p !== '');
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i][0];
    if (code === 'R' || code === 'C') {
      files.push({ status: 'renamed', oldPath: parts[i + 1], path: parts[i + 2] });
      i += 2;
    } else {
      const status = code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified';
      files.push({ status, oldPath: parts[i + 1], path: parts[i + 1] });
      i += 1;
    }
  }
  return files;
}

/** Diff the given range, restricted to the files that survive the exclude patterns. */
function collectDiff(rangeArgs, cwd, exclude) {
  const all = changedPaths(rangeArgs, cwd);
  const kept = all.filter((f) => !matchesAny(f.path, exclude));
  const excluded = all.filter((f) => matchesAny(f.path, exclude)).map((f) => f.path);
  if (kept.length === 0) return { files: [], diffText: '', excluded };

  const paths = [...new Set(kept.flatMap((f) => [f.path, f.oldPath]).filter(Boolean))];
  const diffText = git(
    ['--literal-pathspecs', '-c', 'core.quotepath=false', 'diff', ...DIFF_FLAGS, ...rangeArgs, '--', ...paths],
    { cwd },
  );
  return { files: parseDiff(diffText), diffText, excluded };
}

function currentBranch(cwd) {
  return gitValue(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd }) ?? 'detached';
}

/** Base for "the commits about to be pushed": the point where HEAD left what the remote has. */
function unpushedBase(cwd) {
  for (const target of ['@{push}', '@{upstream}']) {
    const sha = gitValue(['rev-parse', '--verify', '--quiet', `${target}^{commit}`], { cwd });
    if (!sha) continue;
    const base = gitValue(['merge-base', 'HEAD', sha], { cwd });
    if (base) return { base, via: target };
  }
  // No tracking branch: everything reachable from HEAD that no remote has yet.
  const fresh = gitLines(['rev-list', 'HEAD', '--not', '--remotes'], { cwd });
  if (fresh.length === 0) return { base: resolveSha('HEAD', cwd), via: 'remotes' };
  const oldest = fresh[fresh.length - 1];
  const parent = gitValue(['rev-parse', '--verify', '--quiet', `${oldest}^`], { cwd });
  return { base: parent ?? emptyTree(cwd), via: 'remotes' };
}

function gh(args, cwd) {
  try {
    return execFileSync('gh', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const detail = String(e.stderr || e.message || '').trim().split('\n')[0];
    throw new ScopeError(`gh ${args.slice(0, 3).join(' ')} failed: ${detail}`);
  }
}

function resolvePullRequest(number, cwd) {
  if (!/^\d+$/.test(String(number))) throw new ScopeError(`--pr needs a pull request number (got "${number}")`);
  const info = JSON.parse(
    gh(['pr', 'view', String(number), '--json', 'number,url,title,state,headRefOid,headRefName,baseRefName,baseRefOid,isCrossRepository'], cwd),
  );
  const repo = JSON.parse(gh(['repo', 'view', '--json', 'nameWithOwner'], cwd)).nameWithOwner;
  return { ...info, repo };
}

/**
 * Check out `sha` into a temporary detached worktree. Returns { dir, cleanup }.
 *
 * Hooks are disabled for the checkout. `git worktree add` runs the post-checkout hook, and
 * with a relative `core.hooksPath` (husky sets `.husky/_`) git looks for that hook inside the
 * new worktree — that is, in the files of the commit being checked out. Without this, a pull
 * request could ship a hook and have it executed just by being reviewed.
 */
export function addDetachedWorktree(root, sha) {
  const dir = mkdtempSync(join(tmpdir(), 'pre-push-review-wt-'));
  try {
    git(['-c', `core.hooksPath=${devNull}`, 'worktree', 'add', '--detach', '--quiet', dir, sha], { cwd: root });
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  // Registered so an interrupted run does not leave the worktree listed in the repository.
  const cleanup = registerCleanup(() => {
    // The directory is the harness's own temp dir. A plain remove is tried first; if git
    // refuses (something wrote into it), the directory is deleted and the entry pruned.
    if (!gitOk(['worktree', 'remove', dir], { cwd: root })) rmSync(dir, { recursive: true, force: true });
    gitOk(['worktree', 'prune'], { cwd: root });
  });
  return { dir, cleanup };
}

/**
 * Apply incremental review: when this key was reviewed before and that commit is still an
 * ancestor of the head, review only what came after it. A rebase or force-push breaks the
 * ancestry, in which case the whole change is reviewed again and the reason is reported.
 */
function applyIncremental({ root, key, base, head, enabled }) {
  if (!enabled || !head) return { base, incremental: false, note: null };
  const last = getReviewed(root, key);
  if (!last?.headSha) return { base, incremental: false, note: null };
  if (last.headSha === head) return { base: head, incremental: true, note: 'nothing new since the last review' };
  if (!gitOk(['merge-base', '--is-ancestor', last.headSha, head], { cwd: root })) {
    return {
      base,
      incremental: false,
      note: `history changed since the last review (${shortSha(last.headSha)} is no longer an ancestor); reviewing the full change`,
    };
  }
  return { base: last.headSha, incremental: true, note: `incremental: only commits after ${shortSha(last.headSha)}` };
}

/**
 * Changed files whose working-tree content differs from the version under review. Reviewers
 * and repo commands read the working tree, so for these files what they see is not exactly
 * what is being reviewed.
 */
function findDirtyPaths(scope, files) {
  if (scope.headKind === 'worktree' || scope.reviewRoot !== scope.root) return [];
  const against = scope.headKind === 'index' ? [] : [scope.headSha];
  const dirty = new Set(gitLines(['-c', 'core.quotepath=false', 'diff', '--name-only', ...against], { cwd: scope.root }));
  return files.map((f) => f.path).filter((p) => dirty.has(p));
}

function finish(scope, collected) {
  const stats = diffStats(collected.files);
  const dirtyPaths = findDirtyPaths(scope, collected.files);
  const notes = [...scope.notes];
  if (dirtyPaths.length) {
    notes.push(
      `${dirtyPaths.length} changed file(s) have working-tree edits that are not part of this review; reviewers read files from disk, so they may see those edits`,
    );
  }
  return {
    ...scope,
    notes,
    files: collected.files,
    diffText: collected.diffText,
    excluded: collected.excluded,
    stats,
    dirtyPaths,
    cleanup: scope.cleanup ?? (() => {}),
  };
}

/**
 * Resolve a review scope.
 * @param {object} opts { cwd, mode, base, pr, incremental, full, exclude }
 */
export function resolveScope(opts) {
  const cwd = opts.cwd ?? process.cwd();
  const root = repoRoot(cwd);
  if (!root) throw new ScopeError(`${cwd} is not inside a git repository`);
  const exclude = opts.exclude ?? [];
  let mode = opts.mode ?? 'auto';
  if (!MODES.includes(mode)) throw new ScopeError(`unknown mode "${mode}" (use one of ${MODES.join(', ')})`);

  const headSha = resolveSha('HEAD', root);

  if (mode === 'auto') {
    if (gitLines(['diff', '--cached', '--name-only'], { cwd: root }).length) mode = 'staged';
    else if (gitLines(['diff', '--name-only'], { cwd: root }).length) mode = 'working';
    else mode = 'branch';
  }

  if (mode === 'staged' || mode === 'working') {
    if (!headSha && mode === 'working') throw new ScopeError('the repository has no commits yet; stage the files and use --staged');
    const rangeArgs = mode === 'staged' ? ['--cached', headSha ?? emptyTree(root)] : [headSha];
    return finish(
      {
        mode,
        root,
        reviewRoot: root,
        description: mode === 'staged' ? 'staged changes' : 'uncommitted changes (staged and unstaged)',
        baseSha: headSha,
        headSha: null,
        headKind: mode === 'staged' ? 'index' : 'worktree',
        key: `${mode}:${currentBranch(root)}`,
        incremental: false,
        notes: [],
        pr: null,
        repoCommandsAllowed: true,
      },
      collectDiff(rangeArgs, root, exclude),
    );
  }

  if (!headSha) throw new ScopeError('the repository has no commits yet');

  if (mode === 'branch' || mode === 'base') {
    let base;
    let description;
    let key;
    if (mode === 'base') {
      const ref = resolveSha(opts.base, root);
      if (!ref) throw new ScopeError(`cannot resolve base "${opts.base}"`);
      base = gitValue(['merge-base', ref, headSha], { cwd: root });
      if (!base) throw new ScopeError(`"${opts.base}" and HEAD share no history`);
      description = `branch changes against ${opts.base}`;
      key = `base:${currentBranch(root)}:${opts.base}`;
    } else {
      const found = unpushedBase(root);
      base = found.base;
      const count = gitLines(['rev-list', `${base}..${headSha}`], { cwd: root }).length;
      description = `${count} commit(s) about to be pushed`;
      key = `branch:${currentBranch(root)}`;
    }

    const inc = applyIncremental({ root, key, base, head: headSha, enabled: Boolean(opts.incremental) && !opts.full });
    return finish(
      {
        mode,
        root,
        reviewRoot: root,
        description: inc.incremental ? `${description} (incremental)` : description,
        baseSha: inc.base,
        headSha,
        headKind: 'commit',
        key,
        incremental: inc.incremental,
        notes: inc.note ? [inc.note] : [],
        pr: null,
        repoCommandsAllowed: true,
      },
      collectDiff([inc.base, headSha], root, exclude),
    );
  }

  // mode === 'pr'
  const pr = resolvePullRequest(opts.pr, root);
  const remotes = gitLines(['remote'], { cwd: root });
  const remote = remotes.includes('origin') ? 'origin' : remotes[0];
  if (!remote) throw new ScopeError('the repository has no git remote to fetch the pull request from');
  git(['fetch', '--quiet', remote, `pull/${pr.number}/head`], { cwd: root });
  const prHead = gitValue(['rev-parse', '--verify', '--quiet', 'FETCH_HEAD^{commit}'], { cwd: root });
  if (!prHead) throw new ScopeError(`could not fetch the head of pull request #${pr.number}`);
  if (prHead !== pr.headRefOid) {
    throw new ScopeError(`fetched ${shortSha(prHead)} but GitHub reports ${shortSha(pr.headRefOid)} as the head of #${pr.number}; retry in a moment`);
  }
  git(['fetch', '--quiet', remote, pr.baseRefName], { cwd: root });
  const baseTip = gitValue(['rev-parse', '--verify', '--quiet', 'FETCH_HEAD^{commit}'], { cwd: root });
  // Prefer the base commit GitHub recorded for the pull request. Once a pull request has been
  // merged with a merge commit, the tip of the base branch contains its head, and the merge
  // base of the two would be the head itself — an empty diff.
  const recordedBase = resolveSha(pr.baseRefOid, root);
  const mergeBase = [recordedBase, baseTip]
    .filter(Boolean)
    .map((base) => gitValue(['merge-base', base, prHead], { cwd: root }))
    .find((base) => base && base !== prHead) ?? null;
  if (!mergeBase) throw new ScopeError(`could not find where pull request #${pr.number} diverged from ${pr.baseRefName}`);

  const key = `pr:${pr.repo}#${pr.number}`;
  const inc = applyIncremental({ root, key, base: mergeBase, head: prHead, enabled: !opts.full });
  const notes = inc.note ? [inc.note] : [];

  // Reviewers read files from disk. If the developer's checkout is not exactly the PR head,
  // give them a detached worktree at that commit instead of files from another revision.
  const clean = gitLines(['status', '--porcelain', '--untracked-files=no'], { cwd: root }).length === 0;
  let reviewRoot = root;
  let cleanup = () => {};
  let ownCheckout = headSha === prHead && clean;
  if (!ownCheckout) {
    const worktree = addDetachedWorktree(root, prHead);
    reviewRoot = worktree.dir;
    cleanup = worktree.cleanup;
    notes.push('reviewed in a temporary worktree at the pull request head; repo lint/typecheck commands were not run against fetched code');
  }

  try {
    return finish(
      {
        mode,
        root,
        reviewRoot,
        description: `pull request #${pr.number}${inc.incremental ? ' (incremental)' : ''}`,
        baseSha: inc.base,
        headSha: prHead,
        headKind: 'commit',
        key,
        incremental: inc.incremental,
        notes,
        pr: { number: pr.number, url: pr.url, title: pr.title, repo: pr.repo, baseRef: pr.baseRefName, headRef: pr.headRefName, headSha: prHead, mergeBase },
        repoCommandsAllowed: ownCheckout,
        cleanup,
      },
      collectDiff([inc.base, prHead], root, exclude),
    );
  } catch (e) {
    cleanup();
    throw e;
  }
}

/**
 * The files of the WHOLE pull request diff, which is what GitHub anchors inline comments to.
 * For a full review that is the reviewed diff itself; for an incremental one the reviewed diff
 * is narrower, so the pull request diff is computed separately.
 */
export function anchorFiles(scope, exclude = []) {
  if (!scope.pr || !scope.incremental) return scope.files;
  return collectDiff([scope.pr.mergeBase, scope.pr.headSha], scope.root, exclude).files;
}

/** Content of `path` at the head of the scope, or null when it cannot be read. */
export function readHeadFile(scope, path) {
  if (scope.headKind === 'commit') return git(['show', `${scope.headSha}:${path}`], { cwd: scope.root, allowFail: true });
  if (scope.headKind === 'index') return git(['show', `:${path}`], { cwd: scope.root, allowFail: true });
  try {
    return readFileSync(join(scope.root, path), 'utf8');
  } catch {
    return null;
  }
}
