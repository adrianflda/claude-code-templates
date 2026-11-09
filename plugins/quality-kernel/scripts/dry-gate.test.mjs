import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { findViolations, parseArgs, samePath, validateReport } from "./dry-gate.mjs";

const CLI = fileURLToPath(new URL("./dry-gate.mjs", import.meta.url));

function clone(a, b, extra = {}) {
  return {
    format: "javascript",
    lines: 12,
    tokens: 80,
    firstFile: { name: a, start: 1, end: 12 },
    secondFile: { name: b, start: 20, end: 31 },
    ...extra,
  };
}

function report(duplicates, percentage = 4.2) {
  return { statistics: { total: { percentage } }, duplicates };
}

function runCli(args, input) {
  const tmp = mkdtempSync(join(tmpdir(), "dry-gate-"));
  const file = join(tmp, "jscpd-report.json");
  writeFileSync(file, typeof input === "string" ? input : JSON.stringify(input));
  try {
    const out = execFileSync("node", [CLI, "--input", file, ...args], { encoding: "utf8" });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status, out: String(err.stdout ?? "") + String(err.stderr ?? "") };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

test("parseArgs: defaults and flags", () => {
  assert.deepEqual(parseArgs(["--input", "r.json"]), {
    input: "r.json",
    files: null,
    maxPercent: null,
    json: false,
  });
  assert.deepEqual(parseArgs(["--input", "r", "--files", "a.ts, b.ts,"]).files, ["a.ts", "b.ts"]);
  assert.equal(parseArgs(["--input", "r", "--max-percent", "3"]).maxPercent, 3);
});

test("samePath: equal, ./-prefixed, backslashes and path suffix all match", () => {
  assert.ok(samePath("src/a.ts", "src/a.ts"));
  assert.ok(samePath("./src/a.ts", "src/a.ts"));
  assert.ok(samePath("src\\a.ts", "src/a.ts"));
  assert.ok(samePath("/abs/repo/src/a.ts", "src/a.ts"));
  assert.ok(!samePath("src/a.ts", "src/b.ts"));
  assert.ok(!samePath("src/xa.ts", "a.ts")); // suffix must start at a path segment
});

test("validateReport: rejects shapes the gate does not recognize", () => {
  assert.equal(validateReport(report([clone("a", "b")])), null);
  assert.match(validateReport({}), /duplicates/);
  assert.match(validateReport({ duplicates: [{ firstFile: {} }] }), /duplicates\[0\]/);
});

test("findViolations: without --files every clone is a violation", () => {
  const v = findViolations(report([clone("src/a.ts", "src/b.ts"), clone("lib/x.ts", "lib/y.ts")]), null);
  assert.equal(v.length, 2);
  assert.equal(v[0].first, "src/a.ts:1-12");
  assert.equal(v[0].second, "src/b.ts:20-31");
});

test("findViolations: --files keeps only clones touching a touched file, on either side", () => {
  const r = report([clone("src/a.ts", "src/b.ts"), clone("lib/x.ts", "src/c.ts"), clone("lib/x.ts", "lib/y.ts")]);
  assert.deepEqual(findViolations(r, ["src/a.ts"]).map((c) => c.first), ["src/a.ts:1-12"]); // first side
  assert.deepEqual(findViolations(r, ["src/c.ts"]).map((c) => c.second), ["src/c.ts:20-31"]); // second side
  assert.equal(findViolations(r, ["src/b.ts", "src/c.ts"]).length, 2);
});

test("findViolations: falls back to startLoc/endLoc lines", () => {
  const d = clone("a.ts", "b.ts");
  d.firstFile = { name: "a.ts", startLoc: { line: 3 }, endLoc: { line: 9 } };
  assert.equal(findViolations(report([d]), null)[0].first, "a.ts:3-9");
});

test("CLI: no clones exits 0", () => {
  assert.equal(runCli([], report([])).code, 0);
});

test("CLI: a clone exits 1 and names both locations", () => {
  const { code, out } = runCli([], report([clone("src/a.ts", "src/b.ts")]));
  assert.equal(code, 1);
  assert.match(out, /src\/a\.ts:1-12 <-> src\/b\.ts:20-31/);
});

test("CLI: differential mode ignores clones outside --files", () => {
  assert.equal(runCli(["--files", "src/new.ts"], report([clone("lib/x.ts", "lib/y.ts")])).code, 0);
  assert.equal(runCli(["--files", "lib/y.ts"], report([clone("lib/x.ts", "lib/y.ts")])).code, 1);
});

test("CLI: --max-percent boundary — equal passes, above fails", () => {
  assert.equal(runCli(["--files", "z.ts", "--max-percent", "4.2"], report([], 4.2)).code, 0);
  assert.equal(runCli(["--files", "z.ts", "--max-percent", "4"], report([], 4.2)).code, 1);
});

test("CLI: --max-percent without statistics is indeterminate (exit 2), never a pass", () => {
  assert.equal(runCli(["--max-percent", "5"], { duplicates: [] }).code, 2);
});

test("CLI: unrecognized report, malformed JSON, empty --files and bad --max-percent exit 2", () => {
  assert.equal(runCli([], { clones: [] }).code, 2);
  assert.equal(runCli([], "{not json").code, 2);
  assert.equal(runCli(["--files", ","], report([])).code, 2);
  assert.equal(runCli(["--max-percent", "lots"], report([])).code, 2);
});

test("CLI: missing --input exits 2", () => {
  let code = 0;
  try {
    execFileSync("node", [CLI], { encoding: "utf8", stdio: "pipe" });
  } catch (err) {
    code = err.status;
  }
  assert.equal(code, 2);
});
