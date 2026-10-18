#!/usr/bin/env node
/**
 * pr-draft-guard — Claude Code PreToolUse hook (Bash).
 *
 * Rule (see ../RULE.md): every pull request is opened as a DRAFT and Claude never
 * merges one; a human does every merge. Merging a base branch into a feature branch
 * also needs an explicit yes from the human first.
 *
 * Blocks (exit 2, reason on stderr):
 *   - `gh pr create` / `gh pr new` without --draft (or with --draft=false)
 *   - `gh pr merge` (any form, including --auto)
 *   - `gh pr ready` (taking a PR out of draft); `gh pr ready --undo` is allowed
 *   - `gh api` calls that merge or mark ready (REST .../pulls/N/merge unless GET;
 *     GraphQL mergePullRequest / markPullRequestReadyForReview / enablePullRequestAutoMerge)
 *   - `git merge <base>` / `git pull <remote> <base>` while on another branch, where
 *     <base> is one of PR_DRAFT_GUARD_BASES (default: main, master, dev, develop,
 *     development, staging, stage, production, prod). Prefix the command with
 *     ALLOW_BASE_MERGE=1 only after the human said yes to that merge.
 *
 * Only commands are inspected, not text: a PR body, commit message, echo or heredoc
 * that mentions `gh pr merge` is not blocked.
 */
import { execFileSync } from 'node:child_process';
import { simpleCommands } from './shell-words.mjs';

const DEFAULT_BASES = 'main,master,dev,develop,development,staging,stage,production,prod';
const BASES = new Set(
  (process.env.PR_DRAFT_GUARD_BASES || DEFAULT_BASES).split(',').map((s) => s.trim()).filter(Boolean),
);
const GRAPHQL_FORBIDDEN = /\b(mergePullRequest|markPullRequestReadyForReview|enablePullRequestAutoMerge)\b/;

function readStdin() {
  return new Promise((res) => {
    let d = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { if (d.length < 1_000_000) d += c; });
    process.stdin.on('end', () => res(d));
    setTimeout(() => res(d), 2000).unref?.();
  });
}

/** Positional words of a gh/git invocation, skipping flags and the values of known value flags. */
function positionals(args, valueFlags) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    if (w === '--') { out.push(...args.slice(i + 1)); break; }
    if (w.startsWith('-')) {
      if (valueFlags.has(w)) i++;
      continue;
    }
    out.push(w);
  }
  return out;
}

const GH_VALUE_FLAGS = new Set(['-R', '--repo', '-t', '--title', '-b', '--body', '-F', '--body-file',
  '-B', '--base', '-H', '--head', '-a', '--assignee', '-l', '--label', '-m', '--milestone',
  '-p', '--project', '-r', '--reviewer', '-T', '--template', '-X', '--method', '-f', '--raw-field',
  '--field', '-H', '--header', '--input', '-q', '--jq', '--template', '--subject', '--match-head-commit',
  '-A', '--author-email']);

function isDraftCreate(args) {
  let draft = false;
  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    if (GH_VALUE_FLAGS.has(w)) { i++; continue; }
    if (w === '--draft' || w === '--draft=true' || w === '-d') draft = true;
    else if (w === '--draft=false') return false;
    else if (/^-[dfwe]{2,}$/.test(w) && w.includes('d')) draft = true;
  }
  return draft;
}

function checkGh(args) {
  const pos = positionals(args, GH_VALUE_FLAGS);
  if (pos[0] === 'pr') {
    const sub = pos[1];
    if ((sub === 'create' || sub === 'new') && !isDraftCreate(args)) {
      return 'gh pr create must open the PR as a draft: add --draft. Every PR is a draft; the human decides when it is ready.';
    }
    if (sub === 'merge') {
      return 'gh pr merge is not allowed: Claude never merges pull requests; the human does every merge. Leave the PR open as a draft and tell the user it is ready for their review.';
    }
    if (sub === 'ready' && !args.includes('--undo')) {
      return 'gh pr ready is not allowed: taking a PR out of draft is the human\'s decision. Ask the user instead.';
    }
  }
  if (pos[0] === 'api') {
    const text = args.join(' ');
    if (GRAPHQL_FORBIDDEN.test(text)) {
      return 'This gh api GraphQL call merges a PR or marks it ready. Claude never does that; the human does.';
    }
    const ep = pos.slice(1).find((w) => /(^|\/)pulls\/\d+\/merge\/?$/.test(w));
    if (ep) {
      const mi = args.findIndex((w) => w === '-X' || w === '--method');
      const method = mi !== -1 ? args[mi + 1] : (args.find((w) => w.startsWith('--method=')) || '').slice(9);
      if ((method || '').toUpperCase() !== 'GET') {
        return `gh api on ${ep} merges a pull request. Claude never merges PRs; the human does.`;
      }
    }
  }
  return null;
}

function git(dir, ...args) {
  try {
    return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function baseName(ref, remotes) {
  const r = ref.replace(/^refs\/(heads|remotes)\//, '');
  const slash = r.indexOf('/');
  if (slash !== -1 && remotes.includes(r.slice(0, slash))) return r.slice(slash + 1);
  return r;
}

function checkGit(args, assigns, cwd) {
  let dir = cwd || process.cwd();
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    if (args[i] === '-C') { dir = args[i + 1]; i += 2; continue; }
    if (args[i] === '-c' || args[i] === '--git-dir' || args[i] === '--work-tree') { i += 2; continue; }
    i++;
  }
  const sub = args[i];
  if (sub !== 'merge' && sub !== 'pull') return null;
  if (assigns.ALLOW_BASE_MERGE === '1') return null;
  const rest = args.slice(i + 1);
  const pos = positionals(rest, new Set(['-m', '-s', '-X', '-F', '--strategy', '--strategy-option', '--file', '--cleanup', '--into-name']));
  const remotes = (git(dir, 'remote') || 'origin\nupstream').split('\n').filter(Boolean);
  const refs = sub === 'pull' ? pos.slice(1) : pos;
  const current = git(dir, 'branch', '--show-current');
  for (const ref of refs) {
    const name = baseName(ref, remotes);
    if (BASES.has(name) && name !== current) {
      return `git ${sub} ${ref} brings the base branch "${name}" into "${current || 'an unknown branch'}". ` +
        'Ask the user first. If they say yes, run the same command prefixed with ALLOW_BASE_MERGE=1.';
    }
  }
  return null;
}

export function verdict(command, cwd) {
  for (const { assigns, argv } of simpleCommands(command)) {
    const [prog, ...args] = argv;
    const reason = prog === 'gh' ? checkGh(args) : prog === 'git' ? checkGit(args, assigns, cwd) : null;
    if (reason) return reason;
  }
  return null;
}

async function main() {
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    process.exit(0);
  }
  if (input?.tool_name !== 'Bash') process.exit(0);
  const command = String(input?.tool_input?.command ?? '');
  let reason;
  try {
    reason = verdict(command, input.cwd);
  } catch (e) {
    // Reader failure: fall back to a coarse check rather than letting a merge through.
    if (/\bgh\b[\s\S]*\bpr\b[\s\S]*\bmerge\b/.test(command)) reason = `pr-draft-guard could not parse the command (${e.message}) and it looks like gh pr merge.`;
  }
  if (reason) {
    process.stderr.write(`[pr-draft-guard] BLOCKED. ${reason}\n`);
    process.exit(2);
  }
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
