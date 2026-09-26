#!/usr/bin/env node
/**
 * The kit's own end-to-end verification.
 *
 * It generates a site from the template and runs the oracles against it, which
 * means the template and the generator are themselves under test: there is no
 * separate hand-maintained fixture to drift away from what clients receive.
 *
 * The generated site is disposable. Visual baselines live with it, so they are
 * regenerated on each run and are not a regression signal here — that belongs to
 * a real client project, where the baseline is committed.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const KIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(KIT_ROOT, "bin", "spa-kit.mjs");
const BRIEF = join(KIT_ROOT, "tests", "fixtures", "self-test-brief.json");

function run(args, options = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CLI, ...args], { stdio: "inherit", ...options });
    // Without an error handler a failed spawn never settles and the run hangs.
    child.on("error", (err) => {
      process.stderr.write(`self-test: could not start the CLI — ${err.message}\n`);
      resolvePromise(127);
    });
    child.on("close", (code) => resolvePromise(code ?? 1));
  });
}

// A failed run's output is the only evidence of why, so it is kept: CI uploads
// it as an artifact, and locally it is what you go and read.
const keepAlways = process.argv.includes("--keep");
const dir = join(await mkdtemp(join(tmpdir(), "spa-kit-self-test-")), "site");

try {
  process.stdout.write(`self-test · generating into ${dir}\n`);
  const created = await run(["new", dir, `--brief=${BRIEF}`, "--port=4321"]);
  if (created !== 0) {
    process.stdout.write("self-test FAILED: generation\n");
    process.exitCode = 1;
  } else {
    const verified = await run(["verify", dir]);
    process.exitCode = verified;
    process.stdout.write(`self-test ${verified === 0 ? "PASSED" : `FAILED (exit ${verified})`}\n`);
  }
} finally {
  const failed = process.exitCode !== 0;
  if (keepAlways || failed) {
    process.stdout.write(`kept for inspection: ${dir}\n`);
  } else {
    await rm(dirname(dir), { recursive: true, force: true });
  }
}
