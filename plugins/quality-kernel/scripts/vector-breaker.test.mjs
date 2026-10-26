import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { runContractProbe, runVectors, validateVectors } from "./vector-breaker.mjs";

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

test("runVectors: an invalid vector set is INSTRUMENT-BROKEN before anything runs", async () => {
  let ran = false;
  const out = await runVectors({
    vectors: [httpVector("INV-1", 1), { ...httpVector("INV-1", 1), cmd: "x" }],
    blind: blind(),
    httpRunner: async () => ((ran = true), { result: "HOLDS" }),
  });
  assert.equal(out.verdict, "INSTRUMENT-BROKEN");
  assert.equal(ran, false);
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
