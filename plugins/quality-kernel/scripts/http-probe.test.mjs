import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { isAcceptableHost, jsonPointer, runHttpVector, validateHttpSpec } from "./http-probe.mjs";

// A real local system: an in-memory cart with an idempotency bug on POST /cart/items.
let server;
let base;
const seen = [];
before(async () => {
  let items = [];
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const json = (code, value) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (req.url === "/reset" && req.method === "POST") return (items = []), json(200, { ok: true });
      if (req.url === "/cart" && req.method === "GET") return json(200, { items, count: items.length });
      if (req.url === "/cart/items" && req.method === "POST") return items.push(JSON.parse(body)), json(201, { count: items.length });
      if (req.url === "/big") return json(200, { echo: body });
      if (req.url.startsWith("/login")) return json(200, { access_token: "t0k-resp", user: "ana", session: { refreshToken: "r3fresh" } });
      if (req.url === "/redirect") return res.writeHead(302, { location: "http://example.com/" }), res.end();
      if (req.url === "/text") return res.writeHead(200), res.end("plain");
      if (req.url === "/slow") return setTimeout(() => json(200, {}), 2000);
      json(404, { error: "not found" });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const spec = (requests, expect) => ({ requests, ...(expect ? { expect } : {}) });

test("jsonPointer: RFC 6901 paths, escapes and misses", () => {
  const doc = { a: { "b/c": [10, { "m~n": 2 }] } };
  assert.deepEqual(jsonPointer(doc, ""), { found: true, value: doc });
  assert.deepEqual(jsonPointer(doc, "/a/b~1c/0"), { found: true, value: 10 });
  assert.deepEqual(jsonPointer(doc, "/a/b~1c/1/m~0n"), { found: true, value: 2 });
  assert.equal(jsonPointer(doc, "/a/zz").found, false);
  assert.equal(jsonPointer(doc, "/a/b~1c/9").found, false);
  assert.equal(jsonPointer(doc, "a").found, false); // must start with /
});

test("validateHttpSpec: accepts a same-origin request sequence", () => {
  assert.equal(validateHttpSpec(spec([{ method: "POST", path: "/cart/items", headers: { "x-a": "1" }, body: { sku: "A" } }], { status: 201 }), base), null);
});

test("validateHttpSpec: refuses anything off the system's origin or outside the schema", () => {
  const bad = [
    spec([{ method: "GET", path: "http://example.com/" }]),
    spec([{ method: "GET", path: "//example.com/x" }]),
    spec([{ method: "GET", path: "/\\example.com/x" }]), // WHATWG URL reads "\" as "/" for http
    spec([{ method: "GET", path: "/\\\\example.com" }]),
    spec([{ method: "GET", path: "cart" }]),
    spec([{ method: "TRACE", path: "/" }]),
    // EARS-V6a: base's hostname (127.0.0.1) is an IP literal, so only an EXACT Host match is
    // accepted — "example.com" still fails, now because it doesn't match the literal, not because
    // every Host header is forbidden (that blanket rule is gone, see the EARS-V6/V6a tests below).
    spec([{ method: "GET", path: "/", headers: { host: "example.com" } }]),
    spec([{ method: "GET", path: "/", headers: { "x-a": 1 } }]),
    spec([{ method: "GET", path: "/", shell: "cat /etc/passwd" }]),
    { requests: [{ method: "GET", path: "/" }], run: "rm -rf /" },
    spec([]),
    spec(Array.from({ length: 21 }, () => ({ method: "GET", path: "/" }))),
    spec([{ method: "GET", path: "/" }], { status: "200" }),
    spec([{ method: "GET", path: "/" }], { json: [{ pointer: "/a" }] }),
    spec([{ method: "GET", path: "/" }], { body: "x" }),
    spec([{ method: "GET", path: "/" }], {}), // an expect that checks nothing
    spec([{ method: "GET", path: "//[" }]), // new URL() throws on this
    spec([{ method: "GET", path: "//a b" }]),
  ];
  for (const s of bad) assert.notEqual(validateHttpSpec(s, base), null, JSON.stringify(s));
});

// --- EARS-V6/V6a: a Host header is checked against the systemUrl, not blanket-rejected ---

test("isAcceptableHost (EARS-V6 branch a): exactly the systemUrl's own hostname is accepted", () => {
  assert.equal(isAcceptableHost("mbvs-server-development.example.com", "https://mbvs-server-development.example.com"), true);
});

test("isAcceptableHost (EARS-V6 branch b): a subdomain of the registrable domain is accepted, an unrelated suffix is not", () => {
  const url = "https://mbvs-server-development.example.com";
  assert.equal(isAcceptableHost("develop.mbvs-server-development.example.com", url), true);
  assert.equal(isAcceptableHost("mbvs-server-development.example.com.evil.net", url), false);
  assert.equal(isAcceptableHost("mbvs-server-development.example.com:443", url), true); // port stripped
});

test("isAcceptableHost (EARS-V6a): an IP-literal systemUrl needs an exact Host match, no suffix widening", () => {
  assert.equal(isAcceptableHost("127.0.0.1", "http://127.0.0.1:9"), true);
  assert.equal(isAcceptableHost("evil.0.1", "http://127.0.0.1:9"), false); // the naive last-two-labels bug
});

test("isAcceptableHost (EARS-V6a): an IPv6-bracketed systemUrl needs an exact Host match too", () => {
  assert.equal(isAcceptableHost("[::1]", "http://[::1]:9"), true);
  assert.equal(isAcceptableHost("evil.1]", "http://[::1]:9"), false);
});

test("isAcceptableHost (EARS-V6a): a single-label systemUrl ('localhost') needs an exact Host match too", () => {
  assert.equal(isAcceptableHost("localhost", "http://localhost:9"), true);
  assert.equal(isAcceptableHost("evil.localhost", "http://localhost:9"), false);
});

// --- RFC 9110 (review item C): the Host header is case-insensitive. The WHATWG URL parser always
// lowercases systemUrl's own .hostname, so a same-host value sent in a different case (a legitimate
// multi-tenant probe, e.g. "Host: EXAMPLE.COM") was being wrongly rejected by a case-sensitive ===. ---
test("isAcceptableHost (RFC 9110) — a Host value differing only in case from the systemUrl's own hostname is still accepted", () => {
  assert.equal(isAcceptableHost("EXAMPLE.COM", "http://example.com"), true);
});

test("isAcceptableHost (RFC 9110) — a Host value differing only in case, on the registrable-domain-suffix branch, is still accepted", () => {
  assert.equal(isAcceptableHost("Develop.MBVS-Server-Development.Example.COM", "https://mbvs-server-development.example.com"), true);
});

test("validateHttpSpec (EARS-V6): an accepted Host header no longer makes the request invalid", () => {
  assert.equal(validateHttpSpec(spec([{ method: "GET", path: "/", headers: { host: "127.0.0.1" } }]), base), null);
});

// --- EARS-V4 step (3) sub-order (carried major #2, design.md): shape/method/path checks run
// before the Host loop — a vector failing BOTH wins on the method, pinning the order the code
// already has (http-probe.mjs's method check precedes its headers loop). ---
test("validateHttpSpec (EARS-V4 step 3 sub-order): an unknown method wins over a bad Host header", () => {
  const reason = validateHttpSpec(spec([{ method: "TRACE", path: "/", headers: { host: "evil.net" } }]), base);
  assert.match(reason, /method/i);
  assert.doesNotMatch(reason, /host/i);
});

test("runHttpVector: HOLDS when the last response meets the expectation", async () => {
  const r = await runHttpVector({
    systemUrl: base,
    spec: spec([{ method: "POST", path: "/reset" }, { method: "POST", path: "/cart/items", body: { sku: "A" } }, { method: "GET", path: "/cart" }], {
      status: 200,
      json: [{ pointer: "/count", equals: 1 }, { pointer: "/items/0", equals: { sku: "A" } }],
    }),
  });
  assert.equal(r.result, "HOLDS", r.reason);
});

test("runHttpVector: VIOLATED when the system breaks the expectation (repeat-add bug)", async () => {
  const r = await runHttpVector({
    systemUrl: base,
    spec: spec(
      [{ method: "POST", path: "/reset" }, { method: "POST", path: "/cart/items", body: { sku: "A" } }, { method: "POST", path: "/cart/items", body: { sku: "A" } }, { method: "GET", path: "/cart" }],
      { json: [{ pointer: "/count", equals: 1 }] },
    ),
  });
  assert.equal(r.result, "VIOLATED");
  assert.match(r.reason, /\/count/);
});

test("runHttpVector: status mismatch, non-JSON body and missing pointer are VIOLATED", async () => {
  const one = (path, expect) => runHttpVector({ systemUrl: base, spec: spec([{ method: "GET", path }], expect) });
  assert.equal((await one("/nope", { status: 200 })).result, "VIOLATED");
  assert.equal((await one("/text", { json: [{ pointer: "/a", equals: 1 }] })).result, "VIOLATED");
  assert.equal((await one("/cart", { json: [{ pointer: "/missing", equals: 1 }] })).result, "VIOLATED");
});

test("runHttpVector: sends method, headers and a JSON body", async () => {
  seen.length = 0;
  await runHttpVector({ systemUrl: base, spec: spec([{ method: "PUT", path: "/echo?q=1", headers: { "x-test": "yes" }, body: { a: 1 } }]) });
  assert.equal(seen[0].method, "PUT");
  assert.equal(seen[0].url, "/echo?q=1");
  assert.equal(seen[0].headers["x-test"], "yes");
  assert.equal(seen[0].headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(seen[0].body), { a: 1 });
});

test("runHttpVector: never follows a redirect off the system", async () => {
  const r = await runHttpVector({ systemUrl: base, spec: spec([{ method: "GET", path: "/redirect" }], { status: 302 }) });
  assert.equal(r.result, "HOLDS"); // the 302 itself is observed; example.com is never requested
});

test("runHttpVector: honours a configured local pattern", async () => {
  const ok = spec([{ method: "GET", path: "/cart" }], { status: 200 });
  assert.equal((await runHttpVector({ systemUrl: base, spec: ok, localPattern: "^nothing-matches$" })).result, "INSTRUMENT-BROKEN");
});

test("runHttpVector: INSTRUMENT-BROKEN for a non-local system, an invalid spec, a dead port or a timeout", async () => {
  const ok = spec([{ method: "GET", path: "/cart" }], { status: 200 });
  assert.equal((await runHttpVector({ systemUrl: "https://example.com", spec: ok })).result, "INSTRUMENT-BROKEN");
  assert.equal((await runHttpVector({ systemUrl: "http://localhost.attacker.com", spec: ok })).result, "INSTRUMENT-BROKEN");
  assert.equal((await runHttpVector({ systemUrl: base, spec: { requests: "GET /" } })).result, "INSTRUMENT-BROKEN");
  assert.equal((await runHttpVector({ systemUrl: "http://127.0.0.1:1", spec: ok })).result, "INSTRUMENT-BROKEN");
  const slow = await runHttpVector({ systemUrl: base, spec: spec([{ method: "GET", path: "/slow" }], { status: 200 }), timeoutMs: 200 });
  assert.equal(slow.result, "INSTRUMENT-BROKEN");
  assert.match(slow.reason, /timed out|abort/i);
});

// --- Step log: the exact requests the breaker authored and ran, so a VIOLATED vector can be replayed. ---
test("runHttpVector: records every step in order with method, url, headers, body and the response", async () => {
  const r = await runHttpVector({
    systemUrl: base,
    spec: spec([{ method: "POST", path: "/reset" }, { method: "POST", path: "/cart/items", headers: { "x-test": "yes" }, body: { sku: "A" } }, { method: "GET", path: "/cart" }], { json: [{ pointer: "/count", equals: 1 }] }),
  });
  assert.equal(r.result, "HOLDS");
  assert.deepEqual(r.steps.map((s) => `${s.method} ${s.url}`), [`POST ${base}/reset`, `POST ${base}/cart/items`, `GET ${base}/cart`]);
  assert.deepEqual(r.steps.map((s) => s.response.status), [200, 201, 200]);
  assert.equal(r.steps[1].request.headers["x-test"], "yes");
  assert.equal(r.steps[1].request.headers["content-type"], "application/json");
  assert.equal(r.steps[1].request.body, JSON.stringify({ sku: "A" }));
  assert.deepEqual(JSON.parse(r.steps[2].response.body), { items: [{ sku: "A" }], count: 1 });
});

test("runHttpVector: a VIOLATED vector keeps its full ordered step log", async () => {
  const r = await runHttpVector({
    systemUrl: base,
    spec: spec([{ method: "POST", path: "/reset" }, { method: "POST", path: "/cart/items", body: { sku: "A" } }, { method: "POST", path: "/cart/items", body: { sku: "A" } }, { method: "GET", path: "/cart" }], { json: [{ pointer: "/count", equals: 1 }] }),
  });
  assert.equal(r.result, "VIOLATED");
  assert.equal(r.steps.length, 4);
  assert.equal(JSON.parse(r.steps[3].response.body).count, 2);
});

test("runHttpVector: secret-looking header values are redacted in the log, not on the wire", async () => {
  seen.length = 0;
  const headers = { Authorization: "Bearer s3cret", "X-Api-Key": "k-123", Cookie: "sid=abc", "X-Auth-Token": "t", "x-csrf-token": "c", "x-secret": "s", "x-test": "visible" };
  const r = await runHttpVector({ systemUrl: base, spec: spec([{ method: "GET", path: "/cart", headers }]) });
  const logged = r.steps[0].request.headers;
  for (const k of ["Authorization", "X-Api-Key", "Cookie", "X-Auth-Token", "x-csrf-token", "x-secret"]) assert.equal(logged[k], "[redacted]", k);
  assert.equal(logged["x-test"], "visible");
  assert.equal(seen[0].headers.authorization, "Bearer s3cret"); // the real request is untouched
  assert.doesNotMatch(JSON.stringify(r.steps), /s3cret|k-123|sid=abc/);
});

test("runHttpVector: secret-looking query parameters and JSON body fields are hidden in the log, not on the wire", async () => {
  seen.length = 0;
  const r = await runHttpVector({ systemUrl: base, spec: spec([{ method: "POST", path: "/login?api_key=k-999&page=2", body: { user: "ana", password: "hunter2", nested: [{ clientSecret: "s3cr3t" }] } }]) });
  const step = r.steps[0];
  assert.equal(new URL(step.url).searchParams.get("api_key"), "[redacted]");
  assert.equal(new URL(step.url).searchParams.get("page"), "2");
  assert.deepEqual(JSON.parse(step.request.body), { user: "ana", password: "[redacted]", nested: [{ clientSecret: "[redacted]" }] });
  assert.deepEqual(JSON.parse(step.response.body), { access_token: "[redacted]", user: "ana", session: { refreshToken: "[redacted]" } });
  assert.doesNotMatch(JSON.stringify(r.steps), /k-999|hunter2|s3cr3t|t0k-resp|r3fresh/);
  assert.match(seen[0].url, /api_key=k-999/); // the real request is untouched
});

test("runHttpVector: a body without a secret-looking field is logged byte for byte", async () => {
  const r = await runHttpVector({ systemUrl: base, spec: spec([{ method: "POST", path: "/reset" }, { method: "GET", path: "/cart" }]) });
  assert.equal(r.steps[1].response.body, JSON.stringify({ items: [], count: 0 }));
});

test("runHttpVector: request and response bodies over 4 KB are truncated with a marker", async () => {
  const big = "x".repeat(5000);
  const r = await runHttpVector({ systemUrl: base, spec: spec([{ method: "POST", path: "/big", body: big }]) });
  const { request, response } = r.steps[0];
  assert.ok(request.body.startsWith("x".repeat(4096)));
  // A string body goes out as it is (5000 chars); the server echoes it inside {"echo":"…"}.
  assert.equal(request.body.slice(4096), "…[truncated, 904 more chars]");
  assert.equal(response.body.slice(4096), "…[truncated, 915 more chars]");
  // A logged body of exactly 4096 chars is kept whole.
  const exact = await runHttpVector({ systemUrl: base, spec: spec([{ method: "POST", path: "/big", body: "x".repeat(4096) }]) });
  assert.equal(exact.steps[0].request.body, "x".repeat(4096));
  const small = await runHttpVector({ systemUrl: base, spec: spec([{ method: "GET", path: "/text" }]) });
  assert.equal(small.steps[0].response.body, "plain");
  assert.equal(small.steps[0].request.body, undefined);
});

test("runHttpVector: keeps the steps that ran when a later request cannot complete; existing fields unchanged", async () => {
  const r = await runHttpVector({ systemUrl: base, timeoutMs: 100, spec: spec([{ method: "GET", path: "/cart" }, { method: "GET", path: "/slow" }]) });
  assert.equal(r.result, "INSTRUMENT-BROKEN");
  assert.equal(r.steps.length, 1);
  const ok = await runHttpVector({ systemUrl: base, spec: spec([{ method: "GET", path: "/text" }], { status: 200 }) });
  assert.deepEqual(ok.actual, { status: 200, body: "plain" });
  assert.deepEqual(ok.expected, { status: 200 });
});
