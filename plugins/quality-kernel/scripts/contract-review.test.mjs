import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { REVIEWERS, decide, parseFindings, renderReport, reviewContract } from "./contract-review.mjs";
import { PREAMBLE } from "./breaker-claude.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const CLI = join(HERE, "contract-review.mjs");
const PLUGIN = join(HERE, "..");

const finding = (severity, extra = {}) => ({ severity, where: "Acceptance criteria", finding: "x is undefined", ...extra });
const fenced = (value) => "Review follows.\n```json\n" + JSON.stringify(value) + "\n```\n";

test("REVIEWERS: comprehension and critic, each with a bundled prompt", () => {
  assert.deepEqual(REVIEWERS, ["comprehension", "critic"]);
  for (const r of REVIEWERS) assert.ok(existsSync(join(PLUGIN, "reviewers", `${r}.md`)), r);
});

test("parseFindings: one fenced json object with a findings array", () => {
  assert.deepEqual(parseFindings(fenced({ findings: [finding("major")] })), { findings: [finding("major")] });
  assert.deepEqual(parseFindings(JSON.stringify({ findings: [] })), { findings: [] });
  assert.deepEqual(parseFindings(fenced({ findings: [finding("nit", { suggestion: "define x" })] })).findings[0].suggestion, "define x");
});

test("parseFindings: anything else is an error, never an empty review", () => {
  for (const text of [
    "Looks good to me.",
    fenced({ findings: "none" }),
    fenced([finding("major")]),
    fenced({ findings: [finding("critical")] }),
    fenced({ findings: [finding("major", { where: "" })] }),
    fenced({ findings: [{ severity: "major", where: "a" }] }),
    fenced({ findings: [finding("major", { verdict: "approve" })] }),
    fenced({ findings: [], approved: true }),
  ]) {
    assert.ok(parseFindings(text).error, text.slice(0, 60));
  }
  assert.match(parseFindings(fenced({ findings: [] }) + fenced({ findings: [] })).error, /one json block/);
});

test("decide: any blocker blocks; any reviewer error is indeterminate", () => {
  const ok = (findings) => ({ reviewer: "critic", findings });
  assert.equal(decide([ok([finding("major"), finding("nit")])]).verdict, "PASS");
  assert.equal(decide([ok([finding("blocker")])]).verdict, "BLOCKED");
  assert.equal(decide([ok([]), { reviewer: "comprehension", error: "no JSON" }]).verdict, "INDETERMINATE");
  assert.deepEqual(decide([ok([finding("blocker"), finding("major"), finding("major")])]).counts, { blocker: 1, major: 2, nit: 0 });
});

test("renderReport: groups findings by severity and names each reviewer", () => {
  const md = renderReport("spec.md", [
    { reviewer: "comprehension", findings: [finding("nit", { where: "Definitions", finding: "term Y undefined" })] },
    { reviewer: "critic", findings: [finding("blocker", { where: "INV-2", finding: "no probe" })] },
  ]);
  assert.match(md, /BLOCKED/);
  assert.ok(md.indexOf("blocker") < md.indexOf("nit"));
  assert.match(md, /critic.*INV-2.*no probe/s);
  assert.match(md, /comprehension.*Definitions.*term Y undefined/s);
});

test("reviewContract: each reviewer gets only its prompt and the contract, isolated", async () => {
  const calls = [];
  const run = (args) => (calls.push(args), { status: 0, text: fenced({ findings: [] }), stderr: "" });
  const results = await reviewContract({ contractText: "## Acceptance criteria\nTHE SYSTEM SHALL x", run, model: "haiku" });
  assert.equal(calls.length, 2);
  assert.match(calls[0].systemPrompt, /comprehension/i);
  assert.match(calls[1].systemPrompt, /critic/i);
  for (const c of calls) {
    assert.ok(c.systemPrompt.startsWith(PREAMBLE), "hooks do not run in the isolated session: the preamble is added here");
    assert.match(c.prompt, /THE SYSTEM SHALL x/);
    assert.equal(c.model, "haiku");
  }
  assert.deepEqual(results.map((r) => r.reviewer), REVIEWERS);
});

test("reviewContract: a failed session or unparseable reply becomes that reviewer's error", async () => {
  const replies = [{ status: 2, text: "", stderr: "boom" }, { status: 0, text: "fine", stderr: "" }];
  const results = await reviewContract({ contractText: "c", run: () => replies.shift() });
  assert.match(results[0].error, /boom/);
  assert.match(results[1].error, /JSON/);
});

function withStub(reply, fn) {
  const dir = mkdtempSync(join(tmpdir(), "review-stub-"));
  const stub = join(dir, "claude");
  writeFileSync(stub, `#!/usr/bin/env node\nrequire("fs").readFileSync(0);\nprocess.stdout.write(JSON.stringify({ type: "result", is_error: false, result: ${JSON.stringify(reply)} }));\n`);
  chmodSync(stub, 0o755);
  try {
    return fn(stub, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const runCli = (args) => spawnSync("node", [CLI, ...args], { encoding: "utf8" });

test("CLI: blockers exit 1 and the report is written", () => {
  withStub(fenced({ findings: [finding("blocker", { where: "INV-1", finding: "no probe named" })] }), (stub, dir) => {
    const contract = join(dir, "c.md");
    const out = join(dir, "report.md");
    writeFileSync(contract, "## Invariants\n| INV-1 | x | |\n");
    const r = runCli(["--contract", contract, "--out", out, "--claude-bin", stub]);
    assert.equal(r.status, 1, r.stderr);
    assert.equal(JSON.parse(r.stdout.trim().split("\n").pop()).verdict, "BLOCKED");
    assert.match(readFileSync(out, "utf8"), /no probe named/);
  });
});

test("CLI: no blockers exit 0; an unparseable reviewer exits 2", () => {
  withStub(fenced({ findings: [finding("major")] }), (stub, dir) => {
    const contract = join(dir, "c.md");
    writeFileSync(contract, "# c\n");
    assert.equal(runCli(["--contract", contract, "--claude-bin", stub]).status, 0);
  });
  withStub("All clear!", (stub, dir) => {
    const contract = join(dir, "c.md");
    writeFileSync(contract, "# c\n");
    assert.equal(runCli(["--contract", contract, "--claude-bin", stub]).status, 2);
  });
});

test("CLI: a missing or empty contract exits 2", () => {
  withStub(fenced({ findings: [] }), (stub, dir) => {
    assert.equal(runCli(["--contract", join(dir, "nope.md"), "--claude-bin", stub]).status, 2);
    const empty = join(dir, "e.md");
    writeFileSync(empty, "  \n");
    assert.equal(runCli(["--contract", empty, "--claude-bin", stub]).status, 2);
    assert.equal(runCli(["--claude-bin", stub]).status, 2);
  });
});
