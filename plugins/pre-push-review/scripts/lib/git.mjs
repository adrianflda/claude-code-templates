// Git access for the harness. Every call uses execFile with an argument array — never a shell
// string — so a branch name, ref or path taken from user input or from a pull request can
// never be interpreted as shell syntax.

import { execFileSync } from 'node:child_process';

const MAX_BUFFER = 256 * 1024 * 1024;

export class GitError extends Error {
  constructor(args, detail) {
    super(`git ${args.join(' ')} failed: ${detail}`);
    this.name = 'GitError';
  }
}

/** Raw stdout of a git command. Throws GitError unless `allowFail`, which returns null. */
export function git(args, { cwd, allowFail = false, input } = {}) {
  try {
    return execFileSync('git', args, {
      cwd,
      input,
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    if (allowFail) return null;
    const detail = String(e.stderr || e.message || '').trim().split('\n')[0] || `exit ${e.status}`;
    throw new GitError(args, detail);
  }
}

/** Trimmed single-value output, or null when the command fails or prints nothing. */
export function gitValue(args, opts = {}) {
  const out = git(args, { ...opts, allowFail: true });
  if (out == null) return null;
  const v = out.trim();
  return v === '' ? null : v;
}

export function gitLines(args, opts = {}) {
  const out = git(args, { ...opts, allowFail: true });
  if (out == null) return [];
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

/** True when the command exits 0 (for predicates such as `merge-base --is-ancestor`). */
export function gitOk(args, opts = {}) {
  return git(args, { ...opts, allowFail: true }) != null;
}

export function repoRoot(cwd) {
  return gitValue(['rev-parse', '--show-toplevel'], { cwd });
}

/** The directory shared by all worktrees of a repo; harness state lives under it. */
export function gitCommonDir(cwd) {
  return gitValue(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd });
}

export function resolveSha(ref, cwd) {
  if (typeof ref !== 'string' || ref === '' || ref.startsWith('-')) return null;
  return gitValue(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd });
}

/** The well-known empty tree, used as the base when reviewing a root commit. */
export function emptyTree(cwd) {
  return gitValue(['hash-object', '-t', 'tree', '--stdin'], { cwd, input: '' })
    ?? '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
}

export function shortSha(sha) {
  return typeof sha === 'string' ? sha.slice(0, 8) : '';
}
