// Vector breaker — executes a set of breaker-authored falsifying VECTORS against the live system
// and computes the verdict in code. The author (an LLM with no tools, see breaker-claude.mjs)
// writes data; only the instruments act:
//
//   { "invariant": "INV-1", "http": { requests, expect } }   -> http-probe.mjs
//   { "invariant": "INV-1", "ui":   { expected, assert, steps } } -> gstack-probe.mjs ($B browser)
//
// After every vector the contract's own probe (`probeCmd`, from the human-approved contract, never
// from the author) runs: exit 0 = HOLDS, another exit = VIOLATED, missing/timeout/signal = BROKEN.
// The whole set is validated before anything runs; one invalid vector makes the run
// INSTRUMENT-BROKEN (default-deny). The verdict rule is gstack-breaker's decideVerdict.

import { spawnSync } from "node:child_process";
import { decideVerdict, unanchoredVectors } from "./gstack-breaker.mjs";
import { runProbe } from "./gstack-probe.mjs";
import { runHttpVector, validateHttpSpec } from "./http-probe.mjs";

export const MAX_VECTORS = 30;
// Only the $B commands this repo has exercised. Anything else (eval, html, cookies, a goto to
// file:// or another host) could read state the breaker must not see; add commands only after
// checking what they expose.
export const UI_STEP_CMDS = new Set(["goto", "click"]);
export const UI_ASSERT_CMDS = new Set(["text", "is", "attrs"]);
const VECTOR_KEYS = new Set(["invariant", "http", "ui"]);
const UI_KEYS = new Set(["expected", "assert", "steps"]);
const PROBE_TIMEOUT_MS = 60_000;

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const stringArgs = (args) => args === undefined || (Array.isArray(args) && args.every((a) => typeof a === "string"));

function validateUi(ui, systemUrl) {
  if (!isObject(ui)) return "ui must be an object";
  const extra = Object.keys(ui).filter((k) => !UI_KEYS.has(k));
  if (extra.length) return `ui has unknown key(s): ${extra.join(", ")}`;
  if (!("expected" in ui)) return "ui.expected is required";
  if (!isObject(ui.assert) || !UI_ASSERT_CMDS.has(ui.assert.cmd) || !stringArgs(ui.assert.args)) {
    return `ui.assert.cmd must be one of ${[...UI_ASSERT_CMDS].join(", ")} with string args`;
  }
  if (ui.steps !== undefined && !Array.isArray(ui.steps)) return "ui.steps must be an array";
  for (const [i, step] of (ui.steps ?? []).entries()) {
    if (!isObject(step) || !UI_STEP_CMDS.has(step.cmd) || !stringArgs(step.args)) {
      return `ui.steps[${i}].cmd must be one of ${[...UI_STEP_CMDS].join(", ")} with string args`;
    }
    if (step.cmd === "goto") {
      let target;
      try {
        target = new URL(step.args?.[0] ?? "", systemUrl);
      } catch {
        return `ui.steps[${i}] goto target is not a URL`;
      }
      if (target.origin !== new URL(systemUrl).origin) return `ui.steps[${i}] goto leaves the system's origin`;
    }
  }
  return null;
}

// EARS-V1/V2: batch-level rules apply to the vectors array as a whole; one violated rule rejects
// the entire run before any vector executes. null when the batch is runnable, else the reason.
export function validateBatch(vectors, blind) {
  if (!Array.isArray(vectors) || vectors.length === 0) return "vectors must be a non-empty array";
  if (vectors.length > MAX_VECTORS) return `at most ${MAX_VECTORS} vectors`;
  try {
    new URL(blind.systemUrl);
  } catch {
    return `system URL is not a URL: ${blind.systemUrl}`;
  }
  return null;
}

// EARS-V4: a vector's per-vector rules, evaluated in this fixed order, stopping at (and
// returning) the first failing reason: (1) shape/unknown keys, (2) exactly one of http/ui, (3)
// the type-specific HTTP/UI rules (method/command sets, origin checks, the Host rule), (4) an
// HTTP vector with no expect when there is no contract probe, (5) anchoring. null when runnable.
export function validateVector(v, blind) {
  if (!isObject(v)) return "must be an object";
  const extra = Object.keys(v).filter((k) => !VECTOR_KEYS.has(k));
  if (extra.length) return `has unknown key(s): ${extra.join(", ")}`;
  if (("http" in v) === ("ui" in v)) return "needs exactly one of http or ui";
  const why = "http" in v ? validateHttpSpec(v.http, blind.systemUrl) : validateUi(v.ui, blind.systemUrl);
  if (why) return why;
  if ("http" in v && !v.http.expect && !blind.probeCmd) return "asserts nothing: add http.expect (there is no contract probe)";
  const [unanchored] = unanchoredVectors([v], blind.invariants ?? []);
  if (unanchored) return `vector not anchored to a contract invariant: ${unanchored}`;
  return null;
}

// Flat diagnostic over BOTH kinds of rule (EARS-V1), batch-level and per-vector, for callers that
// only need to know "is there any problem at all" without caring which kind — runVectors below is
// the one that routes the two kinds differently (batch-fatal vs. per-vector drop, EARS-V2/V3).
// [] when the set is runnable, else one message per problem.
export function validateVectors(vectors, blind) {
  const batchError = validateBatch(vectors, blind);
  if (batchError) return [batchError];
  const errors = [];
  for (const [i, v] of vectors.entries()) {
    const why = validateVector(v, blind);
    if (why) errors.push(`vectors[${i}]: ${why}`);
  }
  return errors;
}

export function runContractProbe(probeCmd, { cwd = process.cwd(), timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const r = spawnSync(probeCmd, { shell: true, cwd, encoding: "utf8", timeout: timeoutMs });
  const probe_output = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().slice(0, 500);
  if (r.error) return { result: "INSTRUMENT-BROKEN", reason: `probe could not run: ${r.error.code || r.error.message}`, probe_output };
  if (r.signal) return { result: "INSTRUMENT-BROKEN", reason: `probe killed by ${r.signal}`, probe_output };
  if (r.status === 126 || r.status === 127) return { result: "INSTRUMENT-BROKEN", reason: `probe not runnable (exit ${r.status})`, probe_output };
  return r.status === 0 ? { result: "HOLDS", probe_output } : { result: "VIOLATED", reason: `probe exited ${r.status}`, probe_output };
}

async function runOne(v, { blind, config, cwd, uiRunner, httpRunner }) {
  const action = "http" in v
    ? await httpRunner({ systemUrl: blind.systemUrl, spec: v.http, invariant: v.invariant, localPattern: config?.browserEngine?.testUrlPattern })
    : uiRunner({ url: blind.systemUrl, spec: v.ui, config, cwd, invariant: v.invariant });
  if (action.result !== "HOLDS" || !blind.probeCmd) return { invariant: v.invariant, ...action };
  const probe = runContractProbe(blind.probeCmd, { cwd });
  return { invariant: v.invariant, ...action, ...probe, actual: action.actual };
}

export async function runVectors({ vectors, blind, config = null, cwd = process.cwd(), uiRunner = runProbe, httpRunner = runHttpVector }) {
  // EARS-V2: a batch-level problem rejects the whole run; no vector executes.
  const batchError = validateBatch(vectors, blind);
  if (batchError) return { verdict: "INSTRUMENT-BROKEN", reason: batchError, executed: 0, vectors: [], dropped: [] };

  // EARS-V3/V4: a per-vector problem excludes only that vector; the rest still run. EARS-V5's
  // exception (D1) needs no extra code — if every vector is excluded, `runnable` is empty,
  // `results` is empty, and decideVerdict's own zero-length rule (EARS-V9) already yields
  // INSTRUMENT-BROKEN.
  const dropped = [];
  const runnable = [];
  vectors.forEach((v, index) => {
    const why = validateVector(v, blind);
    if (why) dropped.push({ index, reason: why });
    else runnable.push(v);
  });

  const results = [];
  for (const v of runnable) results.push(await runOne(v, { blind, config, cwd, uiRunner, httpRunner }));
  return {
    verdict: decideVerdict(results),
    executed: results.filter((r) => r.result !== "INSTRUMENT-BROKEN").length,
    vectors: results.map((r) => ({ invariant: r.invariant, result: r.result, reason: r.reason, expected: r.expected, actual: r.actual, probe_output: r.probe_output })),
    dropped,
  };
}
