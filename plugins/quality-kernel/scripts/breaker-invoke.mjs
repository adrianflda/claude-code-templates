#!/usr/bin/env node
// Blind breaker invoker — M2 (qa-paradigms P5; constitution P3 "independence ≠ another LLM").
// Spec: docs/agentic-harness/spec-m2-plan-qa.v1.md · Plan §5 (the information boundary).
//
// Builds the breaker's input from the CONTRACT ONLY — the QA procedure + the observable invariants +
// a live probe + the system URL — and NOTHING that would collapse independence: never the diff, the
// changed files, the coder's tests, or any agent reasoning. Then it shells to a breaker command
// (in production, the host `pipeline-breaker` agent; in tests, a deterministic stub) and reads a typed
// verdict. Green requires BREAKER_PASS.
//
// Usage: breaker-invoke.mjs --contract <id>.md --probe "<cmd>" --url <systemUrl> --breaker "<cmd>"
// Exit:  0 = BREAKER_PASS · 1 = BREAKER_FAIL · 2 = could-not-run (fail-closed)

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

function section(md, name) {
  const lines = md.split('\n'); const out = []; let inSec = false;
  for (const l of lines) {
    if (new RegExp(`^##\\s+${name}\\b`, 'i').test(l)) { inSec = true; continue; }
    if (inSec && /^##\s+/.test(l)) break;
    if (inSec) out.push(l);
  }
  return out.join('\n').trim();
}
function invariants(md) {
  const out = []; let inTable = false;
  for (const l of md.split('\n')) {
    if (/^##\s+Invariants\b/i.test(l)) { inTable = true; continue; }
    if (inTable && /^##\s+/.test(l)) break;
    if (inTable) { const m = l.match(/^\s*\|\s*(INV-[A-Za-z0-9-]+)\s*\|(.*)\|\s*([^|]*)\|\s*$/); if (m) out.push({ id: m[1], expected: m[3].trim() }); }
  }
  return out;
}
// The ONLY things the breaker may see. Deliberately excludes diff/changed/tests/reasoning (P5).
export function buildBlindInput(md, { probeCmd = null, systemUrl = null } = {}) {
  return { qaProcedure: section(md, 'QA procedure'), invariants: invariants(md), probeCmd, systemUrl };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  let contract = null, probe = null, url = null, breaker = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--contract') contract = args[++i];
    else if (args[i] === '--probe') probe = args[++i];
    else if (args[i] === '--url') url = args[++i];
    else if (args[i] === '--breaker') breaker = args[++i];
  }
  const bail = (reason) => { process.stdout.write(JSON.stringify({ verdict: 'BREAKER_INDETERMINATE', reason }) + '\n'); process.exit(2); };
  if (!contract || !breaker) bail('need --contract <md> --breaker "<cmd>"');
  if (!existsSync(contract)) bail(`contract not found: ${contract}`);

  const input = buildBlindInput(readFileSync(contract, 'utf8'), { probeCmd: probe, systemUrl: url });
  const r = spawnSync(breaker, { input: JSON.stringify(input), shell: true, encoding: 'utf8', timeout: 600000 });
  if (r.error || r.status === null) bail(`breaker could not run: ${r.error ? r.error.message : 'no exit'}`);
  let verdict;
  try { verdict = JSON.parse((r.stdout || '').trim().split('\n').filter(Boolean).pop()); } catch { bail('breaker produced no JSON verdict'); }
  process.stdout.write(JSON.stringify({ ...verdict, blindInputKeys: Object.keys(input) }) + '\n');
  process.exit(verdict.verdict === 'BREAKER_PASS' ? 0 : verdict.verdict === 'BREAKER_FAIL' ? 1 : 2);
}
