import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { runContractProbe, runVectors, validateBatch, validateVector, validateVectors } from "./vector-breaker.mjs";

let server;
let base;
let count = 0;
before(async () => {
  server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/inc") count += 1;
    if (req.method === "POST" && req.url === "/reset") count = 0;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ count }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const invariants = [{ id: "INV-1", expected: "" }, { id: "INV-2", expected: "" }];
const blind = (extra = {}) => ({ qaProcedure: "", invariants, probeCmd: null, systemUrl: base, ...extra });
const httpVector = (invariant, count, path = "/inc") => ({
  invariant,
  http: { requests: [{ method: "POST", path: "/reset" }, { method: "POST", path }], expect: { json: [{ pointer: "/count", equals: count }] } },
});
const uiVector = (invariant, steps = [], assertCmd = "text") => ({
  invariant,
  ui: { expected: "1", assert: { mode: "text", cmd: assertCmd, args: ["#count"] }, steps },
});

test("validateVectors: accepts anchored HTTP and UI vectors", () => {
  assert.deepEqual(validateVectors([httpVector("INV-1", 1), uiVector("INV-2", [{ cmd: "click", args: ["#add"] }, { cmd: "goto", args: ["/cart"] }])], blind()), []);
});

test("validateVectors: refuses unanchored, unknown-keyed, mixed or oversized vector sets", () => {
  const cases = [
    [],
    "not an array",
    [httpVector("INV-9", 1)],
    [{ ...httpVector("INV-1", 1), shell: "cat src/x.js" }],
    [{ ...httpVector("INV-1", 1), ui: uiVector("INV-1").ui }],
    [{ invariant: "INV-1" }],
    Array.from({ length: 31 }, () => httpVector("INV-1", 1)),
  ];
  for (const v of cases) assert.notDeepEqual(validateVectors(v, blind()), [], JSON.stringify(v).slice(0, 80));
});

test("validateVectors: UI steps are allowlisted and stay on the system's origin", () => {
  for (const steps of [
    [{ cmd: "goto", args: ["file:///etc/passwd"] }],
    [{ cmd: "goto", args: ["http://example.com/"] }],
    [{ cmd: "eval", args: ["fetch('/')"] }],
    [{ cmd: "click", args: [1] }],
  ]) {
    assert.notDeepEqual(validateVectors([uiVector("INV-1", steps)], blind()), [], JSON.stringify(steps));
  }
  assert.notDeepEqual(validateVectors([uiVector("INV-1", [], "html")], blind()), []);
  assert.notDeepEqual(validateVectors([uiVector("INV-1", { cmd: "click" })], blind()), []); // steps not an array
});

test("validateVectors: an unparseable system URL is a validation error, not a crash", () => {
  assert.notDeepEqual(validateVectors([uiVector("INV-1", [{ cmd: "goto", args: ["/x"] }])], blind({ systemUrl: "not a url" })), []);
  assert.notDeepEqual(validateVectors([uiVector("INV-1")], blind({ systemUrl: null })), []);
});

test("validateVectors: an HTTP vector must assert something when there is no contract probe", () => {
  const silent = { invariant: "INV-1", http: { requests: [{ method: "POST", path: "/inc" }] } };
  assert.notDeepEqual(validateVectors([silent], blind()), []);
  assert.deepEqual(validateVectors([silent], blind({ probeCmd: "true" })), []);
});

test("runVectors: HTTP vectors get the configured local pattern", async () => {
  const calls = [];
  const httpRunner = async (args) => (calls.push(args), { result: "HOLDS" });
  const config = { browserEngine: { testUrlPattern: "^staging\\.test$" } };
  await runVectors({ vectors: [httpVector("INV-1", 1), httpVector("INV-2", 1), httpVector("INV-1", 1)], blind: blind(), httpRunner, config });
  assert.equal(calls[0].localPattern, "^staging\\.test$");
  await runVectors({ vectors: [httpVector("INV-1", 1), httpVector("INV-2", 1), httpVector("INV-1", 1)], blind: blind(), httpRunner: async (a) => (calls.push(a), { result: "HOLDS" }) });
  assert.equal(calls.at(-1).localPattern, undefined); // no config: the instrument's default applies
});

test("runContractProbe: exit 0 holds, other exits violate, missing command or timeout is broken", () => {
  assert.equal(runContractProbe("true").result, "HOLDS");
  assert.equal(runContractProbe("exit 1").result, "VIOLATED");
  assert.equal(runContractProbe("exit 3").result, "VIOLATED");
  assert.equal(runContractProbe("qk-no-such-command-xyz").result, "INSTRUMENT-BROKEN"); // 127
  assert.equal(runContractProbe("sleep 5", { timeoutMs: 200 }).result, "INSTRUMENT-BROKEN");
});

test("runVectors: BREAKER_PASS needs at least 3 vectors that all hold", async () => {
  const three = [httpVector("INV-1", 1), httpVector("INV-2", 1), httpVector("INV-1", 1)];
  assert.equal((await runVectors({ vectors: three, blind: blind() })).verdict, "BREAKER_PASS");
  assert.equal((await runVectors({ vectors: three.slice(0, 2), blind: blind() })).verdict, "BREAKER_INDETERMINATE");
});

test("runVectors: one violated vector fails the run", async () => {
  const out = await runVectors({ vectors: [httpVector("INV-1", 1), httpVector("INV-2", 2), httpVector("INV-1", 1)], blind: blind() });
  assert.equal(out.verdict, "BREAKER_FAIL");
  assert.deepEqual(out.vectors.map((v) => v.result), ["HOLDS", "VIOLATED", "HOLDS"]);
});

test("runVectors: the contract probe runs after every vector and can violate it", async () => {
  const three = [httpVector("INV-1", 1), httpVector("INV-2", 1), httpVector("INV-1", 1)];
  assert.equal((await runVectors({ vectors: three, blind: blind({ probeCmd: "true" }) })).verdict, "BREAKER_PASS");
  assert.equal((await runVectors({ vectors: three, blind: blind({ probeCmd: "false" }) })).verdict, "BREAKER_FAIL");
  assert.equal((await runVectors({ vectors: three, blind: blind({ probeCmd: "qk-no-such-command-xyz" }) })).verdict, "INSTRUMENT-BROKEN");
});

// Retargeted by EARS-V3 (spec: specs/qk-breaker-robust-input/spec.md): a per-vector-shaped problem
// (here, an unknown `cmd` key) used to make the WHOLE batch INSTRUMENT-BROKEN before anything ran.
// Per EARS-V3/V4 it now excludes only that one vector — the valid vector still runs — and is
// reported in `dropped`; with only 1 executed result (below MIN_VECTORS) the verdict is
// BREAKER_INDETERMINATE, not INSTRUMENT-BROKEN. The genuine "nothing runs" guarantee for an
// actual batch-level problem is covered separately (see "runVectors (EARS-V2)" below).
test("runVectors (EARS-V3): a per-vector-invalid vector is dropped, not batch-fatal — the valid one still runs", async () => {
  let ran = false;
  const out = await runVectors({
    vectors: [httpVector("INV-1", 1), { ...httpVector("INV-1", 1), cmd: "x" }],
    blind: blind(),
    httpRunner: async () => ((ran = true), { result: "HOLDS" }),
  });
  assert.equal(out.verdict, "BREAKER_INDETERMINATE");
  assert.equal(out.executed, 1);
  assert.equal(out.dropped.length, 1);
  assert.equal(out.dropped[0].index, 1);
  assert.match(out.dropped[0].reason, /unknown key/i);
  assert.equal(ran, true);
});

test("runVectors: UI vectors go to the UI instrument with the system URL", async () => {
  const calls = [];
  const uiRunner = (args) => (calls.push(args), { result: "HOLDS" });
  const out = await runVectors({ vectors: [uiVector("INV-1"), uiVector("INV-2"), uiVector("INV-1")], blind: blind(), uiRunner, config: { k: 1 } });
  assert.equal(out.verdict, "BREAKER_PASS");
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, base);
  assert.equal(calls[0].invariant, "INV-1");
  assert.deepEqual(calls[0].config, { k: 1 });
  assert.equal(calls[0].spec.assert.cmd, "text");
});

// --- EARS-V1-V5: per-vector problems drop only that vector and report it in `dropped`;
// batch-level problems still reject the whole run; excluding every vector still forces
// INSTRUMENT-BROKEN via EARS-V9's zero-executed rule (D1). The systemUrl below is deliberately
// not local: the Host/origin scenarios are about the VALIDATION layer, so httpRunner/uiRunner are
// stubbed and never touch the network or the isLocalTarget gate. ---

const remoteBlind = (extra = {}) => ({
  qaProcedure: "", invariants: [{ id: "EO-0", expected: "" }], probeCmd: null,
  systemUrl: "https://mbvs-server-development.example.com", ...extra,
});
const okHttpRunner = async ({ invariant }) => ({ invariant, result: "HOLDS" });
const anchoredHttp = (invariant = "EO-0") => ({ invariant, http: { requests: [{ method: "GET", path: "/" }], expect: { status: 200 } } });

test("validateBatch: batch-level-only rules (EARS-V1)", () => {
  assert.equal(validateBatch([], blind()), "vectors must be a non-empty array");
  assert.ok(validateBatch("not an array", blind()));
  assert.ok(validateBatch(Array.from({ length: 31 }, () => anchoredHttp()), blind()));
  assert.equal(validateBatch([anchoredHttp()], blind()), null);
  assert.ok(validateBatch([anchoredHttp()], blind({ systemUrl: "not a url" })));
});

test("validateVector: per-vector rules only, in the EARS-V4 fixed order", () => {
  assert.equal(validateVector(anchoredHttp(), remoteBlind()), null);
  assert.match(validateVector({ invariant: "EO-0" }, remoteBlind()), /http or ui/);
  assert.match(validateVector({ invariant: "EO-UNDECLARED", http: anchoredHttp().http }, remoteBlind()), /anchored/);
});

test("runVectors (EARS-V3): one per-vector-invalid vector is dropped and reported, the rest still run", async () => {
  const cases = [
    [{ invariant: "EO-0", http: { requests: [{ method: "GET", path: "/", headers: { host: "evil.example.net" } }], expect: { status: 200 } } }, "host"],
    [{ invariant: "EO-0", ui: { expected: "x", assert: { mode: "text", cmd: "text", args: ["#x"] }, steps: [{ cmd: "goto", args: ["http://other.example.com"] }] } }, "origin"],
    [{ invariant: "EO-UNDECLARED", http: anchoredHttp().http }, "anchored"],
  ];
  for (const [bad, reasonSubstring] of cases) {
    const vectors = [anchoredHttp(), anchoredHttp(), bad, anchoredHttp()];
    const out = await runVectors({ vectors, blind: remoteBlind(), httpRunner: okHttpRunner, uiRunner: () => ({ result: "HOLDS" }) });
    assert.equal(out.executed, 3, JSON.stringify(out));
    assert.equal(out.dropped.length, 1);
    assert.equal(out.dropped[0].index, 2);
    assert.match(out.dropped[0].reason, new RegExp(reasonSubstring, "i"));
    assert.equal(out.verdict, "BREAKER_PASS");
  }
});

test("runVectors (EARS-V5/V9, D1): every vector per-vector-invalid drives executed to 0 — INSTRUMENT-BROKEN", async () => {
  const bad = { invariant: "EO-0", http: { requests: [{ method: "GET", path: "/", headers: { host: "evil.example.net" } }], expect: { status: 200 } } };
  const out = await runVectors({ vectors: [bad, bad, bad, bad], blind: remoteBlind(), httpRunner: okHttpRunner });
  assert.equal(out.executed, 0);
  assert.equal(out.dropped.length, 4);
  for (const d of out.dropped) assert.match(d.reason, /host/i);
  assert.equal(out.verdict, "INSTRUMENT-BROKEN");
});

test("runVectors (EARS-V6): a Host header matching the system's registrable domain is accepted, not dropped", async () => {
  const vectors = [
    { invariant: "EO-0", http: { requests: [{ method: "GET", path: "/", headers: { host: "develop.mbvs-server-development.example.com" } }], expect: { status: 200 } } },
    anchoredHttp(), anchoredHttp(),
  ];
  const out = await runVectors({ vectors, blind: remoteBlind(), httpRunner: okHttpRunner });
  assert.equal(out.executed, 3);
  assert.deepEqual(out.dropped, []);
  assert.equal(out.verdict, "BREAKER_PASS");
});

test("runVectors (EARS-V6): a Host header outside the registrable domain is dropped, not batch-fatal", async () => {
  const vectors = [
    { invariant: "EO-0", http: { requests: [{ method: "GET", path: "/", headers: { host: "mbvs-server-development.example.com.evil.net" } }], expect: { status: 200 } } },
    anchoredHttp(), anchoredHttp(), anchoredHttp(),
  ];
  const out = await runVectors({ vectors, blind: remoteBlind(), httpRunner: okHttpRunner });
  assert.equal(out.executed, 3);
  assert.equal(out.dropped.length, 1);
  assert.equal(out.dropped[0].index, 0);
  assert.match(out.dropped[0].reason, /host/i);
  assert.equal(out.verdict, "BREAKER_PASS");
});

test("runVectors (EARS-V6a): an IP-literal systemUrl requires an exact Host match", async () => {
  const vectors = [
    { invariant: "EO-0", http: { requests: [{ method: "GET", path: "/", headers: { host: "evil.0.1" } }], expect: { status: 200 } } },
    anchoredHttp(), anchoredHttp(), anchoredHttp(),
  ];
  const out = await runVectors({ vectors, blind: remoteBlind({ systemUrl: "http://127.0.0.1:9" }), httpRunner: okHttpRunner });
  assert.equal(out.dropped.length, 1);
  assert.equal(out.dropped[0].index, 0);
  assert.match(out.dropped[0].reason, /host/i);
  assert.equal(out.verdict, "BREAKER_PASS");
});

test("runVectors (EARS-V6a): a single-label systemUrl ('localhost') requires an exact Host match too", async () => {
  const vectors = [
    { invariant: "EO-0", http: { requests: [{ method: "GET", path: "/", headers: { host: "evil.localhost" } }], expect: { status: 200 } } },
    anchoredHttp(), anchoredHttp(), anchoredHttp(),
  ];
  const out = await runVectors({ vectors, blind: remoteBlind({ systemUrl: "http://localhost:9" }), httpRunner: okHttpRunner });
  assert.equal(out.dropped.length, 1);
  assert.equal(out.dropped[0].index, 0);
  assert.match(out.dropped[0].reason, /host/i);
});

test("runVectors (EARS-V2): a batch-level problem still rejects the whole run", async () => {
  let ran = false;
  const vectors = Array.from({ length: 31 }, () => anchoredHttp());
  const out = await runVectors({ vectors, blind: remoteBlind(), httpRunner: async (a) => ((ran = true), okHttpRunner(a)) });
  assert.equal(out.verdict, "INSTRUMENT-BROKEN");
  assert.equal(out.executed, 0);
  assert.equal(ran, false);
});

// EARS-V4 step (4) plumbing (carried major #3, design.md): an HTTP vector with no expect and a
// falsy blind.probeCmd is dropped per-vector, naming "expect"; the rest still run.
test("runVectors (EARS-V4 step 4): a silent HTTP vector with no contract probe is dropped, not batch-fatal", async () => {
  const silent = { invariant: "EO-0", http: { requests: [{ method: "GET", path: "/" }] } };
  const vectors = [silent, anchoredHttp(), anchoredHttp(), anchoredHttp()];
  const out = await runVectors({ vectors, blind: remoteBlind(), httpRunner: okHttpRunner });
  assert.equal(out.executed, 3);
  assert.equal(out.dropped.length, 1);
  assert.equal(out.dropped[0].index, 0);
  assert.match(out.dropped[0].reason, /expect/i);
  assert.equal(out.verdict, "BREAKER_PASS");
});
