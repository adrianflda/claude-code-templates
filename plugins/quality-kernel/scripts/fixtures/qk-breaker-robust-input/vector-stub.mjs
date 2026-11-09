#!/usr/bin/env node
// Deterministic --breaker stub for specs/qk-breaker-robust-input/spec.md, QA procedure step 4-5.
// An ordinary external OS process (invoked only via `--breaker "node <this file>"`, exactly like
// production's breaker-claude.mjs) that happens to import vector-breaker.mjs's runVectors — the
// operator never imports runVectors into their own shell/REPL, only runs this file as a CLI.
//
// Reads the blind input JSON on stdin ({ qaProcedure, invariants, probeCmd, systemUrl }), runs a
// fixed 4-vector set anchored to THIS fixture's own declared ids (EO-0 used twice, EO-6 twice — the
// fixture only declares two ids, so each is reused by a different vector; any contract with at
// least one declared id works), where vector index 0 sets an out-of-registrable-domain Host header
// (dropped) and the rest are valid. Prints the JSON verdict to stdout, exactly like a real breaker.
import { runVectors } from "../../vector-breaker.mjs";

let s = "";
process.stdin.on("data", (d) => (s += d));
process.stdin.on("end", async () => {
  const blind = JSON.parse(s);
  const ids = (blind.invariants || []).map((i) => i.id);
  const id = ids[0] || "EO-0";
  const vectors = [
    { invariant: id, http: { requests: [{ method: "GET", path: "/", headers: { host: "evil.example.net" } }], expect: { status: 200 } } },
    { invariant: id, http: { requests: [{ method: "GET", path: "/" }], expect: { status: 200 } } },
    { invariant: id, http: { requests: [{ method: "GET", path: "/" }], expect: { status: 200 } } },
    { invariant: id, http: { requests: [{ method: "GET", path: "/" }], expect: { status: 200 } } },
  ];
  console.log(JSON.stringify(await runVectors({ vectors, blind })));
});
