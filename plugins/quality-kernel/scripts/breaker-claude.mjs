#!/usr/bin/env node
// Isolated breaker launcher — the production `--breaker` command for breaker-invoke.mjs.
//
// breaker-invoke.mjs already builds the breaker's INPUT from the contract only. This closes the
// other channel: what the breaker session loads on its own. It runs `claude -p` so that the
// session starts with nothing but the bundled breaker prompt and the blind input:
//
//   --safe-mode     no CLAUDE.md, skills, plugins, hooks (so no SessionStart memory injection),
//                   MCP servers, custom agents or output styles
//   --restricted    user/project/local settings ignored; Read/Glob/Grep confined to the workdir
//   --strict-mcp-config + an empty --mcp-config, --no-session-persistence
//   cwd             a fresh, empty temp dir (removed afterwards), so there is no repo to discover
//   env             an allowlist (PATH, HOME, ANTHROPIC_*, and cloud credentials only for the
//                   provider switched on by CLAUDE_CODE_USE_BEDROCK / _VERTEX); nothing else
//
// Live-probed on Claude Code 2.1.310: a CLAUDE.md marker a plain `claude -p` returns is not visible
// under these flags, and Read of a path outside the workdir is refused.
//
// RESIDUAL (not closed here): Bash is required to execute probes, and Bash is NOT confined —
// `cat <path>` or `git -C <repo> diff` still reads the disk. The breaker learns no repo path from
// this launcher, but a probe command that names one gives it away. Bash also sees the credentials
// the session needs (`env`): an ANTHROPIC_API_KEY or the active cloud provider's keys (OAuth
// sessions keep theirs in the keychain). Isolation of Bash is future work.
//
// Usage: breaker-claude.mjs [--model opus] [--claude-bin claude] [--prompt-file <md>]  < blind-input.json
// Prints one JSON line: { verdict, protocolViolation }.
// Exit: 0 = a verdict was read (any value) · 2 = could not run (bad input, claude failed).

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const BREAKER_TOOLS = ["Bash", "Read", "Glob", "Grep"];

// Same text the epistemic-guard hook prepends to every Agent spawn; hooks do not run under
// --safe-mode, so the launcher adds it (a test keeps the two equal).
export const PREAMBLE =
  "[EPISTEMIC-DISCIPLINE v1] Label each claim OBSERVED or INFERRED; probe first when a live check costs " +
  "<15 min; report residual risk first.";

const BLIND_KEYS = new Set(["qaProcedure", "invariants", "probeCmd", "systemUrl"]);
const VERDICTS = new Set(["BREAKER_PASS", "BREAKER_FAIL", "INSTRUMENT-BROKEN"]);
const ENV_KEYS = new Set(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "TERM", "CLAUDE_CONFIG_DIR"]);
const ENV_PREFIXES = ["ANTHROPIC_", "CLAUDE_CODE_USE_"];
// Cloud credentials reach the session (and its unconfined Bash) only for the provider in use.
const PROVIDER_PREFIXES = {
  CLAUDE_CODE_USE_BEDROCK: ["AWS_"],
  CLAUDE_CODE_USE_VERTEX: ["GOOGLE_APPLICATION_CREDENTIALS", "CLOUD_ML_", "VERTEX_REGION_"],
};
const isOn = (value) => value !== undefined && !["", "0", "false"].includes(String(value).toLowerCase());
const DEFAULT_PROMPT = fileURLToPath(new URL("../breaker/pipeline-breaker.md", import.meta.url));
const CLAUDE_TIMEOUT_MS = 570_000; // under breaker-invoke's 600 s, so the invoker sees our verdict

export function buildClaudeArgs({ model, systemPrompt }) {
  const tools = BREAKER_TOOLS.join(",");
  return [
    "-p",
    "--safe-mode",
    "--restricted",
    "--tools", tools,
    "--allowedTools", tools,
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

export function promptBody(markdown) {
  return markdown.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
}

// Exactly one known verdict line and exactly one protocol line, or BREAKER_INDETERMINATE.
// A PASS from a breaker that saw something it should not have is not trusted.
export function parseVerdict(text) {
  const verdicts = [...text.matchAll(/^[*_`\s]*BREAKER VERDICT:[*_`\s]*([A-Z_-]+)/gm)].map((m) => m[1]);
  const flags = [...text.matchAll(/^[*_`\s]*PROTOCOL_VIOLATION:[*_`\s]*(yes|no)\b/gim)].map((m) => m[1].toLowerCase());
  const protocolViolation = flags.length === 1 ? flags[0] === "yes" : null;
  if (verdicts.length !== 1 || !VERDICTS.has(verdicts[0]) || protocolViolation === null) {
    return { verdict: "BREAKER_INDETERMINATE", protocolViolation };
  }
  if (verdicts[0] === "BREAKER_PASS" && protocolViolation) return { verdict: "BREAKER_INDETERMINATE", protocolViolation };
  return { verdict: verdicts[0], protocolViolation };
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
  const args = { model: "opus", claudeBin: "claude", promptFile: DEFAULT_PROMPT };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--model") args.model = argv[++i];
    else if (argv[i] === "--claude-bin") args.claudeBin = argv[++i];
    else if (argv[i] === "--prompt-file") args.promptFile = argv[++i];
  }
  return args;
}

function fail(reason) {
  process.stdout.write(JSON.stringify({ verdict: "BREAKER_INDETERMINATE", reason }) + "\n");
  process.exit(2);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    fail("stdin is not a JSON blind input");
  }
  const invalid = validateBlindInput(input);
  if (invalid) fail(invalid);

  let body;
  try {
    body = promptBody(readFileSync(args.promptFile, "utf8"));
  } catch (err) {
    fail(`cannot read breaker prompt ${args.promptFile}: ${err.message}`);
  }
  const prompt = `Blind input (JSON keys: qaProcedure, invariants, probeCmd, systemUrl):\n${JSON.stringify(input)}`;
  const reply = runIsolated({ prompt, systemPrompt: `${PREAMBLE}\n\n${body}`, model: args.model, claudeBin: args.claudeBin });
  if (reply.status !== 0) fail(`breaker session failed: ${reply.stderr}`);
  process.stdout.write(JSON.stringify(parseVerdict(reply.text)) + "\n");
  process.exit(0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
