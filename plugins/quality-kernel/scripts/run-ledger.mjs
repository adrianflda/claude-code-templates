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

const VERDICTS = new Set(['pass', 'fail', 'kill']);
const bail = (error) => { process.stdout.write(JSON.stringify({ ok: false, error }) + '\n'); process.exit(2); };

// This ledger is the evidence base for the prove-or-kill economics (FR-C2/FR-C3), so a record that
// silently absorbs junk corrupts the very numbers it exists to support. `--tokens nope` used to
// serialize as `tokens: null` (JSON.stringify(NaN)) inside an ok:true record — indistinguishable
// from "not measured". Validate up front and fail closed instead.
const num = (n) => {
  const v = opt(n);
  if (v == null) return null;
  const parsed = Number(v);
  if (!Number.isFinite(parsed) || parsed < 0) bail(`${n} must be a finite, non-negative number (got "${v}")`);
  return parsed;
};

const repo = opt('--repo');
if (!repo) bail('need --repo <dir>');
const issue = opt('--issue');
if (typeof issue !== 'string' || issue.trim() === '') bail('need --issue <id>');
const verdict = opt('--verdict');
if (verdict != null && !VERDICTS.has(verdict)) bail(`--verdict must be one of ${[...VERDICTS].join('|')} (got "${verdict}")`);

const rec = {
  ts: Math.round(Date.now()) / 1000,
  issue,
  tokens: num('--tokens'),
  usd: num('--usd'),
  wallclockMs: num('--wallclock-ms'),
  humanInterventions: num('--interventions'),
  verdict,
};
try {
  const dir = join(repo, '.quality-kernel');
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'run-ledger.jsonl'), JSON.stringify(rec) + '\n');
} catch (e) { process.stdout.write(JSON.stringify({ ok: false, error: e.message }) + '\n'); process.exit(2); }
process.stdout.write(JSON.stringify({ ok: true, record: rec }) + '\n');
process.exit(0);
