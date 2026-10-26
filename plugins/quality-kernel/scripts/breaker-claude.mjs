#!/usr/bin/env node
// Isolated breaker launcher — the production `--breaker` command for breaker-invoke.mjs.
//
// Two stages, so that no model ever both sees the system and decides the verdict:
//   1. AUTHOR — `claude -p` with NO tools writes falsifying vectors (data) from the blind input
//      alone, using the bundled breaker/vector-author.md prompt.
//   2. EXECUTE — vector-breaker.mjs validates the vectors, runs them through the deterministic
//      HTTP / UI instruments against the live local system, runs the contract probe after each,
//      and computes the verdict in code. Whatever the author claims in prose is ignored.
//
// The author session starts with nothing but its prompt and the blind input:
//   --tools ""      no Bash, no file tools: it cannot read the repo, the diff or the environment
//   --safe-mode     no CLAUDE.md, skills, plugins, hooks (so no SessionStart memory injection),
//                   MCP servers, custom agents or output styles
//   --restricted    user/project/local settings ignored
//   --strict-mcp-config + an empty --mcp-config, --no-session-persistence
//   cwd             a fresh, empty temp dir (removed afterwards)
//   env             an allowlist (PATH, HOME, ANTHROPIC_*, and cloud credentials only for the
//                   provider switched on by CLAUDE_CODE_USE_BEDROCK / _VERTEX); nothing else
// Live-probed on Claude Code 2.1.310: a CLAUDE.md marker a plain `claude -p` returns is not visible
// under these flags.
//
// Usage: breaker-claude.mjs [--model opus] [--claude-bin claude] [--config tools.json]  < blind-input.json
// Prints one JSON line: { verdict, executed, vectors, reason? }.
// Exit: 0 = a verdict was computed (any value) · 2 = could not run (bad input, claude failed).

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runVectors } from "./vector-breaker.mjs";
import { isMain } from "./is-main.mjs";

// Same text the epistemic-guard hook prepends to every Agent spawn; hooks do not run under
// --safe-mode, so the launcher adds it (a test keeps the two equal).
export const PREAMBLE =
  "[EPISTEMIC-DISCIPLINE v1] Label each claim OBSERVED or INFERRED; probe first when a live check costs " +
  "<15 min; report residual risk first.";

const BLIND_KEYS = new Set(["qaProcedure", "invariants", "probeCmd", "systemUrl"]);
const ENV_KEYS = new Set(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "TERM", "CLAUDE_CONFIG_DIR"]);
const ENV_PREFIXES = ["ANTHROPIC_", "CLAUDE_CODE_USE_"];
// Cloud credentials reach the author session only for the provider in use.
const PROVIDER_PREFIXES = {
  CLAUDE_CODE_USE_BEDROCK: ["AWS_"],
  CLAUDE_CODE_USE_VERTEX: ["GOOGLE_APPLICATION_CREDENTIALS", "CLOUD_ML_", "VERTEX_REGION_"],
};
const isOn = (value) => value !== undefined && !["", "0", "false"].includes(String(value).toLowerCase());
const AUTHOR_PROMPT = fileURLToPath(new URL("../breaker/vector-author.md", import.meta.url));
// The author gets 5 minutes; executing the vectors uses the rest of breaker-invoke's 600 s. If the
// whole run overruns, breaker-invoke kills it and reports could-not-run (fail-closed).
const CLAUDE_TIMEOUT_MS = 300_000;

export function buildClaudeArgs({ model, systemPrompt }) {
  return [
    "-p",
    "--safe-mode",
    "--restricted",
    "--tools", "",
    "--strict-mcp-config",
    "--mcp-config", '{"mcpServers":{}}',
    "--no-session-persistence",
    "--exclude-dynamic-system-prompt-sections",
    "--output-format", "json",
    "--model", model,
    "--append-system-prompt", systemPrompt,
  ];
}

export function isolatedEnv(env) {
  const prefixes = [...ENV_PREFIXES];
  for (const [flag, extra] of Object.entries(PROVIDER_PREFIXES)) if (isOn(env[flag])) prefixes.push(...extra);
  return Object.fromEntries(
    Object.entries(env).filter(([k]) => ENV_KEYS.has(k) || prefixes.some((p) => k.startsWith(p))),
  );
}

export function validateBlindInput(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return "blind input must be a JSON object";
  const extra = Object.keys(input).filter((k) => !BLIND_KEYS.has(k));
  return extra.length ? `blind input carries forbidden key(s): ${extra.join(", ")}` : null;
}

// The author's reply is data: exactly one ```json block holding an array (or a bare JSON array).
export function parseVectors(text) {
  const blocks = [...String(text).matchAll(/```json\s*\n([\s\S]*?)\n```/g)].map((m) => m[1]);
  if (blocks.length > 1) return { error: `expected one json block, got ${blocks.length}` };
  let value;
  try {
    value = JSON.parse(blocks.length === 1 ? blocks[0] : String(text).trim());
  } catch {
    return { error: "the author's reply holds no parseable JSON vectors" };
  }
  return Array.isArray(value) ? { vectors: value } : { error: "the author's vectors must be a JSON array" };
}

// Runs one isolated `claude -p` turn. `seedWorkdir` lets the live leak test plant files in the
// workdir before launch; production never passes it.
export function runIsolated({ prompt, systemPrompt, model = "opus", claudeBin = "claude", seedWorkdir = null }) {
  const workdir = mkdtempSync(join(tmpdir(), "qk-breaker-"));
  try {
    if (seedWorkdir) seedWorkdir(workdir);
    const r = spawnSync(claudeBin, buildClaudeArgs({ model, systemPrompt }), {
      cwd: workdir,
      env: isolatedEnv(process.env),
      input: prompt,
      encoding: "utf8",
      timeout: CLAUDE_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (r.error || r.status !== 0) {
      return { status: r.status ?? 2, text: "", stderr: r.error ? r.error.message : String(r.stderr || "").slice(0, 500) };
    }
    let out;
    try {
      out = JSON.parse(r.stdout);
    } catch {
      return { status: 2, text: "", stderr: "claude did not print a JSON result" };
    }
    if (out.is_error) return { status: 2, text: "", stderr: `claude reported an error: ${String(out.result).slice(0, 300)}` };
    return { status: 0, text: String(out.result ?? ""), stderr: "" };
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const args = { model: "opus", claudeBin: "claude", config: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--model") args.model = argv[++i];
    else if (argv[i] === "--claude-bin") args.claudeBin = argv[++i];
    else if (argv[i] === "--config") args.config = argv[++i];
  }
  return args;
}

function fail(reason) {
  process.stdout.write(JSON.stringify({ verdict: "BREAKER_INDETERMINATE", reason }) + "\n");
  process.exit(2);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    fail("stdin is not a JSON blind input");
  }
  const invalid = validateBlindInput(input);
  if (invalid) fail(invalid);

  let config = null;
  if (args.config) {
    try {
      config = JSON.parse(readFileSync(args.config, "utf8"));
    } catch (err) {
      fail(`cannot read --config ${args.config}: ${err.message}`);
    }
  }
  const authorPrompt = readFileSync(AUTHOR_PROMPT, "utf8").trim();
  const prompt = `Blind input (JSON keys: qaProcedure, invariants, probeCmd, systemUrl):\n${JSON.stringify(input)}`;
  const reply = runIsolated({ prompt, systemPrompt: `${PREAMBLE}\n\n${authorPrompt}`, model: args.model, claudeBin: args.claudeBin });
  if (reply.status !== 0) fail(`breaker author session failed: ${reply.stderr}`);

  const parsed = parseVectors(reply.text);
  const out = parsed.error
    ? { verdict: "INSTRUMENT-BROKEN", reason: parsed.error, executed: 0, vectors: [] }
    : await runVectors({ vectors: parsed.vectors, blind: input, config });
  process.stdout.write(JSON.stringify(out) + "\n");
  process.exit(0);
}

if (isMain(import.meta.url)) {
  // Any throw (unreadable prompt, an instrument crash) is could-not-run (exit 2), never a verdict.
  main().catch((err) => fail(`breaker crashed: ${err && err.message ? err.message : err}`));
}
