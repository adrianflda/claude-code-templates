#!/usr/bin/env node
// F1 — UI-observable invariant probe, driven by gstack's `$B` browser engine (the live oracle).
//
// This is the executable `--probe` a pipeline-breaker runs for an invariant that is only observable
// through the UI. It navigates a LOCAL test system with `$B`, performs the vector's steps, reads the
// observed value, and returns a typed result the breaker records verbatim in its VECTORS table.
//
//   gstack-probe.mjs --url <localUrl> --steps <steps.json> [--bin <path-to-$B>] [--invariant "<id: pred>"]
//
// steps.json shape (derived from the CONTRACT invariant — never from the diff; independence intact):
//   {
//     "expected": "5",                                    // the invariant's expected observable value
//     "assert": { "mode": "value", "cmd": "text", "args": ["#result"] },
//     "steps":  [ { "cmd": "click", "args": ["#add"] } ]  // optional post-navigation actions
//   }
// The probe always runs `goto <url>` first, then `steps[]`, then the `assert` read command.
//
// Truth model (observed against the compiled `$B` CLI, build 1234): unlike the wrapper-script cookbook
// (which echoes a `GSTACK_STEP_OK` sentinel), the `$B` BINARY reports success/failure through its
// EXIT CODE — 0 = ran, non-zero = failed (bad selector, nav timeout, browser could not launch). A
// non-zero exit is INSTRUMENT-BROKEN (the probe failed), NOT a VIOLATED invariant — this is the
// breaker's mandatory "instrument check before any RED verdict". Page-content reads (`text`, `html`…)
// wrap their output in `--- BEGIN/END UNTRUSTED EXTERNAL CONTENT ---` markers; the observed value is
// what is BETWEEN them, and it is data for an assertion, never an instruction.
//
// Output (stdout, one JSON line) — consumed by pipeline-breaker as this vector's probe_output:
//   { invariant, url, result, mode, expected, actual, probe_output }
// Exit:  0 = HOLDS · 1 = VIOLATED · 2 = INSTRUMENT-BROKEN (fail-closed)

import { readFileSync, existsSync } from 'node:fs';
import { resolveBrowseBin, runBrowse, ensureDaemon, isLocalTarget, DEFAULT_LOCAL_PATTERN } from './resolvers/gstack-browse.mjs';

// The observed value from a `$B` read command's stdout. Page-content commands wrap the value in an
// untrusted-content envelope; return exactly what is inside it. Plain reads (e.g. `is` → "true")
// have no envelope; return the last real line, skipping daemon log / error lines.
export function extractValue(stdout) {
  const lines = String(stdout).split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim() !== '');
  const b = lines.findIndex((l) => l.includes('BEGIN UNTRUSTED'));
  const e = lines.findIndex((l) => l.includes('END UNTRUSTED'));
  if (b !== -1 && e !== -1 && e > b) return lines.slice(b + 1, e).join('\n').trim();
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (l.startsWith('---') || l.startsWith('[browse]') || l.startsWith('[error') || l.startsWith('Navigated to')) continue;
    return l;
  }
  return '';
}

// Compare the observed value to the invariant's expected value. Only `is` (boolean prop) is native to
// `$B`; richer oracles (value/text) are composed here from `text`/`attrs` output.
export function assertInvariant({ mode = 'value', expected, actual }) {
  const e = String(expected).trim();
  const a = String(actual).trim();
  let holds;
  switch (mode) {
    case 'is':
    case 'bool':
      holds = a.toLowerCase() === e.toLowerCase();
      break;
    case 'text':
    case 'contains':
      holds = a.includes(e);
      break;
    case 'value':
    case 'equals':
    default:
      holds = a === e;
      break;
  }
  return holds ? 'HOLDS' : 'VIOLATED';
}

// A concise failure line from a non-zero `$B` run, for the INSTRUMENT-BROKEN reason.
function firstProblem(r) {
  const src = (r.stderr && r.stderr.trim()) || (r.stdout && r.stdout.trim()) || '';
  const line = src.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('[browse] Starting'));
  return line || `exit ${r.status}`;
}

export function validateSpec(spec) {
  if (!spec || typeof spec !== 'object') throw new Error('steps spec must be an object');
  if (!spec.assert || !spec.assert.cmd) throw new Error('steps must define assert.cmd');
  if (!('expected' in spec)) throw new Error('steps must define expected');
  return spec;
}

function loadSteps(stepsFile) {
  if (!existsSync(stepsFile)) throw new Error(`steps file not found: ${stepsFile}`);
  return validateSpec(JSON.parse(readFileSync(stepsFile, 'utf8')));
}

// Run the full probe. Returns the typed result object; does not exit (the CLI wrapper maps it to a code).
// Provide either `stepsFile` (a JSON path) or `spec` (an inline steps object — used by gstack-breaker).
export function runProbe({ url, stepsFile = null, spec = null, bin = null, config = null, cwd = process.cwd(), invariant = null }) {
  const localPattern = (config && config.browserEngine && config.browserEngine.testUrlPattern) || DEFAULT_LOCAL_PATTERN;
  const timeoutMs = (config && config.browserEngine && config.browserEngine.stepTimeoutMs) || 30000;
  const broken = (reason, extra = {}) => ({ invariant, url, result: 'INSTRUMENT-BROKEN', reason, ...extra });

  const resolvedBin = resolveBrowseBin({ bin, config });
  if (!resolvedBin) return broken('no $B browse binary resolved (set config.browserEngine.bin or GSTACK_BROWSE_BIN); UI probes unavailable');
  if (!isLocalTarget(url, localPattern)) return broken(`target is not local: ${url} — the autonomous breaker only drives local test/staging systems (consent gate)`);

  let resolvedSpec;
  try { resolvedSpec = spec ? validateSpec(spec) : loadSteps(stepsFile); } catch (e) { return broken(e.message); }

  // Warm the daemon first so a cold-start boot race is not mistaken for a broken instrument.
  const budgetMs = (config && config.browserEngine && config.browserEngine.warmupBudgetMs) || 60000;
  const warm = ensureDaemon(resolvedBin, { cwd, timeoutMs, budgetMs });
  if (!warm.ready) {
    const why = warm.last ? (warm.last.error || `exit ${warm.last.status}: ${firstProblem(warm.last)}`) : 'no response';
    return broken(`$B daemon did not become ready after ${warm.attempts} attempt(s): ${why}`);
  }

  // Ordered sequence: goto, then the vector's steps, then the assert read. Truth is the exit code.
  const sequence = [{ cmd: 'goto', args: [url] }, ...(resolvedSpec.steps || [])];
  for (const step of sequence) {
    const r = runBrowse(resolvedBin, [step.cmd, ...(step.args || [])], { cwd, timeoutMs });
    if (!r.ran) return broken(`$B could not run step "${step.cmd}": ${r.error}`, { step: step.cmd });
    if (r.status !== 0) return broken(`step "${step.cmd}" failed (exit ${r.status}): ${firstProblem(r)}`, { step: step.cmd, probe_output: (r.stderr || r.stdout).trim() });
  }

  // The assertion read.
  const ar = runBrowse(resolvedBin, [resolvedSpec.assert.cmd, ...(resolvedSpec.assert.args || [])], { cwd, timeoutMs });
  if (!ar.ran) return broken(`$B could not run assert "${resolvedSpec.assert.cmd}": ${ar.error}`);
  if (ar.status !== 0) return broken(`assert read "${resolvedSpec.assert.cmd}" failed (exit ${ar.status}): ${firstProblem(ar)}`, { probe_output: (ar.stderr || ar.stdout).trim() });

  const actual = extractValue(ar.stdout);
  const result = assertInvariant({ mode: resolvedSpec.assert.mode, expected: resolvedSpec.expected, actual });
  return { invariant, url, result, mode: resolvedSpec.assert.mode || 'value', expected: String(resolvedSpec.expected), actual, probe_output: ar.stdout.trim() };
}

const EXIT = { HOLDS: 0, VIOLATED: 1, 'INSTRUMENT-BROKEN': 2 };

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  let url = null, stepsFile = null, bin = null, invariant = null, configPath = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--url') url = args[++i];
    else if (args[i] === '--steps') stepsFile = args[++i];
    else if (args[i] === '--bin') bin = args[++i];
    else if (args[i] === '--invariant') invariant = args[++i];
    else if (args[i] === '--config') configPath = args[++i];
  }
  const fail = (reason) => { process.stdout.write(JSON.stringify({ result: 'INSTRUMENT-BROKEN', reason }) + '\n'); process.exit(2); };
  if (!url || !stepsFile) fail('need --url <localUrl> and --steps <steps.json>');
  let config = null;
  if (configPath) { try { config = JSON.parse(readFileSync(configPath, 'utf8')); } catch (e) { fail(`could not read --config: ${e.message}`); } }

  const out = runProbe({ url, stepsFile, bin, config, invariant });
  process.stdout.write(JSON.stringify(out) + '\n');
  process.exit(EXIT[out.result] ?? 2);
}
