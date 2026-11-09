#!/usr/bin/env node
// Run journal for long-running quality-kernel runs (spec: docs/agentic-harness/spec-run-journal.v1.md).
// Progress lives outside the agent's context, in <org>/.quality-kernel/runs/<run>/journal.jsonl, and a
// resume checks it against git before anything continues.
//
// Usage:
//   run-journal.mjs append --org <dir> --run <id> --expect-seq <n> --record '<json>'
//       exit 0 written · 2 invalid record or corrupt journal · 3 conflict (seq moved / lock busy)
//   run-journal.mjs fold   --org <dir> --run <id>      current state as JSON (exit 2 if corrupt)
//   run-journal.mjs resume --org <dir> --run <id>      resume plan as JSON
//       exit 0 consistent, continue (tasks needing a human are listed in "blocked")
//       · 1 divergence, STOP and report · 2 indeterminate
//   run-journal.mjs open   --org <dir>                 runs without run_finished
//
// QK_JOURNAL_LOCK_WAIT_MS (default 5000, max 60000): how long an append waits for a live lock holder.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { append, loadRun, openRuns } from './run-journal/store.mjs';
import { Indeterminate, reconcile } from './run-journal/reconcile.mjs';

const out = (obj, code) => { process.stdout.write(`${JSON.stringify(obj)}\n`); process.exitCode = code; };
const opt = (argv, name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

function foldRun(org, run) {
  const f = loadRun(org, run);
  if (f.error) throw new Indeterminate(`journal is corrupt: ${f.error}`);
  return f;
}

const COMMANDS = {
  append(argv, org, run) {
    const raw = opt(argv, '--expect-seq');
    const seq = /^(0|[1-9]\d{0,15})$/.test(raw ?? '') ? Number(raw) : NaN;
    if (!Number.isSafeInteger(seq)) return out({ ok: false, error: '--expect-seq must be a non-negative integer' }, 2);
    let record;
    try { record = JSON.parse(opt(argv, '--record') ?? ''); } catch { return out({ ok: false, error: '--record must be JSON' }, 2); }
    const r = append(org, run, seq, record);
    return r.code === 0 ? out({ ok: true, seq: r.seq }, 0) : out({ ok: false, error: r.error }, r.code);
  },
  fold(argv, org, run) {
    const f = foldRun(org, run);
    return out({ ok: true, seq: f.seq, torn_tail: f.tornTail, ...f.state }, 0);
  },
  resume(argv, org, run) {
    const f = foldRun(org, run);
    const plan = reconcile(org, f.state);
    return out({ ok: plan.divergences.length === 0, torn_tail: f.tornTail, ...plan }, plan.divergences.length ? 1 : 0);
  },
  open(argv, org) { return out({ open: openRuns(org) }, 0); },
};

export function main(argv) {
  const cmd = Object.hasOwn(COMMANDS, argv[0] ?? '') ? COMMANDS[argv[0]] : undefined;
  const orgArg = opt(argv, '--org');
  if (!cmd || !orgArg) return out({ ok: false, error: 'usage: run-journal.mjs <append|fold|resume|open> --org <dir> [--run <id>] ...' }, 2);
  try {
    const org = realpathSync.native(orgArg);
    const run = opt(argv, '--run');
    if (argv[0] !== 'open' && !run) return out({ ok: false, error: '--run is required' }, 2);
    return cmd(argv, org, run);
  } catch (e) {
    return out({ ok: false, error: e.message }, 2);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
