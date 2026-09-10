#!/usr/bin/env node
// Minimal run-ledger — M2 (D7). Records the cost/intervention numbers of a dogfood run so FR-C2/FR-C3
// (the prove-or-kill economics) can be evaluated. Full metrics + a cost circuit-breaker are M3.
// Spec: docs/agentic-harness/spec-m2-plan-qa.v1.md
//
// Usage: run-ledger.mjs --repo <dir> --issue <id> [--tokens N --usd N --wallclock-ms N
//                       --interventions N --verdict <pass|fail|kill>]
// Appends one JSON line to <repo>/.quality-kernel/run-ledger.jsonl and echoes it.

import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const num = (n) => { const v = opt(n); return v == null ? null : Number(v); };

const repo = opt('--repo');
if (!repo) { process.stdout.write(JSON.stringify({ ok: false, error: 'need --repo <dir>' }) + '\n'); process.exit(2); }

const rec = {
  ts: Math.round(Date.now()) / 1000,
  issue: opt('--issue'),
  tokens: num('--tokens'),
  usd: num('--usd'),
  wallclockMs: num('--wallclock-ms'),
  humanInterventions: num('--interventions'),
  verdict: opt('--verdict'),
};
try {
  const dir = join(repo, '.quality-kernel');
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'run-ledger.jsonl'), JSON.stringify(rec) + '\n');
} catch (e) { process.stdout.write(JSON.stringify({ ok: false, error: e.message }) + '\n'); process.exit(2); }
process.stdout.write(JSON.stringify({ ok: true, record: rec }) + '\n');
process.exit(0);
