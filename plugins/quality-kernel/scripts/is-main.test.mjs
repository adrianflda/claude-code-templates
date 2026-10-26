import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HELPER = fileURLToPath(new URL("./is-main.mjs", import.meta.url));
const SCRIPTS = fileURLToPath(new URL(".", import.meta.url));

function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), "qk-is-main-"));
  try {
    const real = join(root, "real");
    mkdirSync(real);
    writeFileSync(join(real, "tool.mjs"), `import { isMain } from ${JSON.stringify(pathToFileURL(HELPER).href)};\nconsole.log(isMain(import.meta.url) ? "MAIN" : "IMPORTED");\n`);
    writeFileSync(join(real, "importer.mjs"), `import "./tool.mjs";\n`);
    symlinkSync(real, join(root, "link"));
    return fn({ real, link: join(root, "link") });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const node = (...args) => spawnSync("node", args, { encoding: "utf8" }).stdout.trim();

test("isMain: true when run directly, including through a symlinked directory", () => {
  fixture(({ real, link }) => {
    assert.equal(node(join(real, "tool.mjs")), "MAIN");
    assert.equal(node(join(link, "tool.mjs")), "MAIN");
  });
});

test("isMain: false when the module is imported", () => {
  fixture(({ real, link }) => {
    assert.equal(node(join(real, "importer.mjs")), "IMPORTED");
    assert.equal(node(join(link, "importer.mjs")), "IMPORTED");
  });
});

test("isMain: a path realpath cannot resolve still matches itself (no fail-open on a realpath error)", async () => {
  const { isMain } = await import("./is-main.mjs");
  const ghost = join(tmpdir(), "qk-is-main-missing", "tool.mjs"); // does not exist: realpath throws
  const saved = process.argv[1];
  try {
    process.argv[1] = ghost;
    assert.equal(isMain(pathToFileURL(ghost).href), true);
    assert.equal(isMain(pathToFileURL(join(tmpdir(), "other.mjs")).href), false);
  } finally {
    process.argv[1] = saved;
  }
});

test("regression: a gate run through a symlink still runs and fails closed (was a silent exit 0)", () => {
  const root = mkdtempSync(join(tmpdir(), "qk-is-main-gate-"));
  try {
    symlinkSync(SCRIPTS, join(root, "scripts"));
    for (const [script, args] of [
      ["contract-review.mjs", ["--contract", "/nonexistent/spec.md"]],
      ["crap.mjs", ["--input", "/nonexistent/crap.json"]],
      ["dry-gate.mjs", ["--input", "/nonexistent/report.json"]],
    ]) {
      const r = spawnSync("node", [join(root, "scripts", script), ...args], { encoding: "utf8" });
      assert.equal(r.status, 2, `${script} via symlink: ${r.stdout}${r.stderr}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
