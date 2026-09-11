#!/usr/bin/env node
// Composed gate WITH the enforced blind breaker — M2. Spec: docs/agentic-harness/spec-m2-plan-qa.v1.md
//
// Closes qk-gate's honest "exit 3 = breaker required but NOT enforced" note (D3): on the critical
// surface, a green referee is not enough — the blind breaker (P5) must PASS against the live system.
//   qk-gate 0            -> 0  (verified, no breaker required)
//   qk-gate 3 + breaker  -> breaker-invoke: PASS->0 · FAIL->1 · could-not-run->2
//   qk-gate 3, no breaker-> 3  (still unenforced; caller must supply --breaker for a real critical merge)
//   qk-gate 1/2          -> passthrough (real fail / indeterminate)
//
// Usage: breaker-gate.mjs --repo <dir> --base <ref> [--head <ref>]
//        [--breaker "<cmd>" --contract <id>.md --probe "<cmd>" --url <systemUrl>]

import { spawnSync } from 'node:child_process';
import { dirname, join, basename, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { diff as contractDiff } from './contract-lint.mjs';
import { showAtRef } from './route.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
function opt(name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; }

const repo = opt('--repo'), base = opt('--base'), head = opt('--head');
const breaker = opt('--breaker'), contract = opt('--contract'), probe = opt('--probe'), url = opt('--url');
const acceptanceArg = opt('--acceptance');
const emit = (v, code) => { process.stdout.write(JSON.stringify(v) + '\n'); process.exit(code); };
if (!repo || !base) emit({ gate: 'error', error: 'need --repo <dir> --base <ref> [--head <ref>]' }, 2);

const gateArgs = ['--repo', repo, '--base', base, ...(head ? ['--head', head] : [])];
const g = spawnSync('node', [join(here, 'qk-gate.mjs'), ...gateArgs], { encoding: 'utf8' });
let gj = null; try { gj = JSON.parse((g.stdout || '').trim().split('\n').filter(Boolean).pop()); } catch { /* null */ }

if (g.status !== 3) emit({ gate: gj ? gj.gate : 'error', refereeGate: gj, breaker: null }, g.status); // 0/1/2 passthrough

// critical surface: the breaker is REQUIRED.
if (!breaker || !contract) emit({ gate: 'blocked-needs-breaker', refereeGate: gj, breaker: null, notes: ['critical change: supply --breaker "<cmd>" --contract <id>.md to enforce the live breaker (P5).'] }, 3);

// --- mandatory, base-anchored contract lint (precondition, not a documented prerequisite) ---
// Without this, a contract with no `## Invariants` rows (or one whose acceptance suite never cites
// them) makes breaker-invoke ship an empty invariant set — and any PASSing breaker then satisfies the
// gate. The contract is read at the BASE ref where possible so a head-side edit cannot weaken it.
// Both documented layouts: <id>.md beside <id>.test.mjs, and the shipped contracts/ + acceptance/
// sibling pair. --acceptance overrides the search.
const acceptanceCandidates = acceptanceArg ? [acceptanceArg] : [
  contract.replace(/\.md$/, '.test.mjs'),
  join(dirname(contract), '..', 'acceptance', basename(contract).replace(/\.md$/, '.test.mjs')),
];
function repoRelative(p) {
  if (!repo) return null;
  const r = relative(resolve(repo), resolve(p));
  return (r && !r.startsWith('..') && !isAbsolute(r)) ? r : null;
}
// Prefer the BASE ref so a head-side edit cannot weaken the contract it is judged against; fall back
// to the worktree (a brand-new contract does not exist at base) and report which anchor was used.
function readPair(acc) {
  const cRel = repoRelative(contract), aRel = repoRelative(acc);
  if (cRel && aRel && base) {
    const cb = showAtRef(repo, base, cRel), ab = showAtRef(repo, base, aRel);
    if (cb !== null && ab !== null) return { contractSrc: cb, acceptanceSrc: ab, anchor: 'base', acceptance: acc };
  }
  if (existsSync(contract) && existsSync(acc)) {
    return { contractSrc: readFileSync(contract, 'utf8'), acceptanceSrc: readFileSync(acc, 'utf8'), anchor: 'worktree', acceptance: acc };
  }
  return null;
}
let pair = null;
for (const acc of acceptanceCandidates) { pair = readPair(acc); if (pair) break; }
if (!pair) {
  emit({
    gate: 'blocked-invalid-contract', refereeGate: gj, breaker: null,
    contractLint: { ok: false, anchor: null, error: `contract or acceptance suite not found (contract: ${contract}; tried acceptance: ${acceptanceCandidates.join(', ')}) — pass --acceptance <file>` },
  }, 3);
}
const { contractSrc, acceptanceSrc, anchor } = pair;
const lint = contractDiff(contractSrc, acceptanceSrc);
const lintOk = lint.declared.length > 0 && lint.missingAssertion.length === 0 && lint.orphanAssertion.length === 0;
if (!lintOk) {
  emit({
    gate: 'blocked-invalid-contract', refereeGate: gj, breaker: null,
    contractLint: { ok: false, anchor, ...lint },
    notes: [lint.declared.length === 0
      ? 'contract declares no invariants (## Invariants table is empty) — the breaker would be handed an empty invariant set.'
      : 'contract and acceptance suite are out of lockstep — every invariant needs an assertion and every assertion an invariant.'],
  }, 3);
}

const b = spawnSync('node', [join(here, 'breaker-invoke.mjs'), '--contract', contract, ...(probe ? ['--probe', probe] : []), ...(url ? ['--url', url] : []), '--breaker', breaker], { encoding: 'utf8' });
let bj = null; try { bj = JSON.parse((b.stdout || '').trim().split('\n').filter(Boolean).pop()); } catch { /* null */ }
const contractLint = { ok: true, anchor, declared: lint.declared, checked: lint.checked };

// A passing breaker closes the CRITICAL-SURFACE cause of exit 3 — never the human-review cause.
// qk-gate also returns 3 when the referee saw test files overlaid from head: a test change is a
// contract change, and no breaker verdict can stand in for the human who owns the contract.
if (b.status === 0 && gj && gj.requiresHumanReview) {
  emit({
    gate: 'blocked-needs-human-review', refereeGate: gj, breaker: bj, contractLint,
    notes: ['breaker PASSed, but test file(s) were modified and overlaid from head — a test change is a contract change and still requires human review before merge.'],
  }, 3);
}

const gate = b.status === 0 ? 'pass' : b.status === 1 ? 'breaker-fail' : 'breaker-indeterminate';
emit({ gate, refereeGate: gj, breaker: bj, contractLint }, b.status);
