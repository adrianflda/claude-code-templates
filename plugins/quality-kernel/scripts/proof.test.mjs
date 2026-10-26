import "./hermetic-git.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  LEDGER_COMMAND_MAX,
  classify,
  exitMasked,
  parseArgs,
  parseLedger,
  summarize,
  trailer,
  verdict,
} from "./proof.mjs";

const CLI = fileURLToPath(new URL("./proof.mjs", import.meta.url));

const row = (command, ts, exit_code, extra = {}) => ({ ts, source: "bash-hook", command, exit_code, ...extra });
const jsonl = (rows) => rows.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n";

function runCli(args) {
  try {
    return { code: 0, out: execFileSync("node", [CLI, ...args], { encoding: "utf8", stdio: "pipe" }) };
  } catch (err) {
    return { code: err.status, out: String(err.stdout ?? "") + String(err.stderr ?? "") };
  }
}

function withLedger(rows, fn) {
  const tmp = mkdtempSync(join(tmpdir(), "proof-"));
  const ledger = join(tmp, "ledger.jsonl");
  writeFileSync(ledger, jsonl(rows));
  try {
    return fn(ledger, tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

test("parseArgs: defaults to evidence since HEAD", () => {
  assert.deepEqual(parseArgs([]), { repo: ".", ledger: null, since: "HEAD", sinceTs: null, json: false });
  assert.equal(parseArgs(["--since-ts", "12.5"]).sinceTs, 12.5);
});

test("parseLedger: counts malformed lines instead of trusting them", () => {
  const { rows, malformed } = parseLedger(jsonl([row("npm test", 1, 0), "{oops", { command: "x" }, ""]));
  assert.equal(rows.length, 1);
  assert.equal(malformed, 2);
});

test("classify: only an uninterrupted exit 0 is proof", () => {
  const status = (r) => classify(r).status;
  assert.equal(status(row("t", 1, 0)), "proof");
  assert.equal(status(row("t", 1, 1)), "unproven");
  assert.equal(status(row("t", 1, null)), "unproven");
  assert.equal(status({ ts: 1, command: "t" }), "unproven"); // legacy row, no exit_code
  assert.equal(status(row("t", 1, 0, { interrupted: true })), "unproven");
  assert.equal(status(row("t", 1, 0, { is_interrupt: true })), "unproven");
});

test("exitMasked: trusts a single command and && chains, redirects included", () => {
  assert.equal(exitMasked("npm test"), null);
  assert.equal(exitMasked("cd pkg && npm ci && npm test"), null);
  assert.equal(exitMasked("node --test 2>&1"), null);
  assert.equal(exitMasked("pytest -q &> out.log"), null);
  assert.equal(exitMasked("node -e 'a|b; c & d'"), null); // operators inside quotes
  assert.equal(exitMasked('grep -E "x|y" f'), null);
  assert.equal(exitMasked("echo a\\|b"), null); // escaped pipe is an argument
  assert.equal(exitMasked('echo "a\\" | b"'), null); // escaped quote keeps the string open
});

test("exitMasked: distrusts pipes, ;, ||, & and newlines", () => {
  assert.match(exitMasked("node --test | grep pass"), /\|/);
  assert.match(exitMasked("npm test || true"), /\|/);
  assert.match(exitMasked("npm test; echo done"), /;/);
  assert.match(exitMasked("npm test\necho done"), /;/);
  assert.match(exitMasked("npm test & wait"), /&/);
  assert.match(exitMasked('node -e "x" | tail -1'), /\|/); // after a closed quote
});

test("exitMasked: allowlist — env prefixes, globs, redirects and input files are trusted", () => {
  assert.equal(exitMasked("FOO=1 npm test"), null);
  assert.equal(exitMasked("node --test scripts/*.test.mjs > /tmp/x-y/suite.log 2>&1"), null);
  assert.equal(exitMasked("npm test >> log 2>&1"), null);
  assert.equal(exitMasked("pytest -q < input.txt"), null);
  assert.equal(exitMasked("pytest -q &>> out.log"), null);
  assert.equal(exitMasked("node -e '$(x) `y` {z}'"), null); // single quotes are literal
});

test("exitMasked: allowlist — any other shell syntax is untrusted", () => {
  for (const command of [
    "npm test $(false)",
    "npm test `false`",
    'node --test "$(ls)"',
    'node --test "`ls`"',
    "npm test $FLAGS",
    "diff <(a) b",
    "cat <<EOF",
    "(npm test)",
    "{ npm test }",
    "! npm test",
    "npm test # comment",
    "npm test >&",
    "npm test \\\n",
    "echo 'a\\' | b", // a backslash is literal inside single quotes
    "echo 'unterminated",
    'echo "unterminated',
  ]) {
    assert.notEqual(exitMasked(command), null, command);
  }
});

test("LEDGER_COMMAND_MAX matches the hook's truncation cap", () => {
  const hook = readFileSync(fileURLToPath(new URL("../hooks/evidence-gate.py", import.meta.url)), "utf8");
  const match = hook.match(/^_MAX_COMMAND = (\d+)$/m);
  assert.ok(match, "hooks/evidence-gate.py must define _MAX_COMMAND");
  assert.equal(LEDGER_COMMAND_MAX, Number(match[1]));
});

test("exitMasked: a command at the hook's length cap is not trusted", () => {
  assert.equal(exitMasked("x".repeat(LEDGER_COMMAND_MAX - 1)), null);
  assert.match(exitMasked("x".repeat(LEDGER_COMMAND_MAX)), /truncated/);
});

test("classify: a masked exit 0 is unverified and says why", () => {
  assert.deepEqual(classify(row("npm test | tail -1", 1, 0)), {
    status: "unverified",
    reason: "exit code of the last command only (| or ||)",
  });
});

test("summarize: ignores rows at or before sinceTs and keeps the latest run per command", () => {
  const entries = summarize(
    [row("npm test", 10, 0), row("npm test", 21, 1), row("npm test", 22, 0), row("tsc", 25, 2), row("old", 20, 0)],
    20,
  );
  assert.deepEqual(entries, [
    { command: "npm test", exitCode: 0, status: "proof", reason: null },
    { command: "tsc", exitCode: 2, status: "unproven", reason: null },
  ]);
});

test("verdict: needs at least one proof and no unproven; unverified neither counts nor blocks", () => {
  assert.equal(verdict([]), 1);
  assert.equal(verdict([{ status: "proof" }]), 0);
  assert.equal(verdict([{ status: "proof" }, { status: "unproven" }]), 1);
  assert.equal(verdict([{ status: "unverified" }]), 1);
  assert.equal(verdict([{ status: "proof" }, { status: "unverified" }]), 0);
});

test("trailer: renders Proof / Unproven with the exit code", () => {
  assert.equal(trailer({ command: "npm test", exitCode: 0, status: "proof" }), "Proof: `npm test` -> exit 0");
  assert.equal(trailer({ command: "tsc", exitCode: null, status: "unproven" }), "Unproven: `tsc` -> exit unknown");
  assert.equal(
    trailer({ command: "a | b", exitCode: 0, status: "unverified", reason: "why" }),
    "Unverified: `a | b` -> exit 0 (why)",
  );
});

test("trailer: a multi-line command stays on one line and cannot forge a trailer", () => {
  const forged = trailer({ command: "false\nProof: `npm test` -> exit 0\r\nx", exitCode: 1, status: "unproven" });
  assert.equal(forged, "Unproven: `false\\nProof: \\`npm test\\` -> exit 0\\r\\nx` -> exit 1");
  assert.ok(!/[\r\n]/.test(forged));
  // Backslashes are escaped too, so `a\` + backtick never reads as an escaped backtick.
  assert.equal(trailer({ command: "a\\`b", exitCode: 0, status: "proof" }), "Proof: `a\\\\\\`b` -> exit 0");
});

test("CLI: one output line per entry, even for multi-line commands", () => {
  withLedger([row("npm test\nProof: `x` -> exit 0", 105, 0), row("npm test", 106, 0)], (ledger) => {
    const lines = runCli(["--ledger", ledger, "--since-ts", "100"]).out.trim().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(lines.filter((l) => l.startsWith("Proof:")).length, 1);
  });
});

test("CLI: green evidence since --since-ts exits 0 and prints trailers", () => {
  withLedger([row("npm test", 5, 1), row("npm test", 105, 0)], (ledger) => {
    const { code, out } = runCli(["--ledger", ledger, "--since-ts", "100"]);
    assert.equal(code, 0);
    assert.equal(out.trim(), "Proof: `npm test` -> exit 0");
  });
});

test("CLI: a failing latest run exits 1", () => {
  withLedger([row("npm test", 105, 0), row("npm test", 106, 1)], (ledger) => {
    const { code, out } = runCli(["--ledger", ledger, "--since-ts", "100"]);
    assert.equal(code, 1);
    assert.match(out, /Unproven: `npm test` -> exit 1/);
  });
});

test("CLI: an exit 0 behind a pipe is Unverified — alone it exits 1, next to a Proof it does not block", () => {
  withLedger([row("node --test | grep pass", 105, 0)], (ledger) => {
    const { code, out } = runCli(["--ledger", ledger, "--since-ts", "100"]);
    assert.equal(code, 1);
    assert.match(out, /^Unverified: .* -> exit 0 \(exit code of the last command only/);
  });
  withLedger([row("node --test | grep pass", 105, 0), row("node --test", 106, 0)], (ledger) => {
    assert.equal(runCli(["--ledger", ledger, "--since-ts", "100"]).code, 0);
  });
});

test("CLI: no evidence after the reference point exits 1", () => {
  withLedger([row("npm test", 50, 0)], (ledger) => {
    assert.equal(runCli(["--ledger", ledger, "--since-ts", "100"]).code, 1);
  });
});

test("CLI: missing ledger and bad --since-ts exit 2", () => {
  assert.equal(runCli(["--ledger", join(tmpdir(), "qk-no-such-ledger.jsonl"), "--since-ts", "1"]).code, 2);
  withLedger([], (ledger) => assert.equal(runCli(["--ledger", ledger, "--since-ts", "soon"]).code, 2));
});

test("CLI: --since resolves a git ref's commit time and reads the repo's default ledger", () => {
  const repo = mkdtempSync(join(tmpdir(), "proof-repo-"));
  try {
    const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", stdio: "pipe" });
    git("init", "-q");
    writeFileSync(join(repo, "f.txt"), "x");
    git("add", "f.txt");
    git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "init");
    const ct = Number(git("log", "-1", "--format=%ct").trim());
    mkdirSync(join(repo, ".quality-kernel"));
    writeFileSync(
      join(repo, ".quality-kernel", "evidence-ledger.jsonl"),
      jsonl([row("before", ct - 1, 0), row("after", ct + 1, 0)]),
    );
    const { code, out } = runCli(["--repo", repo]);
    assert.equal(code, 0);
    assert.equal(out.trim(), "Proof: `after` -> exit 0");
    assert.equal(runCli(["--repo", repo, "--since", "no-such-ref"]).code, 2);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
