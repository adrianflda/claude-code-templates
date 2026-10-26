#!/usr/bin/env node
// Local pre-push gate for plugins/quality-kernel (no CI runs these suites; this hook is the gate).
//
// Called by .githooks/pre-push with git's pre-push arguments (<remote> <url>) and stdin
// (<local ref> <local sha> <remote ref> <remote sha> per line). When a pushed commit range
// touches plugins/quality-kernel/, it checks out the PUSHED commit in a temporary worktree and runs:
//   node --test scripts/*.test.mjs     (the Node suite)
//   python3 hooks/test_hooks.py        (the hook suite)
// Any failure blocks the push. The suites run on the pushed commit, never on the working tree, so
// an uncommitted fix cannot green a red commit. Enable once per clone: git config core.hooksPath .githooks
// Bypass (not recommended): git push --no-verify.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRunner } from "../plugins/quality-kernel/scripts/process-safety/proc-runner.mjs";

export const ZERO = "0".repeat(40);
const KERNEL = "plugins/quality-kernel/";
const SUITES = [
  { name: "Node suite", cmd: "node --test scripts/*.test.mjs" },
  { name: "hook suite", cmd: "python3 hooks/test_hooks.py" },
];
// A suite that inherits these would run its fixture repos against this repository instead of their
// own temp dirs. Observed on Apple git: pre-push gets GIT_PREFIX only (plus GIT_EXEC_PATH,
// GIT_EDITOR); the rest are removed defensively, for other git builds and wrappers.
const GIT_LOCATION_VARS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_PREFIX", "GIT_QUARANTINE_PATH", "GIT_COMMON_DIR"];

export function parsePushLines(text) {
  return String(text)
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length === 4 && p[1] !== ZERO)
    .map(([localRef, localSha, remoteRef, remoteSha]) => ({ localRef, localSha, remoteRef, remoteSha }));
}

export function touchesKernel(paths) {
  return paths.some((p) => p.startsWith(KERNEL));
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// Paths changed by the commits this update sends. null = cannot tell (the caller then runs the suites).
function changedPaths({ localSha, remoteSha }, remote) {
  try {
    if (remoteSha !== ZERO) return git("diff", "--name-only", `${remoteSha}..${localSha}`).split("\n").filter(Boolean);
    // New branch: every commit the remote does not have yet.
    return git("log", "--name-only", "--format=", localSha, "--not", `--remotes=${remote}`).split("\n").filter(Boolean);
  } catch {
    return null;
  }
}

// A hung test must not hold `git push` forever. 15 min per suite (the Node suite takes ~2 min);
// QK_PREPUSH_SUITE_TIMEOUT_MS overrides it (the hook's own tests use a short one).
const DEFAULT_SUITE_TIMEOUT_MS = 15 * 60 * 1000;
function suiteTimeoutMs() {
  const v = Number(process.env.QK_PREPUSH_SUITE_TIMEOUT_MS);
  return Number.isInteger(v) && v > 0 ? v : DEFAULT_SUITE_TIMEOUT_MS;
}

function suiteEnv() {
  const env = { ...process.env };
  for (const k of GIT_LOCATION_VARS) delete env[k];
  // Inherited from a parent `node --test`, this turns the child runner into a reporter that exits 0
  // even when its tests fail: a push made from inside a test run would pass a red suite.
  delete env.NODE_TEST_CONTEXT;
  return env;
}

// Each suite runs through the kernel's own process-safety runner: its own process group, SIGTERM
// then SIGKILL to the whole group on timeout, and a sweep of every process carrying the run marker,
// so a hung test cannot outlive the push (a plain spawnSync timeout orphaned the test-file child).
async function runSuites(sha) {
  const dir = mkdtempSync(join(tmpdir(), "qk-prepush-wt-"));
  const tree = join(dir, "tree");
  const runId = `prepush-${process.pid}-${Date.now()}`;
  const runner = createRunner({ runId, env: { ...suiteEnv(), QK_RUN_ID: runId }, timeoutMs: suiteTimeoutMs(), graceMs: 2000 });
  git("worktree", "add", "--quiet", "--detach", tree, sha);
  try {
    const failures = [];
    for (const [i, suite] of SUITES.entries()) {
      const log = join(dir, `suite-${i}.log`);
      const r = await runner.run(`${suite.cmd} > '${log}' 2>&1`, join(tree, KERNEL));
      let out = "";
      try {
        out = readFileSync(log, "utf8");
      } catch {
        /* the suite never started */
      }
      const tail = (n) => out.trim().split("\n").slice(-n).join("\n");
      if (r.code === 0 && !r.timedOut) process.stderr.write(`[quality-kernel] ${suite.name}: pass\n`);
      else if (r.timedOut) failures.push({ suite, tail: `timed out after ${suiteTimeoutMs()} ms\n${tail(10)}` });
      else failures.push({ suite, tail: r.error ? String(r.error.message) : tail(25) });
    }
    return failures;
  } finally {
    git("worktree", "remove", "--force", tree);
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const remote = process.argv[2] || "origin";
  const updates = parsePushLines(readFileSync(0, "utf8"));
  const shas = [...new Set(updates.filter((u) => {
    const paths = changedPaths(u, remote);
    return paths === null || touchesKernel(paths);
  }).map((u) => u.localSha))];
  if (shas.length === 0) process.exit(0);

  let blocked = false;
  for (const sha of shas) {
    process.stderr.write(`[quality-kernel] push touches ${KERNEL}: running its suites on ${sha.slice(0, 12)}\n`);
    for (const { suite, tail } of await runSuites(sha)) {
      blocked = true;
      process.stderr.write(`[quality-kernel] ${suite.name} FAILED (${suite.cmd}):\n${tail}\n`);
    }
  }
  if (blocked) {
    process.stderr.write("[quality-kernel] push blocked: fix the failing suite and commit (bypass: git push --no-verify, not recommended)\n");
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    process.stderr.write(`[quality-kernel] pre-push gate crashed, push blocked: ${err && err.message ? err.message : err}\n`);
    process.exit(1);
  });
}
