import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeVerdict,
  exitCodeFor,
  classifyDependencies,
  summariseOutput,
  isAutomatableRemedy,
  selectAutomatable,
} from "../bin/lib/verify-logic.mjs";

test("computeVerdict: everything passing is PASSED", () => {
  assert.equal(computeVerdict([{ passed: true }, { passed: true }]), "PASSED");
  assert.equal(computeVerdict([]), "PASSED");
});

test("computeVerdict: an inconclusive step among passes is INCONCLUSIVE", () => {
  assert.equal(
    computeVerdict([{ passed: true }, { passed: false, inconclusive: true }]),
    "INCONCLUSIVE",
  );
});

test("computeVerdict: a proven failure outranks an inconclusive step", () => {
  // The whole point of the distinction: an unreachable target must not mask a
  // contract that was actually falsified.
  assert.equal(
    computeVerdict([{ passed: false, inconclusive: true }, { passed: false }]),
    "FAILED",
  );
  assert.equal(computeVerdict([{ passed: false }, { passed: true }]), "FAILED");
});

test("exitCodeFor: inconclusive is never 0", () => {
  assert.equal(exitCodeFor("PASSED"), 0);
  assert.equal(exitCodeFor("FAILED"), 1);
  assert.equal(exitCodeFor("INCONCLUSIVE"), 2);
});

test("classifyDependencies: a symlinked tree fails and is never auto-fixed", () => {
  const v = classifyDependencies({
    exists: true,
    isSymlink: true,
    missing: [],
    modulesPath: "/p/node_modules",
    kitRoot: "/p",
  });
  assert.equal(v.ok, false);
  assert.equal(v.automatable, false, "removing a path must not be automated");
  assert.match(v.detail, /symlink/);
  assert.match(v.remedy, /^unlink /);
});

test("classifyDependencies: an unreadable path is its own outcome, not 'missing'", () => {
  const v = classifyDependencies({
    statError: Object.assign(new Error("permission denied"), { code: "EACCES" }),
    modulesPath: "/p/node_modules",
    kitRoot: "/p",
  });
  assert.equal(v.ok, false);
  assert.equal(v.automatable, false, "an install would mask the real cause");
  assert.match(v.detail, /EACCES/);
  assert.doesNotMatch(v.detail, /missing/);
  assert.match(v.remedy, /resolve access/);
});

test("classifyDependencies: an unreadable path outranks every other signal", () => {
  // Whatever else is true, we could not look: say so rather than guess.
  const v = classifyDependencies({
    statError: Object.assign(new Error("io"), { code: "EIO" }),
    isSymlink: true,
    missing: ["tsx"],
    modulesPath: "/p/node_modules",
    kitRoot: "/p",
  });
  assert.match(v.detail, /EIO/);
  assert.equal(v.ok, false);
  assert.equal(v.automatable, false);
  assert.match(v.remedy, /resolve access/);
});

test("classifyDependencies: a DANGLING symlink still fails", () => {
  // existsSync follows links, so a symlink to a deleted target looks like
  // exists:false while still being a link. Requiring both once made this
  // combination fall through and report a broken tree as healthy.
  const v = classifyDependencies({
    exists: false,
    isSymlink: true,
    missing: [],
    modulesPath: "/p/node_modules",
    kitRoot: "/p",
  });
  assert.equal(v.ok, false, "a dangling symlink must never report healthy");
  assert.equal(v.automatable, false);
  assert.match(v.detail, /symlink/);
});

test("classifyDependencies: missing packages fail and are auto-fixable", () => {
  const v = classifyDependencies({
    exists: true,
    isSymlink: false,
    missing: ["tsx", "node-html-parser"],
    modulesPath: "/p/node_modules",
    kitRoot: "/p",
  });
  assert.equal(v.ok, false);
  assert.equal(v.automatable, true);
  assert.match(v.detail, /tsx, node-html-parser/);
  assert.match(v.remedy, /^npm install/);
});

test("classifyDependencies: a complete tree passes", () => {
  const v = classifyDependencies({ exists: true, isSymlink: false, missing: [] });
  assert.equal(v.ok, true);
  assert.equal(v.remedy, undefined);
});

test("summariseOutput: returns the oracle's own summary when it matches", () => {
  const out = "noise\n29 passed · 0 failed · 0 advisory\nmore noise";
  assert.equal(
    summariseOutput(out, /(\d+ passed · \d+ failed · \d+ advisory)/),
    "29 passed · 0 failed · 0 advisory",
  );
});

test("summariseOutput: prefers stderr over noisy stdout when the pattern misses", () => {
  // The crash shape this exists for: progress on stdout, the stack on stderr.
  const stdout = "Collecting page data...\nGenerating...";
  const stderr = "TypeError: cannot read properties of undefined\n  at foo (bar.js:1:1)";
  const detail = summariseOutput(stdout, /(\d+ passed)/, stderr);
  assert.match(detail, /TypeError/);
  assert.doesNotMatch(detail, /Collecting page data/);
});

test("summariseOutput: falls back to stdout when there is no stderr", () => {
  assert.match(summariseOutput("something went sideways", /(\d+ passed)/, ""), /sideways/);
});

test("summariseOutput: undefined when there is nothing to report", () => {
  assert.equal(summariseOutput("", /(\d+ passed)/, ""), undefined);
  assert.equal(summariseOutput(undefined, /(\d+ passed)/), undefined);
});

test("isAutomatableRemedy: only npm installs run unattended", () => {
  assert.equal(isAutomatableRemedy('npm install --prefix "/p"'), true);
  assert.equal(isAutomatableRemedy("npm run e2e:install"), true);
  // Anything that deletes a path must not be automated.
  assert.equal(isAutomatableRemedy('unlink "/p/node_modules" && npm install'), false);
  assert.equal(isAutomatableRemedy("install Node 24 or newer"), false);
  assert.equal(isAutomatableRemedy("reinstall the plugin"), false);
  assert.equal(isAutomatableRemedy(undefined), false);
  // "npm" without a space is not a command.
  assert.equal(isAutomatableRemedy("npmjs.com is down"), false);
});

test("selectAutomatable: picks failing automatable checks and nothing else", () => {
  const checks = [
    { name: "node", ok: true },
    { name: "deps", ok: false, automatable: true },
    { name: "link", ok: false, automatable: false },
    { name: "browsers", ok: false, automatable: true },
    { name: "template", ok: false },
  ];
  assert.deepEqual(
    selectAutomatable(checks).map((c) => c.name),
    ["deps", "browsers"],
  );
});

test("selectAutomatable: a passing check is never re-run", () => {
  assert.deepEqual(selectAutomatable([{ name: "deps", ok: true, automatable: true }]), []);
});
