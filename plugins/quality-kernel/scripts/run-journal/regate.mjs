// Re-gate on resume: the real qk-gate, once per repo, at the latest gate_green SHA (spec §5.3, §8.2).
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const QK_GATE = join(dirname(fileURLToPath(import.meta.url)), '..', 'qk-gate.mjs');

// -> { status, json, error } ; status null when the gate did not exit normally, json = its last stdout
// line (or null). --no-ledger: the referee's ledger lives inside the product repo (INV-6).
export function runQkGate({ org, repoDir, base, head }) {
  const r = spawnSync(process.execPath, [QK_GATE, '--repo', repoDir, '--base', base, '--head', head, '--org', org, '--no-ledger'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  let json = null;
  try { json = JSON.parse((r.stdout || '').trim().split('\n').filter(Boolean).pop()); } catch { json = null; }
  return { status: r.error ? null : r.status, json, error: r.error?.message || (r.signal ? `killed by ${r.signal}` : undefined) };
}

// The latest gate_green task of each repo among `done` (latest `gate.at`; ties: the greater task id).
// -> [[repo, task]] sorted by repo.
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

// -> { regate: [{ repo, task_id, sha, exit, gate }], divergences } or { error } (indeterminate).
// Red needs the gate's own `fail` verdict: an exit 1 without it (e.g. a crash) is not a verdict.
export function regate(org, state, done, dirs, bases, { runGate = runQkGate } = {}) {
  const out = { regate: [], divergences: [] };
  for (const [repo, t] of latestGreens(state, done)) {
    const r = runGate({ org, repoDir: dirs[repo], base: bases[repo], head: t.head_sha });
    const gate = r.json?.gate ?? null;
    const red = r.status === 1 && gate === 'fail';
    if (!red && !((r.status === 0 && gate === 'pass') || (r.status === 3 && gate === 'blocked-needs-breaker'))) {
      const why = r.json?.notes?.join('; ') || r.json?.referee?.reason || r.error || `exit ${r.status}, verdict ${gate}`;
      return { error: `re-gate of ${repo} at ${t.head_sha} (task ${t.task_id}) is indeterminate: ${why}` };
    }
    if (red) out.divergences.push({ task_id: t.task_id, kind: 'gate_red_now', repo, sha: t.head_sha });
    out.regate.push({ repo, task_id: t.task_id, sha: t.head_sha, exit: r.status, gate });
  }
  return out;
}
