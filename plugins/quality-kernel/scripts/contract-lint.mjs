#!/usr/bin/env node
// Contract completeness lint — M2 (plan-with-teeth). Spec: docs/agentic-harness/spec-m2-plan-qa.v1.md
//
// The Contract is two coupled files: a human-facing `<id>.md` (an `## Invariants` table) and a
// machine-checkable `<id>.test.mjs` (one assertion per invariant, qa-paradigms P4). This proves they
// stay in lockstep — every invariant has an assertion and every assertion cites an invariant — so the
// plan's "done" is a mechanism, not prose. NO invariant without a check; NO check without an invariant.
//
// Usage: contract-lint.mjs --contract <id>.md --acceptance <id>.test.mjs
// Exit:  0 = in lockstep · 1 = orphan(s) · 2 = operational error

import { readFileSync, existsSync } from 'node:fs';

const ID_RE = /INV-[A-Za-z0-9-]+/g;

// Invariant ids DECLARED in the contract: rows of the `## Invariants` table, `| INV-x | … | … |`.
export function contractIds(md) {
  const ids = new Set();
  let inTable = false;
  for (const line of md.split('\n')) {
    if (/^##\s+Invariants\b/i.test(line)) { inTable = true; continue; }
    if (inTable && /^##\s+/.test(line)) break;            // next section ends the table
    if (inTable) { const m = line.match(/^\s*\|\s*(INV-[A-Za-z0-9-]+)\s*\|/); if (m) ids.add(m[1]); }
  }
  return ids;
}
// Invariant ids REFERENCED by the acceptance suite (in test names / comments).
export function acceptanceIds(src) {
  return new Set(src.match(ID_RE) || []);
}
export function diff(md, src) {
  const declared = contractIds(md), checked = acceptanceIds(src);
  const missingAssertion = [...declared].filter((id) => !checked.has(id));  // invariant with no check
  const orphanAssertion = [...checked].filter((id) => !declared.has(id));   // check with no invariant
  return { declared: [...declared], checked: [...checked], missingAssertion, orphanAssertion };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  let contract = null, acceptance = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--contract') contract = args[++i];
    else if (args[i] === '--acceptance') acceptance = args[++i];
  }
  const fail = (reason) => { process.stdout.write(JSON.stringify({ ok: false, error: reason }) + '\n'); process.exit(2); };
  if (!contract || !acceptance) fail('need --contract <md> --acceptance <testfile>');
  if (!existsSync(contract) || !existsSync(acceptance)) fail('contract or acceptance file not found');

  const d = diff(readFileSync(contract, 'utf8'), readFileSync(acceptance, 'utf8'));
  if (!d.declared.length) fail('no invariants declared in the contract (## Invariants table)');
  const ok = d.missingAssertion.length === 0 && d.orphanAssertion.length === 0;
  process.stdout.write(JSON.stringify({ ok, ...d }) + '\n');
  process.exit(ok ? 0 : 1);
}
