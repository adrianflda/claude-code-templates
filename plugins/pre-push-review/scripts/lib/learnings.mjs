// Learnings: the team's recorded feedback on past reviews.
//
// Two kinds exist. A `rule` is something reviewers must apply ("money is stored in cents, flag
// float arithmetic"). A `rejection` records a finding the team judged wrong, with the reason,
// so the same false positive is not raised again. Both are plain JSONL so they can be read,
// edited and reviewed like any other file.
//
//   repo scope  <repo>/.pre-push-review/learnings.jsonl   committed, shared with the team
//   user scope  <harness home>/learnings.jsonl           private to this machine
//
// Usage counts are kept apart from the learnings (in the harness home) so that applying a
// learning never produces a diff in the repository.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { matchesAny } from './glob.mjs';
import { appendJsonl, harnessHome, readJsonl } from './state.mjs';

export const KINDS = ['rule', 'rejection'];
export const SCOPES = ['repo', 'user'];
export const REPO_LEARNINGS = '.pre-push-review/learnings.jsonl';

export function learningsPath(scope, root, env = process.env) {
  return scope === 'repo' ? join(root, REPO_LEARNINGS) : join(harnessHome(env), 'learnings.jsonl');
}

function usagePath(env) {
  return join(harnessHome(env), 'learning-usage.json');
}

function isValid(row) {
  return (
    row != null &&
    typeof row === 'object' &&
    typeof row.id === 'string' &&
    KINDS.includes(row.kind) &&
    typeof row.text === 'string' &&
    row.text.trim() !== ''
  );
}

/** All learnings visible from `root`, repo scope first. Malformed rows are ignored. */
export function loadLearnings(root, env = process.env) {
  const out = [];
  for (const scope of SCOPES) {
    for (const row of readJsonl(learningsPath(scope, root, env))) {
      if (isValid(row)) out.push({ ...row, scope, paths: Array.isArray(row.paths) ? row.paths : [] });
    }
  }
  return out;
}

/** Learnings that apply to the change: no path restriction, or a glob matching a changed file. */
export function relevantLearnings(learnings, changedPaths) {
  return learnings.filter(
    (l) => l.paths.length === 0 || changedPaths.some((p) => matchesAny(p, l.paths)),
  );
}

function makeId(text, existing) {
  const base = createHash('sha256').update(text).digest('hex');
  for (let len = 6; len <= base.length; len++) {
    const id = `L-${base.slice(0, len)}`;
    if (!existing.has(id)) return id;
  }
  return `L-${base}`;
}

/**
 * Record a learning. `finding` (optional) is the reviewed finding the learning comes from; a
 * compact copy is stored so the reason stays understandable after the code has moved on.
 */
export function addLearning({ root, scope = 'repo', kind, text, paths = [], finding = null, author = null }, env = process.env) {
  if (!SCOPES.includes(scope)) throw new Error(`scope must be one of ${SCOPES.join(', ')}`);
  if (!KINDS.includes(kind)) throw new Error(`kind must be one of ${KINDS.join(', ')}`);
  if (typeof text !== 'string' || text.trim() === '') throw new Error('a learning needs a non-empty text');
  if (!Array.isArray(paths) || !paths.every((p) => typeof p === 'string' && p.trim() !== ''))
    throw new Error('paths must be a list of glob patterns');

  const existing = new Set(loadLearnings(root, env).map((l) => l.id));
  const row = {
    id: makeId(`${kind}\n${text.trim()}\n${paths.join(',')}`, existing),
    kind,
    text: text.trim(),
    paths,
    created: new Date().toISOString(),
    ...(author ? { author } : {}),
    ...(finding
      ? {
          finding: {
            category: finding.category ?? null,
            file: finding.file ?? null,
            title: finding.title ?? null,
            severity: finding.severity ?? null,
          },
        }
      : {}),
  };
  appendJsonl(learningsPath(scope, root, env), row);
  return { ...row, scope };
}

/** Remove a learning by id from whichever scope holds it. Returns the removed row or null. */
export function removeLearning(root, id, env = process.env) {
  for (const scope of SCOPES) {
    const path = learningsPath(scope, root, env);
    const rows = readJsonl(path);
    const hit = rows.find((r) => r.id === id);
    if (!hit) continue;
    const rest = rows.filter((r) => r.id !== id);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, rest.map((r) => JSON.stringify(r)).join('\n') + (rest.length ? '\n' : ''));
    renameSync(tmp, path);
    return { ...hit, scope };
  }
  return null;
}

export function loadUsage(env = process.env) {
  const path = usagePath(env);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Count one application of each id (a learning that was the stated reason for a verdict). */
export function recordUsage(ids, env = process.env) {
  const unique = [...new Set(ids.filter((id) => typeof id === 'string' && id))];
  if (unique.length === 0) return;
  try {
    const usage = loadUsage(env);
    const now = new Date().toISOString();
    for (const id of unique) {
      usage[id] = { count: (usage[id]?.count ?? 0) + 1, lastUsed: now };
    }
    const path = usagePath(env);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(usage, null, 2) + '\n');
    renameSync(tmp, path);
  } catch {
    /* usage counts are best-effort */
  }
}

/** Learnings formatted for a prompt, tagged with their id so an agent can cite the one it used. */
export function renderLearnings(learnings) {
  return learnings
    .map((l) => {
      const where = l.paths.length ? ` (applies to ${l.paths.join(', ')})` : '';
      const label = l.kind === 'rejection' ? 'KNOWN FALSE POSITIVE' : 'RULE';
      return `- [${l.id}] ${label}${where}: ${l.text}`;
    })
    .join('\n');
}
