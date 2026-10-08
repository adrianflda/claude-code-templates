#!/usr/bin/env node
// F1 — deterministic UI breaker: runs a set of falsifying VECTORS against a live local system through
// gstack's `$B` engine and returns the pipeline-breaker's typed verdict. This is the executable
// INSTRUMENT the blind `pipeline-breaker` agent drives (or a standalone deterministic breaker for
// UI-observable contracts). It never reads the diff/tests/reasoning — only the contract's invariants
// and the vectors authored from them (qa-paradigms P5 / constitution "independence ≠ another LLM").
//
//   gstack-breaker.mjs --contract <id>.md --url <localUrl> --vectors <vectors.json> [--bin <$B>] [--config <tools.json>]
//
// vectors.json (each vector is a falsifying probe authored FROM the contract):
//   [ { "invariant": "INV-ADD-1", "steps": { "expected":"5",
//       "assert": { "mode":"text", "cmd":"text", "args":["#result"] }, "steps":[] } }, ... ]
// Every vector's `invariant` id MUST match an id in the contract's `## Invariants` table (anchoring).
//
// Verdict (mirrors agents/pipeline-breaker.md):
//   INSTRUMENT-BROKEN  if any vector could not run / no probe / unanchored  → blocks (default-deny)
//   BREAKER_FAIL       if any vector VIOLATED
//   BREAKER_PASS       iff >= MIN_VECTORS executed and ALL HOLDS
//   BREAKER_INDETERMINATE otherwise (fewer than MIN_VECTORS HOLDS, none violated)
// Exit: 0 = BREAKER_PASS · 1 = BREAKER_FAIL · 2 = anything else (fail-closed)

import { readFileSync, existsSync } from 'node:fs';
import { runProbe } from './gstack-probe.mjs';
import { buildBlindInput } from './breaker-invoke.mjs';

export const MIN_VECTORS = 3;

// Pure verdict rule over probe results ([{ result: HOLDS|VIOLATED|INSTRUMENT-BROKEN }]).
export function decideVerdict(results) {
  if (results.length === 0) return 'INSTRUMENT-BROKEN';
  if (results.some((r) => r.result === 'INSTRUMENT-BROKEN')) return 'INSTRUMENT-BROKEN';
  if (results.some((r) => r.result === 'VIOLATED')) return 'BREAKER_FAIL';
  const holds = results.filter((r) => r.result === 'HOLDS');
  if (holds.length >= MIN_VECTORS && holds.length === results.length) return 'BREAKER_PASS';
  return 'BREAKER_INDETERMINATE';
}

// Contract anchoring: every vector must name an invariant id present in the contract. Returns the
// list of unanchored vector labels (empty === all anchored).
export function unanchoredVectors(vectors, contractInvariants) {
  const ids = new Set(contractInvariants.map((i) => i.id));
  const bad = [];
  for (const v of vectors) {
    const id = String(v.invariant || '').split(':')[0].trim();
    if (!id || !ids.has(id)) bad.push(v.invariant || '(missing invariant id)');
  }
  return bad;
}

export function runBreaker({ contractPath, url, vectorsFile, bin = null, config = null, cwd = process.cwd() }) {
  const broken = (reason, extra = {}) => ({ verdict: 'INSTRUMENT-BROKEN', reason, ...extra });
  if (!contractPath || !existsSync(contractPath)) return broken(`contract not found: ${contractPath}`);
  if (!vectorsFile || !existsSync(vectorsFile)) return broken(`vectors not found: ${vectorsFile}`);

  const { invariants } = buildBlindInput(readFileSync(contractPath, 'utf8'), {});
  let vectors;
  try { vectors = JSON.parse(readFileSync(vectorsFile, 'utf8')); } catch (e) { return broken(`bad vectors json: ${e.message}`); }
  if (!Array.isArray(vectors) || vectors.length === 0) return broken('vectors must be a non-empty array');

  const bad = unanchoredVectors(vectors, invariants);
  if (bad.length) return broken(`vector(s) not anchored to a contract invariant: ${bad.join(', ')} — the breaker measures against the contract, never a paraphrase`);

  const results = vectors.map((v) =>
    runProbe({ url, spec: v.steps, bin, config, cwd, invariant: v.invariant }));

  const verdict = decideVerdict(results);
  return {
    verdict,
    url,
    executed: results.filter((r) => r.result !== 'INSTRUMENT-BROKEN').length,
    vectors: results.map((r) => ({ invariant: r.invariant, result: r.result, expected: r.expected, actual: r.actual, probe_output: r.probe_output, reason: r.reason })),
  };
}

const EXIT = { BREAKER_PASS: 0, BREAKER_FAIL: 1 };

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  let contractPath = null, url = null, vectorsFile = null, bin = null, configPath = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--contract') contractPath = args[++i];
    else if (args[i] === '--url') url = args[++i];
    else if (args[i] === '--vectors') vectorsFile = args[++i];
    else if (args[i] === '--bin') bin = args[++i];
    else if (args[i] === '--config') configPath = args[++i];
  }
  const fail = (reason) => { process.stdout.write(JSON.stringify({ verdict: 'INSTRUMENT-BROKEN', reason }) + '\n'); process.exit(2); };
  if (!contractPath || !url || !vectorsFile) fail('need --contract <md> --url <localUrl> --vectors <vectors.json>');
  let config = null;
  if (configPath) { try { config = JSON.parse(readFileSync(configPath, 'utf8')); } catch (e) { fail(`could not read --config: ${e.message}`); } }

  const out = runBreaker({ contractPath, url, vectorsFile, bin, config });
  process.stdout.write(JSON.stringify(out) + '\n');
  process.exit(EXIT[out.verdict] ?? 2);
}
