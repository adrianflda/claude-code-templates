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

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

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

function suiteEnv() {
  const env = { ...process.env };
  for (const k of GIT_LOCATION_VARS) delete env[k];
  // Inherited from a parent `node --test`, this turns the child runner into a reporter that exits 0
  // even when its tests fail: a push made from inside a test run would pass a red suite.
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function runSuites(sha) {
  const dir = mkdtempSync(join(tmpdir(), "qk-prepush-wt-"));
  const tree = join(dir, "tree");
  git("worktree", "add", "--quiet", "--detach", tree, sha);
  try {
    const failures = [];
    for (const suite of SUITES) {
      const r = spawnSync(suite.cmd, { shell: true, cwd: join(tree, KERNEL), env: suiteEnv(), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
      if (r.status === 0) process.stderr.write(`[quality-kernel] ${suite.name}: pass\n`);
      else failures.push({ suite, tail: out.trim().split("\n").slice(-25).join("\n") });
    }
    return failures;
  } finally {
    git("worktree", "remove", "--force", tree);
    rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
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
    for (const { suite, tail } of runSuites(sha)) {
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
  main();
}
