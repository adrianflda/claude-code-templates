// Re-gate on resume (spec §5.3, decision §8.2): the journal's gate_green is a claim made before the
// crash; the gate is re-run once per repo at the LATEST gate_green SHA (not per task, to bound cost).
// Journal green + gate now red -> divergence `gate_red_now` (INV-4).
//
// The gate runs with --no-ledger: the referee's evidence ledger lives inside the product repo, and
// resume never writes there (INV-6). It reads the committed base..head trees from git objects, never
// a worktree. Exit 3 (referee green, but a critical surface still needs the live breaker) is not red:
// the referee passed, which is what gate_green recorded; it is reported in `regate`, not a divergence.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const QK_GATE = join(dirname(fileURLToPath(import.meta.url)), '..', 'qk-gate.mjs');

// -> { status, json } ; json is the gate's last stdout line, or null.
export function runQkGate({ org, repoDir, base, head }) {
  const r = spawnSync(process.execPath, [QK_GATE, '--repo', repoDir, '--base', base, '--head', head, '--org', org, '--no-ledger'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  let json = null;
  try { json = JSON.parse((r.stdout || '').trim().split('\n').filter(Boolean).pop()); } catch { json = null; }
  return { status: r.error ? null : r.status, json, error: r.error?.message };
}

// The latest gate_green task of each repo among `done` (tasks git already confirmed): latest `gate.at`,
// ties broken by task id so the choice is deterministic. -> [[repo, task]] sorted by repo.
export function latestGreens(state, done) {
  const best = new Map();
  for (const id of done) {
    const t = state.tasks[id];
    const cur = best.get(t.repo);
    const at = Date.parse(t.gate.at);
    if (!cur || at > cur.at || (at === cur.at && id > cur.t.task_id)) best.set(t.repo, { t, at });
  }
  return [...best.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([repo, { t }]) => [repo, t]);
}

// -> { regate: [{ repo, task_id, sha, exit, gate }], divergences } ; throws via `indeterminate`.
export function regate(org, state, plan, dirs, bases, { runGate = runQkGate, indeterminate }) {
  const out = { regate: [], divergences: [] };
  for (const [repo, t] of latestGreens(state, plan.done)) {
    const r = runGate({ org, repoDir: dirs[repo], base: bases[repo], head: t.head_sha });
    const entry = { repo, task_id: t.task_id, sha: t.head_sha, exit: r.status, gate: r.json?.gate ?? null };
    if (r.status === 1) {
      out.divergences.push({ task_id: t.task_id, kind: 'gate_red_now', repo, sha: t.head_sha });
    } else if (r.status !== 0 && r.status !== 3) {
      const why = r.json?.notes?.join('; ') || r.json?.referee?.reason || r.error || `exit ${r.status}`;
      throw indeterminate(`re-gate of ${repo} at ${t.head_sha} (task ${t.task_id}) is indeterminate: ${why}`);
    }
    out.regate.push(entry);
  }
  return out;
}
