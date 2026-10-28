// Project guidance discovery. Reviewers adapt to a repo by reading the same instruction files
// the team already maintains for coding agents. Discovery is directory-scoped: a CLAUDE.md next
// to the changed code is included together with the one at the repo root.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { matchesAny } from './glob.mjs';

/** Files looked up in the repo root and in every ancestor directory of a changed file. */
export const SCOPED_FILES = ['REVIEW.md', 'CLAUDE.md', 'AGENTS.md'];
/** Files that only make sense at the repo root. */
export const ROOT_FILES = ['.github/copilot-instructions.md', '.cursorrules', '.windsurfrules'];

function ancestors(path) {
  const dirs = [];
  let dir = dirname(path);
  while (dir && dir !== '.' && dir !== '/') {
    dirs.push(dir);
    dir = dirname(dir);
  }
  return dirs;
}

function readIfFile(full) {
  try {
    if (!existsSync(full) || !statSync(full).isFile()) return null;
    return readFileSync(full, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Collect guidance for a set of changed paths, within a character budget. Root files come
 * first; nested files follow, ordered by how many changed files they govern.
 * Returns [{ path, content, truncated }].
 */
export function collectGuidelines(root, changedPaths, budget = 16_000) {
  const candidates = [];
  for (const name of [...SCOPED_FILES, ...ROOT_FILES]) candidates.push({ rel: name, weight: Infinity });

  const dirWeight = new Map();
  for (const p of changedPaths) {
    for (const dir of ancestors(p)) dirWeight.set(dir, (dirWeight.get(dir) ?? 0) + 1);
  }
  const nested = [...dirWeight.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  for (const [dir, weight] of nested) {
    for (const name of SCOPED_FILES) candidates.push({ rel: `${dir}/${name}`, weight });
  }

  const out = [];
  let remaining = budget;
  for (const c of candidates) {
    if (remaining <= 0) break;
    const content = readIfFile(join(root, c.rel));
    if (content == null || content.trim() === '') continue;
    const truncated = content.length > remaining;
    out.push({ path: c.rel, content: truncated ? content.slice(0, remaining) : content, truncated });
    remaining -= Math.min(content.length, remaining);
  }
  return out;
}

/** Path instructions from the config that apply to at least one changed file. */
export function relevantPathInstructions(pathInstructions, changedPaths) {
  return (pathInstructions ?? [])
    .map((entry) => ({
      paths: entry.paths,
      instructions: entry.instructions,
      files: changedPaths.filter((p) => matchesAny(p, entry.paths)),
    }))
    .filter((entry) => entry.files.length > 0);
}
