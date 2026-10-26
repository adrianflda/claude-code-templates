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
 * An exit 0 is Proof only for an allowlisted command: plain words, quoted strings, simple
 * redirects and `&&` chains. Anything else is Unverified — listed, but it neither proves nor
 * blocks: a pipe, `;`, `||` or `&` (`node --test | grep pass` is grep's exit code), `$`,
 * backticks, subshells, heredocs, or a command truncated by the hook. Record proof runs as
 * a single command or an `&&` chain, redirecting output to a file instead of piping it.
 * Commands are printed escaped on one line, so ledger text cannot forge a trailer.
 *
 * Usage:
 *   node proof.mjs [--repo .] [--ledger <path>] [--since <git-ref> | --since-ts <epoch-seconds>] [--json]
 * Exit code: 0 at least one Proof and no Unproven, 1 otherwise, 2 ledger or ref unreadable.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { isMain } from "./is-main.mjs";

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

// The hook stores at most this many characters of a command: `_MAX_COMMAND` in
// hooks/evidence-gate.py (proof.test.mjs fails if the two drift apart).
export const LEDGER_COMMAND_MAX = 300;

// Characters a trusted command may contain outside quotes: words, paths, globs, `=`.
const PLAIN = /[A-Za-z0-9_\-./:=@%+,~*?[\]\s]/;
const LAST_ONLY = (op) => `exit code of the last command only (${op})`;

// Returns the index just past a quoted string starting at `i`, or a reason string when the
// string is unterminated or (double quotes) expands `$` or a backtick.
function skipQuoted(command, i) {
  const quote = command[i];
  for (let j = i + 1; j < command.length; j++) {
    const ch = command[j];
    if (ch === quote) return j + 1;
    if (quote === '"' && ch === "\\") j += 1;
    else if (quote === '"' && (ch === "$" || ch === "`")) return `expansion inside double quotes (${ch})`;
  }
  return "unterminated quote";
}

// Length of the redirect operator starting at `i` (`>`, `>&N`, `&>`, `<`), or 0 when there
// is none. `>>` and `&>>` are two consecutive operators here, which accepts the same text.
function redirectLength(command, i) {
  const rest = command.slice(i, i + 3);
  const match = rest.match(/^(?:&>|>&\d|>|<(?![<(]))/);
  return match ? match[0].length : 0;
}

// Why a recorded exit code may not speak for the command it was recorded for, or null when
// it does. This is an ALLOWLIST: a trusted command is plain words, quoted strings, simple
// redirects and `&&` chains. Pipes, `;`, `||`, `&` report only the last command's code;
// `$`, backticks, subshells, braces, heredocs, `!` and comments are syntax this check does
// not model — all of it is Unverified. A command at the hook's length cap may have lost
// its tail, so it is not trusted either.
export function exitMasked(command) {
  if (command.length >= LEDGER_COMMAND_MAX) return "truncated in the ledger";
  for (let i = 0; i < command.length; ) {
    const ch = command[i];
    if (ch === "\n" || ch === ";") return LAST_ONLY(";");
    if (ch === "|") return LAST_ONLY("| or ||");
    if (ch === "'" || ch === '"') {
      const next = skipQuoted(command, i);
      if (typeof next === "string") return next;
      i = next;
    } else if (ch === "\\") {
      if (i + 1 >= command.length || command[i + 1] === "\n") return "line continuation";
      i += 2;
    } else if (command.startsWith("&&", i)) {
      i += 2;
    } else if (redirectLength(command, i) > 0) {
      i += redirectLength(command, i);
    } else if (ch === "&") {
      return LAST_ONLY("&");
    } else if (PLAIN.test(ch)) {
      i += 1;
    } else {
      return `shell syntax this check does not trust (${ch})`;
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

// One trailer per entry, always on one line: the command is ledger data, so a newline in it
// must never start a line git would read as another (forged) `Proof:` trailer.
export function escapeCommand(command) {
  return command.replace(/\\/g, "\\\\").replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/`/g, "\\`");
}

export function trailer(entry) {
  const label = LABELS[entry.status];
  const code = entry.exitCode === null ? "unknown" : entry.exitCode;
  const reason = entry.reason ? ` (${entry.reason})` : "";
  return `${label}: \`${escapeCommand(entry.command)}\` -> exit ${code}${reason}`;
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
  // An unreadable line (a torn hook write) may be the failing run, so it fails closed.
  const code = malformed > 0 ? 1 : verdict(entries);

  if (args.json) {
    console.log(JSON.stringify({ sinceTs, malformed, entries, pass: code === 0 }, null, 2));
  } else {
    for (const e of entries) console.log(trailer(e));
    if (entries.length === 0) console.error("[proof] no verification event recorded since the reference point");
    if (malformed > 0) console.error(`[proof] ${malformed} unreadable ledger line(s): not proved (one may be the failing run)`);
  }
  process.exit(code);
}

// Run as CLI only when invoked directly, so the module can be imported for tests.
if (isMain(import.meta.url)) {
  main();
}
