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
import { isMain } from './is-main.mjs';
import { scanSections, emptySectionReason } from './contract-sections.mjs';

// The ONLY things the breaker may see. Deliberately excludes diff/changed/tests/reasoning (P5).
// Heading/table parsing itself lives in contract-sections.mjs (EARS-H1/H2/H2b/H3/H4/H4b/H5), shared
// with contract-lint.mjs and gstack-breaker.mjs so the two places that read a contract can't drift.
export function buildBlindInput(md, { probeCmd = null, systemUrl = null } = {}) {
  const { qaProcedure, invariants } = scanSections(md);
  return { qaProcedure, invariants, probeCmd, systemUrl };
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  let contract = null, probe = null, url = null, breaker = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--contract') contract = args[++i];
    else if (args[i] === '--probe') probe = args[++i];
    else if (args[i] === '--url') url = args[++i];
    else if (args[i] === '--breaker') breaker = args[++i];
  }
  const bail = (reason) => { process.stdout.write(JSON.stringify({ verdict: 'BREAKER_INDETERMINATE', reason }) + '\n'); process.exit(2); };
  const given = (v) => typeof v === 'string' && v.trim() !== '';
  if (!given(contract) || !given(breaker)) bail('need --contract <md> --breaker "<cmd>"');
  // A breaker with no live target is not a breaker: without a probe and a system URL it can only
  // reason about the contract text, yet a BREAKER_PASS would still close the critical path. Both are
  // REQUIRED (P5: the verdict must come from executing against live external state).
  if (!given(probe) || !given(url)) bail('need --probe "<cmd>" and --url <systemUrl>: the breaker verdict must come from executing against the live system');
  if (!existsSync(contract)) bail(`contract not found: ${contract}`);

  const md = readFileSync(contract, 'utf8');
  // Parse the contract once and reuse the result: buildBlindInput's own scanSections(md) call
  // (above) would otherwise re-run the same heading/table scan a second time on every invocation.
  const sections = scanSections(md);
  // EARS-H6: fail closed BEFORE the breaker command ever runs when a required section is empty —
  // an empty blind input is not "the breaker found nothing wrong", it is "the breaker never ran".
  const emptyReason = emptySectionReason(sections);
  if (emptyReason) {
    process.stdout.write(JSON.stringify({ verdict: 'INSTRUMENT-BROKEN', reason: emptyReason }) + '\n');
    process.exit(2);
  }

  const input = { qaProcedure: sections.qaProcedure, invariants: sections.invariants, probeCmd: probe, systemUrl: url };
  const r = spawnSync(breaker, { input: JSON.stringify(input), shell: true, encoding: 'utf8', timeout: 600000 });
  if (r.error || r.status === null) bail(`breaker could not run: ${r.error ? r.error.message : 'no exit'}`);
  // A breaker that printed BREAKER_PASS but exited non-zero did not complete cleanly; trusting the
  // text over the exit status would let a crashed/killed breaker green the gate. Fail closed.
  if (r.status !== 0) bail(`breaker exited ${r.status} — a verdict from a failed breaker process is not trusted`);
  let verdict;
  try { verdict = JSON.parse((r.stdout || '').trim().split('\n').filter(Boolean).pop()); } catch { bail('breaker produced no JSON verdict'); }
  process.stdout.write(JSON.stringify({ ...verdict, blindInputKeys: Object.keys(input) }) + '\n');
  process.exit(verdict.verdict === 'BREAKER_PASS' ? 0 : verdict.verdict === 'BREAKER_FAIL' ? 1 : 2);
}
