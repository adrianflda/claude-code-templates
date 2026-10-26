// HTTP instrument for the blind breaker — runs ONE declarative HTTP vector against a live LOCAL
// system and judges the last response. The vector is data authored from the contract; this file
// is the only thing that acts on it, so the author never gets a shell (see vector-breaker.mjs).
//
//   { "requests": [ { "method": "POST", "path": "/cart/items", "headers": {...}, "body": {...} }, ... ],
//     "expect":   { "status": 200, "json": [ { "pointer": "/count", "equals": 1 } ] } }
//
// Boundaries, all enforced here:
//   - the system URL must be local (isLocalTarget, the same consent gate as the UI instrument);
//   - every path is resolved against the system URL and must stay on its origin;
//   - redirects are never followed (the 3xx itself is what the vector observes);
//   - every request has a timeout; a network error or timeout is INSTRUMENT-BROKEN, never VIOLATED.
// Result: HOLDS | VIOLATED | INSTRUMENT-BROKEN (+ reason, expected, actual).

import { isDeepStrictEqual } from "node:util";
import { DEFAULT_LOCAL_PATTERN, isLocalTarget } from "./resolvers/gstack-browse.mjs";

export const HTTP_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
export const MAX_REQUESTS = 20;
const SPEC_KEYS = new Set(["requests", "expect"]);
const REQUEST_KEYS = new Set(["method", "path", "headers", "body"]);
const EXPECT_KEYS = new Set(["status", "json"]);
const CHECK_KEYS = new Set(["pointer", "equals"]);
const DEFAULT_TIMEOUT_MS = 10_000;

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const extraKeys = (obj, allowed) => Object.keys(obj).filter((k) => !allowed.has(k));

function validateRequest(req, i, origin, systemUrl) {
  const at = `requests[${i}]`;
  if (!isObject(req)) return `${at} must be an object`;
  const extra = extraKeys(req, REQUEST_KEYS);
  if (extra.length) return `${at} has unknown key(s): ${extra.join(", ")}`;
  if (!HTTP_METHODS.has(req.method)) return `${at}.method must be one of ${[...HTTP_METHODS].join(", ")}`;
  if (typeof req.path !== "string" || !req.path.startsWith("/")) return `${at}.path must be an absolute path (starts with "/")`;
  // The resolved origin is the guard: "//host" and "/\host" both start with "/" yet leave the system.
  if (new URL(req.path, systemUrl).origin !== origin) return `${at}.path leaves the system's origin`;
  if (req.headers !== undefined) {
    if (!isObject(req.headers)) return `${at}.headers must be an object`;
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v !== "string") return `${at}.headers.${k} must be a string`;
      if (k.toLowerCase() === "host") return `${at}.headers may not set host`;
    }
  }
  if (req.body !== undefined && (req.method === "GET" || req.method === "HEAD")) return `${at}: ${req.method} cannot carry a body`;
  return null;
}

function validateExpect(expect) {
  if (!isObject(expect)) return "expect must be an object";
  const extra = extraKeys(expect, EXPECT_KEYS);
  if (extra.length) return `expect has unknown key(s): ${extra.join(", ")}`;
  if (expect.status !== undefined && !Number.isInteger(expect.status)) return "expect.status must be an integer";
  if (expect.json !== undefined) {
    if (!Array.isArray(expect.json) || expect.json.length === 0) return "expect.json must be a non-empty array";
    for (const [i, c] of expect.json.entries()) {
      if (!isObject(c) || extraKeys(c, CHECK_KEYS).length || typeof c.pointer !== "string" || !("equals" in c)) {
        return `expect.json[${i}] must be { pointer, equals }`;
      }
    }
  }
  return null;
}

// null when the spec is runnable against systemUrl, else the reason it is not.
export function validateHttpSpec(spec, systemUrl) {
  if (!isObject(spec)) return "http spec must be an object";
  const extra = extraKeys(spec, SPEC_KEYS);
  if (extra.length) return `http spec has unknown key(s): ${extra.join(", ")}`;
  if (!Array.isArray(spec.requests) || spec.requests.length === 0) return "http.requests must be a non-empty array";
  if (spec.requests.length > MAX_REQUESTS) return `http.requests may hold at most ${MAX_REQUESTS} requests`;
  let origin;
  try {
    origin = new URL(systemUrl).origin;
  } catch {
    return `system URL is not a URL: ${systemUrl}`;
  }
  for (const [i, req] of spec.requests.entries()) {
    const why = validateRequest(req, i, origin, systemUrl);
    if (why) return why;
  }
  return spec.expect === undefined ? null : validateExpect(spec.expect);
}

// RFC 6901 JSON Pointer lookup.
export function jsonPointer(doc, pointer) {
  if (pointer === "") return { found: true, value: doc };
  if (!pointer.startsWith("/")) return { found: false };
  let node = doc;
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (node === null || typeof node !== "object" || !Object.prototype.hasOwnProperty.call(node, key)) return { found: false };
    node = node[key];
  }
  return { found: true, value: node };
}

function judge(expect, response) {
  if (!expect) return { result: "HOLDS" };
  if (expect.status !== undefined && response.status !== expect.status) {
    return { result: "VIOLATED", reason: `status ${response.status}, expected ${expect.status}` };
  }
  if (expect.json) {
    let doc;
    try {
      doc = JSON.parse(response.text);
    } catch {
      return { result: "VIOLATED", reason: "response body is not JSON" };
    }
    for (const check of expect.json) {
      const hit = jsonPointer(doc, check.pointer);
      if (!hit.found) return { result: "VIOLATED", reason: `${check.pointer} is absent` };
      if (!isDeepStrictEqual(hit.value, check.equals)) {
        return { result: "VIOLATED", reason: `${check.pointer} is ${JSON.stringify(hit.value)}, expected ${JSON.stringify(check.equals)}` };
      }
    }
  }
  return { result: "HOLDS" };
}

function requestInit(req, timeoutMs) {
  const headers = { ...(req.headers || {}) };
  let body;
  if (req.body !== undefined) {
    if (typeof req.body === "string") body = req.body;
    else {
      body = JSON.stringify(req.body);
      if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) headers["content-type"] = "application/json";
    }
  }
  return { method: req.method, headers, body, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) };
}

export async function runHttpVector({ systemUrl, spec, timeoutMs = DEFAULT_TIMEOUT_MS, localPattern = DEFAULT_LOCAL_PATTERN, invariant = null }) {
  const broken = (reason) => ({ invariant, result: "INSTRUMENT-BROKEN", reason });
  if (!isLocalTarget(systemUrl, localPattern)) {
    return broken(`target is not local: ${systemUrl} — the autonomous breaker only drives local test/staging systems`);
  }
  const invalid = validateHttpSpec(spec, systemUrl);
  if (invalid) return broken(invalid);

  let last;
  for (const [i, req] of spec.requests.entries()) {
    try {
      const res = await fetch(new URL(req.path, systemUrl), requestInit(req, timeoutMs));
      last = { status: res.status, text: await res.text() };
    } catch (err) {
      const why = err && err.name === "TimeoutError" ? `timed out after ${timeoutMs} ms` : String(err && err.cause ? err.cause.message || err.cause : err);
      return broken(`requests[${i}] ${req.method} ${req.path} could not complete: ${why}`);
    }
  }
  const verdict = judge(spec.expect, last);
  return {
    invariant,
    ...verdict,
    expected: spec.expect ?? null,
    actual: { status: last.status, body: last.text.slice(0, 500) },
  };
}
