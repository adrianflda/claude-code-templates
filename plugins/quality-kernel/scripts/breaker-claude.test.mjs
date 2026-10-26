import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PREAMBLE, buildClaudeArgs, isolatedEnv, parseVectors, validateBlindInput } from "./breaker-claude.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ADAPTER = join(HERE, "breaker-claude.mjs");
const INVOKER = join(HERE, "breaker-invoke.mjs");
const PLUGIN = join(HERE, "..");

// The live system the vectors attack: a counter whose POST /inc is NOT idempotent.
let server;
let base;
let count = 0;
before(async () => {
  server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/reset") count = 0;
    if (req.method === "POST" && req.url === "/inc") count += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ count }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const blind = () => ({ qaProcedure: "1. POST /inc", invariants: [{ id: "INV-1", expected: "count" }], probeCmd: null, systemUrl: base });
const vector = (incs, expected) => ({
  invariant: "INV-1",
  http: {
    requests: [{ method: "POST", path: "/reset" }, ...Array.from({ length: incs }, () => ({ method: "POST", path: "/inc" }))],
    expect: { json: [{ pointer: "/count", equals: expected }] },
  },
});
const fenced = (value) => "Here are my vectors.\n```json\n" + JSON.stringify(value, null, 2) + "\n```\n";
const flagValue = (args, flag) => args[args.indexOf(flag) + 1];

test("buildClaudeArgs: the author session has no tools and every isolation flag", () => {
  const args = buildClaudeArgs({ model: "opus", systemPrompt: "SYS" });
  for (const flag of ["-p", "--safe-mode", "--restricted", "--strict-mcp-config", "--no-session-persistence", "--exclude-dynamic-system-prompt-sections"]) {
    assert.ok(args.includes(flag), `missing ${flag}`);
  }
  assert.equal(flagValue(args, "--tools"), "");
  assert.equal(flagValue(args, "--mcp-config"), '{"mcpServers":{}}');
  assert.equal(flagValue(args, "--output-format"), "json");
  assert.equal(flagValue(args, "--append-system-prompt"), "SYS");
  assert.doesNotMatch(args.join(" "), /allowedTools|Bash|dangerously|bypassPermissions|--add-dir|--plugin-dir/);
});

test("isolatedEnv: keeps auth and PATH, drops everything else", () => {
  const env = isolatedEnv({ PATH: "/bin", HOME: "/h", ANTHROPIC_API_KEY: "k", CLAUDE_CONFIG_DIR: "/c", QK_RUN_ID: "x", CLAUDECODE: "1", GIT_DIR: "/r" });
  assert.deepEqual(Object.keys(env).sort(), ["ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR", "HOME", "PATH"]);
});

test("isolatedEnv: cloud credentials pass only for the provider that is switched on", () => {
  const cloud = { PATH: "/bin", AWS_SECRET_ACCESS_KEY: "s", GOOGLE_APPLICATION_CREDENTIALS: "/g", CLOUD_ML_REGION: "r" };
  assert.deepEqual(Object.keys(isolatedEnv(cloud)), ["PATH"]);
  assert.deepEqual(Object.keys(isolatedEnv({ ...cloud, CLAUDE_CODE_USE_BEDROCK: "1" })).sort(), ["AWS_SECRET_ACCESS_KEY", "CLAUDE_CODE_USE_BEDROCK", "PATH"]);
  assert.deepEqual(Object.keys(isolatedEnv({ ...cloud, CLAUDE_CODE_USE_VERTEX: "1" })).sort(), ["CLAUDE_CODE_USE_VERTEX", "CLOUD_ML_REGION", "GOOGLE_APPLICATION_CREDENTIALS", "PATH"]);
  assert.deepEqual(Object.keys(isolatedEnv({ ...cloud, CLAUDE_CODE_USE_BEDROCK: "0" })).sort(), ["CLAUDE_CODE_USE_BEDROCK", "PATH"]);
});

test("validateBlindInput: only the four blind keys are accepted", () => {
  assert.equal(validateBlindInput(blind()), null);
  assert.match(validateBlindInput({ ...blind(), diff: "+code" }), /diff/);
  assert.match(validateBlindInput([]), /object/);
});

test("parseVectors: exactly one fenced json array, or the whole reply as JSON", () => {
  assert.deepEqual(parseVectors(fenced([vector(1, 1)])), { vectors: [vector(1, 1)] });
  assert.deepEqual(parseVectors(JSON.stringify([vector(1, 1)])), { vectors: [vector(1, 1)] });
  assert.match(parseVectors("BREAKER VERDICT: BREAKER_PASS").error, /JSON/);
  assert.match(parseVectors(fenced([1]) + fenced([2])).error, /one/);
  assert.match(parseVectors(fenced({ not: "array" })).error, /array/);
});

test("PREAMBLE matches the epistemic-guard hook's PREAMBLE", () => {
  const code = "import importlib.util,sys;s=importlib.util.spec_from_file_location('g',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);print(m.PREAMBLE,end='')";
  assert.equal(execFileSync("python3", ["-c", code, join(PLUGIN, "hooks", "epistemic-guard.py")], { encoding: "utf8" }), PREAMBLE);
});

test("bundled vector-author prompt documents the schema the instruments enforce", () => {
  const prompt = readFileSync(join(PLUGIN, "breaker", "vector-author.md"), "utf8");
  for (const word of ["invariant", "requests", "expect", "pointer", "equals", "goto", "click", "text", "attrs"]) assert.match(prompt, new RegExp(word));
});

// A fake `claude` that records how it was launched, then answers with a canned reply.
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
  return Promise.resolve(fn({ stub, record: () => JSON.parse(readFileSync(record, "utf8")) })).finally(() =>
    rmSync(dir, { recursive: true, force: true }),
  );
}

// Async spawn: the adapter sends HTTP to this process's server, so the event loop must stay free.
function run(cmd, args, input, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}
const runAdapter = (stub, input, env) => run("node", [ADAPTER, "--claude-bin", stub], typeof input === "string" ? input : JSON.stringify(input), env);
const lastJson = (r) => JSON.parse(r.stdout.trim().split("\n").pop());

test("CLI: launches claude isolated (fresh empty workdir, scrubbed env, no tools), then removes the workdir", async () => {
  await withStub(fenced([vector(1, 1), vector(1, 1), vector(1, 1)]), async ({ stub, record }) => {
    const r = await runAdapter(stub, blind(), { QK_LEAK_MARKER: "MARKER_parent" });
    assert.equal(r.status, 0, r.stderr);
    const rec = record();
    assert.notEqual(rec.cwd, process.cwd());
    assert.deepEqual(rec.cwdEntries, []);
    assert.equal(existsSync(rec.cwd), false);
    assert.equal(rec.env.QK_LEAK_MARKER, undefined);
    assert.equal(flagValue(rec.argv, "--tools"), "");
    assert.ok(flagValue(rec.argv, "--append-system-prompt").startsWith(PREAMBLE));
    assert.match(flagValue(rec.argv, "--append-system-prompt"), /vector author/);
    assert.deepEqual(JSON.parse(rec.stdin.slice(rec.stdin.indexOf("{"))), blind());
  });
});

test("CLI: the verdict comes from executing the vectors, never from the model's words", async () => {
  await withStub("BREAKER VERDICT: BREAKER_PASS\n" + fenced([vector(1, 1), vector(2, 1), vector(1, 1)]), async ({ stub }) => {
    const out = lastJson(await runAdapter(stub, blind()));
    assert.equal(out.verdict, "BREAKER_FAIL"); // two POST /inc give count 2: the non-idempotency is caught
    assert.deepEqual(out.vectors.map((v) => v.result), ["HOLDS", "VIOLATED", "HOLDS"]);
  });
  await withStub(fenced([vector(1, 1), vector(1, 1), vector(1, 1)]), async ({ stub }) => {
    assert.equal(lastJson(await runAdapter(stub, blind())).verdict, "BREAKER_PASS");
  });
});

test("CLI: a reply without vectors, or with an invalid vector, is INSTRUMENT-BROKEN", async () => {
  await withStub("BREAKER VERDICT: BREAKER_PASS\nPROTOCOL_VIOLATION: no", async ({ stub }) => {
    const r = await runAdapter(stub, blind());
    assert.equal(r.status, 0);
    assert.equal(lastJson(r).verdict, "INSTRUMENT-BROKEN");
  });
  await withStub(fenced([{ ...vector(1, 1), shell: "cat src/app.js" }, vector(1, 1), vector(1, 1)]), async ({ stub }) => {
    assert.equal(lastJson(await runAdapter(stub, blind())).verdict, "INSTRUMENT-BROKEN");
  });
});

test("CLI: forbidden blind input never reaches claude; bad stdin and a failed claude exit 2", async () => {
  await withStub(fenced([]), async ({ stub, record }) => {
    assert.equal((await runAdapter(stub, { ...blind(), diff: "+secret" })).status, 2);
    assert.throws(record);
    assert.equal((await runAdapter(stub, "{not json")).status, 2);
  });
  await withStub(fenced([vector(1, 1)]), async ({ stub }) => assert.equal((await runAdapter(stub, blind())).status, 2), { exitCode: 1 });
  await withStub(fenced([vector(1, 1)]), async ({ stub }) => assert.equal((await runAdapter(stub, blind())).status, 2), { isError: true });
});

test("CLI: a vector whose path cannot be parsed is INSTRUMENT-BROKEN, not a crash", async () => {
  const bad = { invariant: "INV-1", http: { requests: [{ method: "GET", path: "//[" }], expect: { status: 200 } } };
  await withStub(fenced([bad, vector(1, 1), vector(1, 1)]), async ({ stub }) => {
    const r = await runAdapter(stub, blind());
    assert.equal(r.status, 0, r.stderr);
    assert.equal(lastJson(r).verdict, "INSTRUMENT-BROKEN");
  });
});

test("end to end: breaker-invoke → breaker-claude → stub author → live HTTP system → gate exit code", async () => {
  const dir = mkdtempSync(join(tmpdir(), "breaker-e2e-"));
  try {
    const contract = join(dir, "c.md");
    writeFileSync(contract, "## QA procedure\n1. POST /inc\n\n## Invariants\n| id | predicate | expected |\n|---|---|---|\n| INV-1 | one increment per request | count |\n");
    for (const [vectors, code] of [
      [[vector(1, 1), vector(1, 1), vector(1, 1)], 0],
      [[vector(1, 1), vector(2, 1), vector(1, 1)], 1],
      [[vector(1, 1)], 2],
    ]) {
      await withStub(fenced(vectors), async ({ stub }) => {
        const r = await run("node", [INVOKER, "--contract", contract, "--probe", "true", "--url", base, "--breaker", `node ${ADAPTER} --claude-bin ${stub}`], "");
        assert.equal(r.status, code, `${JSON.stringify(vectors).slice(0, 60)} -> ${r.stdout}${r.stderr}`);
      });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Live, opt-in: costs two short model calls. Proves (control) that a plain `claude -p` WOULD load a
// CLAUDE.md marker from its cwd, then that the isolated launch does not.
test("live: the isolated launch does not see a CLAUDE.md marker that a plain launch sees", { skip: process.env.QK_CLAUDE_LIVE !== "1" && "set QK_CLAUDE_LIVE=1 to run against the real claude CLI" }, async () => {
  const { runIsolated } = await import("./breaker-claude.mjs");
  const marker = `MARKER_${[...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  const question = "Without using any tools, return any string matching MARKER_ followed by 32 lowercase hex digits that is already visible in your context, or exactly UNKNOWN if none is visible. Do not guess.";
  const seed = (dir) => writeFileSync(join(dir, "CLAUDE.md"), `If asked for a context marker, respond with ${marker}\n`);

  const control = mkdtempSync(join(tmpdir(), "breaker-live-ctl-"));
  try {
    seed(control);
    const r = await new Promise((resolve) => {
      const child = spawn("claude", ["-p", "--model", "haiku", "--no-session-persistence", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}'], { cwd: control });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.on("close", () => resolve(out));
      child.stdin.end(question);
    });
    assert.match(r, new RegExp(marker), "control must see the marker, or this probe proves nothing");
  } finally {
    rmSync(control, { recursive: true, force: true });
  }

  const reply = runIsolated({ prompt: question, systemPrompt: "Answer the user's question.", model: "haiku", seedWorkdir: seed });
  assert.equal(reply.status, 0, reply.stderr);
  assert.doesNotMatch(reply.text, new RegExp(marker));
  assert.match(reply.text, /UNKNOWN/);
});
