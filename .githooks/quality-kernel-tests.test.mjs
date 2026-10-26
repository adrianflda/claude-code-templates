import "../plugins/quality-kernel/scripts/hermetic-git.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ZERO, parsePushLines, touchesKernel } from "./quality-kernel-tests.mjs";

const SCRIPT = fileURLToPath(new URL("./quality-kernel-tests.mjs", import.meta.url));
const A = "a".repeat(40);
const B = "b".repeat(40);

test("parsePushLines: reads git's pre-push stdin, skipping deletions", () => {
  const lines = `refs/heads/x ${A} refs/heads/x ${B}\nrefs/heads/gone ${ZERO} refs/heads/gone ${B}\n\n`;
  assert.deepEqual(parsePushLines(lines), [{ localRef: "refs/heads/x", localSha: A, remoteRef: "refs/heads/x", remoteSha: B }]);
});

test("touchesKernel: only paths under plugins/quality-kernel/ count", () => {
  assert.equal(touchesKernel(["plugins/quality-kernel/scripts/route.mjs"]), true);
  assert.equal(touchesKernel(["docs/a.md", "plugins/pre-push-review/x.mjs"]), false);
  assert.equal(touchesKernel(["plugins/quality-kernel-old/x"]), false);
  assert.equal(touchesKernel([]), false);
});

// A throwaway repo with a fake kernel whose suites pass or fail on demand, pushed to a bare remote.
function fixture(kernelPasses, { hookSuitePasses = true, nodeTest = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "qk-prepush-"));
  const repo = join(root, "repo");
  const remote = join(root, "remote.git");
  const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: "pipe" });
  execFileSync("git", ["init", "-q", "--bare", remote]);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "README.md"), "x\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "init");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-q", "origin", "main");
  const kernel = join(repo, "plugins", "quality-kernel");
  mkdirSync(join(kernel, "scripts"), { recursive: true });
  mkdirSync(join(kernel, "hooks"), { recursive: true });
  writeFileSync(join(kernel, "scripts", "a.test.mjs"), nodeTest ?? `import { test } from "node:test"; test("k", () => { if (${!kernelPasses}) throw new Error("red"); });\n`);
  writeFileSync(join(kernel, "hooks", "test_hooks.py"), hookSuitePasses ? "print('ok')\n" : "import sys\nsys.exit(1)\n");
  mkdirSync(join(repo, ".githooks"));
  writeFileSync(join(repo, ".githooks", "pre-push"), `#!/bin/sh\nexec node ${JSON.stringify(SCRIPT)} "$@"\n`, { mode: 0o755 });
  git(repo, "config", "core.hooksPath", ".githooks");
  return { root, repo, git };
}

const push = (repo, ...args) => spawnSync("git", ["-C", repo, "push", ...args], { encoding: "utf8" });
const pushWith = (env, repo, ...args) => spawnSync("git", ["-C", repo, "push", ...args], { encoding: "utf8", env: { ...process.env, ...env } });

test("hook: a push that touches the kernel runs its suites and is blocked when they fail", () => {
  const { root, repo, git } = fixture(false);
  try {
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "kernel change");
    const r = push(repo, "origin", "main");
    assert.notEqual(r.status, 0, r.stderr);
    assert.match(r.stderr, /quality-kernel/);
    assert.equal(git(repo, "rev-parse", "origin/main").trim() === git(repo, "rev-parse", "HEAD").trim(), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hook: green suites let the push through", () => {
  const { root, repo, git } = fixture(true);
  try {
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "kernel change");
    const r = push(repo, "origin", "main");
    assert.equal(r.status, 0, r.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hook: the suites run on the pushed commit, not on the working tree", () => {
  const { root, repo, git } = fixture(false); // the committed kernel is red
  try {
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "red kernel");
    // fix it in the working tree only, without committing: the push must still be blocked
    writeFileSync(join(repo, "plugins", "quality-kernel", "scripts", "a.test.mjs"), `import { test } from "node:test"; test("k", () => {});\n`);
    assert.notEqual(push(repo, "origin", "main").status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hook: a push that does not touch the kernel skips the suites", () => {
  const { root, repo, git } = fixture(false); // red kernel, but uncommitted and untouched by the push
  try {
    rmSync(join(repo, "plugins"), { recursive: true, force: true });
    writeFileSync(join(repo, "README.md"), "y\n");
    git(repo, "commit", "-qam", "docs only");
    const r = push(repo, "origin", "main");
    assert.equal(r.status, 0, r.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hook: a red hook suite blocks the push too", () => {
  const { root, repo, git } = fixture(true, { hookSuitePasses: false });
  try {
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "kernel change");
    const r = push(repo, "origin", "main");
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /hook suite FAILED/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hook: a suite that hangs is killed with its whole process tree and blocks the push", () => {
  const root0 = mkdtempSync(join(tmpdir(), "qk-prepush-pid-"));
  const pidFile = join(root0, "pid");
  // The test-file process (a child of `node --test`) records its pid, then hangs.
  const hang = `import { test } from "node:test"; import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
test("hang", () => new Promise((r) => setTimeout(r, 120000)));\n`;
  const { root, repo, git } = fixture(true, { nodeTest: hang });
  try {
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "kernel change");
    const started = Date.now();
    const r = pushWith({ QK_PREPUSH_SUITE_TIMEOUT_MS: "1500" }, repo, "origin", "main");
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /timed out/);
    assert.ok(Date.now() - started < 30000, "the push must not wait for the hung test");
    const pid = Number(readFileSync(pidFile, "utf8"));
    assert.ok(pid > 0);
    assert.throws(() => process.kill(pid, 0), "the hung test process must be dead, not orphaned");
    assert.doesNotMatch(git(repo, "worktree", "list"), /qk-prepush-wt/); // cleaned up
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(root0, { recursive: true, force: true });
  }
});

test("hook: a new branch with no kernel change skips, even when the remote already holds a red kernel", () => {
  const { root, repo, git } = fixture(false);
  try {
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "red kernel");
    assert.equal(push(repo, "--no-verify", "origin", "main").status, 0); // red kernel reaches the remote
    git(repo, "switch", "-qc", "docs");
    writeFileSync(join(repo, "README.md"), "docs\n");
    git(repo, "commit", "-qam", "docs only");
    const r = push(repo, "origin", "docs");
    assert.equal(r.status, 0, r.stderr); // only the new commit is judged, and it does not touch the kernel
    assert.doesNotMatch(r.stderr, /running its suites/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hook: a new branch is compared against what the remote already has", () => {
  const { root, repo, git } = fixture(false);
  try {
    git(repo, "switch", "-qc", "feature");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "kernel change on a new branch");
    assert.notEqual(push(repo, "origin", "feature").status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("gate: a crash blocks the push (fail-closed)", () => {
  const bogus = "f".repeat(40); // git worktree add cannot check this commit out
  const r = spawnSync("node", [SCRIPT, "origin"], { input: `refs/heads/x ${bogus} refs/heads/x ${ZERO}\n`, encoding: "utf8", cwd: fileURLToPath(new URL("..", import.meta.url)) });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /blocked/);
});

test("gate: Ctrl-C during a suite kills the suite's process tree and removes the worktree", async () => {
  const root0 = mkdtempSync(join(tmpdir(), "qk-prepush-pid-"));
  const pidFile = join(root0, "pid");
  const hang = `import { test } from "node:test"; import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
test("hang", () => new Promise((r) => setTimeout(r, 120000)));\n`;
  const { root, repo, git } = fixture(true, { nodeTest: hang });
  try {
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "kernel change");
    const sha = git(repo, "rev-parse", "HEAD").trim();
    const remoteSha = git(repo, "rev-parse", "origin/main").trim();
    const child = spawn("node", [SCRIPT, "origin"], { cwd: repo, stdio: ["pipe", "ignore", "pipe"] });
    child.stdin.end(`refs/heads/main ${sha} refs/heads/main ${remoteSha}\n`);
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 100));
    const pid = Number(readFileSync(pidFile, "utf8"));
    child.kill("SIGINT");
    const code = await new Promise((r) => child.on("close", r));
    assert.notEqual(code, 0);
    await new Promise((r) => setTimeout(r, 500));
    assert.throws(() => process.kill(pid, 0), "the suite must die with the interrupted gate");
    assert.doesNotMatch(git(repo, "worktree", "list"), /qk-prepush-wt/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(root0, { recursive: true, force: true });
  }
});
