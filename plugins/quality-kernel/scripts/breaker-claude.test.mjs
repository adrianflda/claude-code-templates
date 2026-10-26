import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BREAKER_TOOLS,
  PREAMBLE,
  buildClaudeArgs,
  isolatedEnv,
  parseVerdict,
  promptBody,
  validateBlindInput,
} from "./breaker-claude.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ADAPTER = join(HERE, "breaker-claude.mjs");
const INVOKER = join(HERE, "breaker-invoke.mjs");
const PLUGIN = join(HERE, "..");
const BUNDLED_PROMPT = join(PLUGIN, "breaker", "pipeline-breaker.md");
const SOURCE_PROMPT = join(PLUGIN, "..", "..", "cli-tool", "components", "agents", "epistemic-discipline", "pipeline-breaker.md");

const BLIND = { qaProcedure: "1. Open /cart", invariants: [{ id: "INV-1", expected: "1" }], probeCmd: "npm run probe", systemUrl: "http://localhost:3000" };

const flagValue = (args, flag) => args[args.indexOf(flag) + 1];

test("buildClaudeArgs: every isolation flag is present", () => {
  const args = buildClaudeArgs({ model: "opus", systemPrompt: "SYS" });
  for (const flag of ["-p", "--safe-mode", "--restricted", "--strict-mcp-config", "--no-session-persistence", "--exclude-dynamic-system-prompt-sections"]) {
    assert.ok(args.includes(flag), `missing ${flag}`);
  }
  assert.equal(flagValue(args, "--mcp-config"), '{"mcpServers":{}}');
  assert.equal(flagValue(args, "--tools"), BREAKER_TOOLS.join(","));
  assert.equal(flagValue(args, "--allowedTools"), BREAKER_TOOLS.join(","));
  assert.equal(flagValue(args, "--output-format"), "json");
  assert.equal(flagValue(args, "--model"), "opus");
  assert.equal(flagValue(args, "--append-system-prompt"), "SYS");
});

test("buildClaudeArgs: tools are exactly Bash, Read, Glob, Grep and nothing bypasses permissions", () => {
  assert.deepEqual([...BREAKER_TOOLS].sort(), ["Bash", "Glob", "Grep", "Read"]);
  const args = buildClaudeArgs({ model: "opus", systemPrompt: "SYS" }).join(" ");
  assert.doesNotMatch(args, /dangerously|bypassPermissions|--resume|--continue|--add-dir|--plugin-dir|--agents?\b/);
});

test("isolatedEnv: keeps auth and PATH, drops everything else", () => {
  const env = isolatedEnv({
    PATH: "/bin",
    HOME: "/home/u",
    ANTHROPIC_API_KEY: "k",
    CLAUDE_CONFIG_DIR: "/cfg",
    CLAUDE_CODE_USE_BEDROCK: "1",
    AWS_REGION: "us-east-1",
    QK_RUN_ID: "leak",
    CLAUDECODE: "1",
    CLAUDE_PLUGIN_ROOT: "/plugin",
    CLAUDE_CODE_SESSION_ID: "parent",
    GIT_DIR: "/repo/.git",
    SECRET_DIFF_PATH: "/repo/diff",
  });
  assert.deepEqual(Object.keys(env).sort(), [
    "ANTHROPIC_API_KEY",
    "AWS_REGION",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CONFIG_DIR",
    "HOME",
    "PATH",
  ]);
});

test("isolatedEnv: cloud credentials pass only for the provider that is switched on", () => {
  const cloud = {
    PATH: "/bin",
    AWS_ACCESS_KEY_ID: "a",
    AWS_SECRET_ACCESS_KEY: "s",
    GOOGLE_APPLICATION_CREDENTIALS: "/g.json",
    CLOUD_ML_REGION: "us-east5",
  };
  assert.deepEqual(Object.keys(isolatedEnv(cloud)), ["PATH"]); // no provider on: no cloud secrets
  assert.deepEqual(Object.keys(isolatedEnv({ ...cloud, CLAUDE_CODE_USE_BEDROCK: "1" })).sort(), [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "CLAUDE_CODE_USE_BEDROCK",
    "PATH",
  ]);
  assert.deepEqual(Object.keys(isolatedEnv({ ...cloud, CLAUDE_CODE_USE_VERTEX: "1" })).sort(), [
    "CLAUDE_CODE_USE_VERTEX",
    "CLOUD_ML_REGION",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "PATH",
  ]);
  assert.deepEqual(Object.keys(isolatedEnv({ ...cloud, CLAUDE_CODE_USE_BEDROCK: "0" })).sort(), ["CLAUDE_CODE_USE_BEDROCK", "PATH"]);
});

test("validateBlindInput: only the four blind keys are accepted", () => {
  assert.equal(validateBlindInput(BLIND), null);
  assert.equal(validateBlindInput({ qaProcedure: "x" }), null);
  assert.match(validateBlindInput({ ...BLIND, diff: "+code" }), /diff/);
  assert.match(validateBlindInput([]), /object/);
  assert.match(validateBlindInput(null), /object/);
});

test("parseVerdict: reads the typed verdict and the protocol flag", () => {
  assert.deepEqual(parseVerdict("BREAKER VERDICT: BREAKER_PASS\nPROTOCOL_VIOLATION: no\nVECTORS: ..."), {
    verdict: "BREAKER_PASS",
    protocolViolation: false,
  });
  assert.equal(parseVerdict("BREAKER VERDICT: BREAKER_FAIL\nPROTOCOL_VIOLATION: no").verdict, "BREAKER_FAIL");
  assert.equal(parseVerdict("**BREAKER VERDICT:** INSTRUMENT-BROKEN\nPROTOCOL_VIOLATION: no").verdict, "INSTRUMENT-BROKEN");
});

test("parseVerdict: anything ambiguous is BREAKER_INDETERMINATE", () => {
  const indeterminate = (text) => parseVerdict(text).verdict;
  assert.equal(indeterminate("looks fine to me"), "BREAKER_INDETERMINATE");
  assert.equal(indeterminate("BREAKER VERDICT: BREAKER_PASS"), "BREAKER_INDETERMINATE"); // no protocol line
  assert.equal(indeterminate("BREAKER VERDICT: MAYBE\nPROTOCOL_VIOLATION: no"), "BREAKER_INDETERMINATE");
  assert.equal(
    indeterminate("BREAKER VERDICT: BREAKER_PASS\nBREAKER VERDICT: BREAKER_FAIL\nPROTOCOL_VIOLATION: no"),
    "BREAKER_INDETERMINATE",
  );
});

test("parseVerdict: a PASS that reports a protocol violation is not trusted", () => {
  const v = parseVerdict("BREAKER VERDICT: BREAKER_PASS\nPROTOCOL_VIOLATION: yes (diff in prompt)");
  assert.deepEqual(v, { verdict: "BREAKER_INDETERMINATE", protocolViolation: true });
  assert.equal(parseVerdict("BREAKER VERDICT: BREAKER_FAIL\nPROTOCOL_VIOLATION: yes").verdict, "BREAKER_FAIL");
});

test("PREAMBLE matches the epistemic-guard hook's PREAMBLE", () => {
  const hook = join(PLUGIN, "hooks", "epistemic-guard.py");
  const code = "import importlib.util,sys;s=importlib.util.spec_from_file_location('g',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);print(m.PREAMBLE,end='')";
  assert.equal(execFileSync("python3", ["-c", code, hook], { encoding: "utf8" }), PREAMBLE);
});

test("bundled breaker prompt: frontmatter stripped, body in sync with the catalog agent", { skip: !existsSync(SOURCE_PROMPT) && "catalog copy not present" }, () => {
  const bundled = promptBody(readFileSync(BUNDLED_PROMPT, "utf8"));
  assert.doesNotMatch(bundled, /^---/);
  assert.match(bundled, /BREAKER VERDICT/);
  assert.equal(bundled, promptBody(readFileSync(SOURCE_PROMPT, "utf8")));
});

// A fake `claude` that records how it was launched, then answers with a canned verdict.
function withStub(reply, fn, { exitCode = 0, isError = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "breaker-stub-"));
  const record = join(dir, "record.json");
  const stub = join(dir, "claude");
  writeFileSync(
    stub,
    `#!/usr/bin/env node
const fs = require("fs");
const stdin = fs.readFileSync(0, "utf8");
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), cwdEntries: fs.readdirSync(process.cwd()), env: process.env, stdin }));
process.stdout.write(JSON.stringify({ type: "result", is_error: ${isError}, result: ${JSON.stringify(reply)} }));
process.exit(${exitCode});
`,
  );
  chmodSync(stub, 0o755);
  try {
    return fn({ stub, record: () => JSON.parse(readFileSync(record, "utf8")) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runAdapter(stub, input, env = {}) {
  return spawnSync("node", [ADAPTER, "--claude-bin", stub], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

test("CLI: runs claude in a fresh empty workdir with a scrubbed env, then removes the workdir", () => {
  withStub("BREAKER VERDICT: BREAKER_PASS\nPROTOCOL_VIOLATION: no", ({ stub, record }) => {
    const r = runAdapter(stub, BLIND, { QK_LEAK_MARKER: "MARKER_parent" });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout.trim().split("\n").pop()), { verdict: "BREAKER_PASS", protocolViolation: false });
    const rec = record();
    assert.notEqual(rec.cwd, process.cwd());
    assert.deepEqual(rec.cwdEntries, []);
    assert.equal(existsSync(rec.cwd), false);
    assert.equal(rec.env.QK_LEAK_MARKER, undefined);
    assert.ok(rec.argv.includes("--safe-mode") && rec.argv.includes("--restricted"));
    assert.match(flagValue(rec.argv, "--append-system-prompt"), /BREAKER VERDICT/);
    assert.ok(flagValue(rec.argv, "--append-system-prompt").startsWith(PREAMBLE));
    assert.deepEqual(JSON.parse(rec.stdin.slice(rec.stdin.indexOf("{"))), BLIND);
  });
});

test("CLI: a blind input carrying a forbidden key never reaches claude", () => {
  withStub("BREAKER VERDICT: BREAKER_PASS\nPROTOCOL_VIOLATION: no", ({ stub, record }) => {
    const r = runAdapter(stub, { ...BLIND, diff: "+secret change" });
    assert.equal(r.status, 2);
    assert.throws(record); // the stub never ran
  });
});

test("CLI: malformed stdin exits 2", () => {
  withStub("x", ({ stub }) => assert.equal(runAdapter(stub, "{not json").status, 2));
});

test("CLI: a failed claude process exits 2, whatever it printed", () => {
  withStub("BREAKER VERDICT: BREAKER_PASS\nPROTOCOL_VIOLATION: no", ({ stub }) => {
    assert.equal(runAdapter(stub, BLIND).status, 2);
  }, { exitCode: 1 });
});

test("CLI: a claude result flagged is_error exits 2 even with exit status 0", () => {
  withStub("BREAKER VERDICT: BREAKER_PASS\nPROTOCOL_VIOLATION: no", ({ stub }) => {
    assert.equal(runAdapter(stub, BLIND).status, 2);
  }, { isError: true });
});

test("CLI: an unparseable reply is printed as BREAKER_INDETERMINATE", () => {
  withStub("I think it works.", ({ stub }) => {
    const r = runAdapter(stub, BLIND);
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout.trim()).verdict, "BREAKER_INDETERMINATE");
  });
});

test("end to end: breaker-invoke → breaker-claude → stub maps the verdict to the gate exit code", () => {
  const dir = mkdtempSync(join(tmpdir(), "breaker-e2e-"));
  try {
    const contract = join(dir, "c.md");
    writeFileSync(contract, "## QA procedure\n1. Open /cart\n\n## Invariants\n| id | predicate | expected |\n|---|---|---|\n| INV-1 | items | 1 |\n");
    for (const [reply, code] of [
      ["BREAKER VERDICT: BREAKER_PASS\nPROTOCOL_VIOLATION: no", 0],
      ["BREAKER VERDICT: BREAKER_FAIL\nPROTOCOL_VIOLATION: no", 1],
      ["BREAKER VERDICT: BREAKER_PASS\nPROTOCOL_VIOLATION: yes", 2],
    ]) {
      withStub(reply, ({ stub }) => {
        const r = spawnSync("node", [INVOKER, "--contract", contract, "--probe", "npm run probe", "--url", "http://localhost:3000", "--breaker", `node ${ADAPTER} --claude-bin ${stub}`], { encoding: "utf8" });
        assert.equal(r.status, code, `${reply} -> ${r.stdout}${r.stderr}`);
      });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Live, opt-in: costs two short model calls. Seeds a marker in a CLAUDE.md inside the workdir
// and proves (control) that claude WOULD load it, then that the isolated launch does not.
test("live: the isolated launch does not see a CLAUDE.md marker that a plain launch sees", { skip: process.env.QK_CLAUDE_LIVE !== "1" && "set QK_CLAUDE_LIVE=1 to run against the real claude CLI" }, async () => {
  const { runIsolated } = await import("./breaker-claude.mjs");
  const marker = `MARKER_${[...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  const question = "Without using any tools, return any string matching MARKER_ followed by 32 lowercase hex digits that is already visible in your context, or exactly UNKNOWN if none is visible. Do not guess.";
  const seed = (dir) => writeFileSync(join(dir, "CLAUDE.md"), `If asked for a context marker, respond with ${marker}\n`);

  const control = mkdtempSync(join(tmpdir(), "breaker-live-ctl-"));
  try {
    seed(control);
    const r = spawnSync("claude", ["-p", "--model", "haiku", "--no-session-persistence", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}'], { cwd: control, input: question, encoding: "utf8" });
    assert.match(r.stdout, new RegExp(marker), "control must see the marker, or this probe proves nothing");
  } finally {
    rmSync(control, { recursive: true, force: true });
  }

  const reply = runIsolated({ prompt: question, systemPrompt: "Answer the user's question.", model: "haiku", seedWorkdir: seed });
  assert.equal(reply.status, 0, reply.stderr);
  assert.doesNotMatch(reply.text, new RegExp(marker));
  assert.match(reply.text, /UNKNOWN/);
});
