#!/usr/bin/env node
/**
 * Quality-Kernel commit proof.
 *
 * A commit says why, what changed, and how it was proved. This prints the "how" from the
 * evidence ledger (.quality-kernel/evidence-ledger.jsonl, written by hooks/evidence-gate.py)
 * as commit trailers, using only the verification events recorded since a git ref
 * (default HEAD, i.e. since the last commit):
 *
 *   Proof: `node --test scripts/*.test.mjs` -> exit 0
 *   Unverified: `node --test | grep pass` -> exit 0 (exit code of the last command only (| or ||))
 *   Unproven: `pytest -q` -> exit 1
 *
 * Only the latest run of each command counts. A command whose latest run failed, or whose
 * exit code is unknown (rows written before the ledger recorded exit codes), is Unproven.
 * An exit 0 that only speaks for the last command of a pipe, `;`, `||` or `&`
 * (`node --test | grep pass` is grep's exit code), or a command truncated by the hook, is
 * Unverified: listed, but it neither proves nor blocks. Record proof runs as a single
 * command or an `&&` chain.
 *
 * Usage:
 *   node proof.mjs [--repo .] [--ledger <path>] [--since <git-ref> | --since-ts <epoch-seconds>] [--json]
 * Exit code: 0 at least one Proof and no Unproven, 1 otherwise, 2 ledger or ref unreadable.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export function parseArgs(argv) {
  const args = { repo: ".", ledger: null, since: "HEAD", sinceTs: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") args.repo = argv[++i];
    else if (a === "--ledger") args.ledger = argv[++i];
    else if (a === "--since") args.since = argv[++i];
    else if (a === "--since-ts") args.sinceTs = Number(argv[++i]);
    else if (a === "--json") args.json = true;
    else if (a === "--help" || a === "-h") args.help = true;
  }
  return args;
}

export function parseLedger(text) {
  const rows = [];
  let malformed = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row.command === "string" && Number.isFinite(row.ts)) rows.push(row);
      else malformed += 1;
    } catch {
      malformed += 1;
    }
  }
  return { rows, malformed };
}

// The hook stores at most this many characters of a command (hooks/evidence-gate.py).
export const LEDGER_COMMAND_MAX = 300;

// Why a recorded exit code does not speak for every command in the line, or null when it
// does. The shell reports only the last command of a pipeline (`a | grep`), a sequence
// (`a; b`), a fallback (`a || true`) or a background job (`a & b`), so a red test can sit
// behind exit 0. Only a single command or an `&&` chain is trusted. A command at the
// hook's length cap may have lost its tail, so it is not trusted either.
export function exitMasked(command) {
  if (command.length >= LEDGER_COMMAND_MAX) return "truncated in the ledger";
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === "\\" && quote === '"') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "\\") i += 1;
    else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "|") return "exit code of the last command only (| or ||)";
    else if (ch === ";" || ch === "\n") return "exit code of the last command only (;)";
    else if (ch === "&") {
      if (command[i + 1] === "&") i += 1;
      else if (command[i - 1] !== ">" && command[i - 1] !== "<" && command[i + 1] !== ">") {
        return "exit code of the last command only (&)";
      }
    }
  }
  return null;
}

export function classify(row) {
  if (row.interrupted === true || row.is_interrupt === true) return { status: "unproven", reason: "interrupted" };
  if (row.exit_code !== 0) return { status: "unproven", reason: null };
  const masked = exitMasked(row.command);
  return masked ? { status: "unverified", reason: masked } : { status: "proof", reason: null };
}

// Latest row per command after `sinceTs`, oldest first, each labeled proof / unproven.
export function summarize(rows, sinceTs) {
  const latest = new Map();
  for (const row of rows) {
    if (row.ts <= sinceTs) continue;
    const prev = latest.get(row.command);
    if (!prev || row.ts >= prev.ts) latest.set(row.command, row);
  }
  return [...latest.values()]
    .sort((a, b) => a.ts - b.ts)
    .map((row) => ({ command: row.command, exitCode: row.exit_code ?? null, ...classify(row) }));
}

// Unverified rows prove nothing either way, so they neither count nor block.
export function verdict(entries) {
  const proved = entries.some((e) => e.status === "proof");
  const failed = entries.some((e) => e.status === "unproven");
  return proved && !failed ? 0 : 1;
}

const LABELS = { proof: "Proof", unverified: "Unverified", unproven: "Unproven" };

export function trailer(entry) {
  const label = LABELS[entry.status];
  const code = entry.exitCode === null ? "unknown" : entry.exitCode;
  const reason = entry.reason ? ` (${entry.reason})` : "";
  return `${label}: \`${entry.command}\` -> exit ${code}${reason}`;
}

function refTimestamp(repo, ref) {
  const out = execFileSync("git", ["-C", repo, "log", "-1", "--format=%ct", ref], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const ts = Number(out.trim());
  if (!Number.isFinite(ts) || out.trim() === "") throw new Error(`no commit time for ${ref}`);
  return ts;
}

function fail(message) {
  console.error(`[proof] ${message}`);
  process.exit(2);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.error("Usage: node proof.mjs [--repo .] [--ledger <path>] [--since <ref> | --since-ts <epoch>] [--json]");
    process.exit(0);
  }

  let sinceTs = args.sinceTs;
  if (sinceTs === null) {
    try {
      sinceTs = refTimestamp(args.repo, args.since);
    } catch (err) {
      fail(`cannot resolve --since ${args.since}: ${String(err.message).split("\n")[0]}`);
    }
  } else if (!Number.isFinite(sinceTs)) {
    fail("invalid --since-ts (must be epoch seconds)");
  }

  const ledgerPath = args.ledger ?? join(args.repo, ".quality-kernel", "evidence-ledger.jsonl");
  let text;
  try {
    text = readFileSync(ledgerPath, "utf8");
  } catch (err) {
    fail(`cannot read ledger ${ledgerPath}: ${err.message}`);
  }

  const { rows, malformed } = parseLedger(text);
  const entries = summarize(rows, sinceTs);
  const code = verdict(entries);

  if (args.json) {
    console.log(JSON.stringify({ sinceTs, malformed, entries, pass: code === 0 }, null, 2));
  } else {
    for (const e of entries) console.log(trailer(e));
    if (entries.length === 0) console.error("[proof] no verification event recorded since the reference point");
    if (malformed > 0) console.error(`[proof] skipped ${malformed} malformed ledger line(s)`);
  }
  process.exit(code);
}

// Run as CLI only when invoked directly, so the module can be imported for tests.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
