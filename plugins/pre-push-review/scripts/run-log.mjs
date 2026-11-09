/**
 * pre-push-review — the run log: one JSON line per review run, so the panel can be judged on
 * data (how often each reviewer runs, what it finds, what a push costs) instead of on
 * impressions. It lives next to the full logs, in ~/.cache/git-ai-review/runs.jsonl, and is read
 * by scripts/stats.mjs.
 *
 * Who writes a row: the panel (ai-review-panel.mjs) whenever it ends on its own, and the git
 * runner (git-pre-push.mjs) only when the panel never got to end: the quality gate blocked the
 * push first, or the panel could not start, was killed or timed out. So a push is one row per
 * reviewed range, which is one row for a normal push.
 *
 * Writing is best-effort: a read-only home must never fail a review.
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Bumped when a row's shape changes in a way stats.mjs must tell apart. */
export const RUN_LOG_FORMAT = 1;

export function runLogDir() {
  return join(homedir(), '.cache', 'git-ai-review');
}

export function runLogPath() {
  return join(runLogDir(), 'runs.jsonl');
}

/** Appends one row (with `v` and `ts` added) and returns the file path, or null when it could not write. */
export function recordRun(row) {
  try {
    const dir = runLogDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const path = join(dir, 'runs.jsonl');
    appendFileSync(path, `${JSON.stringify({ v: RUN_LOG_FORMAT, ts: new Date().toISOString(), ...row })}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
    return path;
  } catch {
    return null;
  }
}

/** Every parseable row of the log, oldest first. A corrupt line is skipped, not fatal. */
export function readRuns(path = runLogPath()) {
  if (!existsSync(path)) return [];
  const rows = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* skipped */
    }
  }
  return rows;
}

/** An empty per-severity tally. */
export const emptyCounts = () => ({ critical: 0, high: 0, medium: 0, low: 0 });

/** Token usage of a `claude -p --output-format json` result, in the shape stored per run. */
export function usageOf(result) {
  const u = result?.usage;
  if (!u) return null;
  return {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheCreation: u.cache_creation_input_tokens ?? 0,
  };
}

/** Sums usages that may be null. */
export function addUsage(a, b) {
  if (!b) return a;
  if (!a) return { ...b };
  return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheCreation: a.cacheCreation + b.cacheCreation };
}
