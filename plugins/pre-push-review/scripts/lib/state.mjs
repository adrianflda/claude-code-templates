// Harness state. Per-repo state lives under the git common dir, so it is shared by every
// worktree of the repo and can never be committed by accident. Cross-repo data (the run ledger
// and user-scoped learnings) lives under the harness home.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { gitCommonDir } from './git.mjs';

export function harnessHome(env = process.env) {
  return env.PREPUSH_REVIEW_HOME || join(homedir(), '.claude', 'pre-push-review');
}

export function stateDir(root) {
  const common = gitCommonDir(root);
  return common ? join(common, 'pre-push-review') : null;
}

function readJson(path, fallback) {
  if (!path || !existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Write via a temp file + rename so a crash mid-write cannot leave a truncated state file. */
function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  renameSync(tmp, path);
}

export function readJsonl(path) {
  if (!path || !existsSync(path)) return [];
  const rows = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* a corrupt row is skipped, the rest of the file stays usable */
    }
  }
  return rows;
}

export function appendJsonl(path, row) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(row) + '\n');
}

// --- last reviewed commit, per review key (incremental review) -------------------------------

export function getReviewed(root, key) {
  const dir = stateDir(root);
  if (!dir) return null;
  return readJson(join(dir, 'state.json'), {}).reviews?.[key] ?? null;
}

export function setReviewed(root, key, entry) {
  const dir = stateDir(root);
  if (!dir) return false;
  const path = join(dir, 'state.json');
  const state = readJson(path, {});
  state.reviews = { ...(state.reviews ?? {}), [key]: { ...entry, ts: new Date().toISOString() } };
  writeJson(path, state);
  return true;
}

// --- the last full result, so `learn` and the fix loop can refer to findings by id -----------

export function saveLastResult(root, result) {
  const dir = stateDir(root);
  if (!dir) return null;
  const path = join(dir, 'last-review.json');
  writeJson(path, result);
  return path;
}

export function loadLastResult(root) {
  const dir = stateDir(root);
  return dir ? readJson(join(dir, 'last-review.json'), null) : null;
}

// --- run ledger -------------------------------------------------------------------------------

export function runLedgerPath(env = process.env) {
  return join(harnessHome(env), 'runs.jsonl');
}

export function recordRun(row, env = process.env) {
  try {
    appendJsonl(runLedgerPath(env), row);
    return true;
  } catch {
    return false; // metrics are best-effort; a read-only home must not fail a review
  }
}
