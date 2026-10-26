#!/usr/bin/env node
/**
 * Quality-Kernel DRY gate.
 *
 * Turns a jscpd JSON report into a pass/fail verdict, so "remove duplication" is a
 * forcing function instead of an instruction. Produce the report with:
 *
 *   jscpd --reporters json --silent --output <dir> <paths>
 *   # -> <dir>/jscpd-report.json
 *
 * A clone is a violation when it touches one of `--files` (differential mode: only the
 * files the change touched), or any clone at all when `--files` is omitted.
 * `--max-percent` additionally fails the run when the repo-wide duplicated-lines
 * percentage exceeds it.
 *
 * jscpd detects token-level clones (exact, or with renamed identifiers in its default
 * mode). It does not score structural near-duplicates by similarity.
 *
 * Fail-closed: a report whose shape this gate does not recognize is exit 2, never a pass.
 *
 * Usage:
 *   node dry-gate.mjs --input jscpd-report.json [--files a.ts,b.ts] [--max-percent 3] [--json]
 * Exit code: 0 no violation, 1 violation(s), 2 invalid input or arguments.
 */
import { readFileSync } from "node:fs";
import { isMain } from "./is-main.mjs";

export function parseArgs(argv) {
  const args = { input: null, files: null, maxPercent: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--input") args.input = argv[++i];
    else if (a === "--files") args.files = String(argv[++i] ?? "").split(",").map((f) => f.trim()).filter(Boolean);
    else if (a === "--max-percent") args.maxPercent = Number(argv[++i]);
    else if (a === "--json") args.json = true;
    else if (a === "--help" || a === "-h") args.help = true;
  }
  return args;
}

export function normalizePath(p) {
  return String(p).replace(/\\/g, "/").replace(/^(\.\/)+/, "");
}

// A report path and a requested path name the same file when equal, or when one is a
// path-suffix of the other (jscpd reports paths relative to its own cwd). Matching on
// suffix in both directions can over-match; over-matching fails, which is the safe side.
export function samePath(a, b) {
  const x = normalizePath(a);
  const y = normalizePath(b);
  return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`);
}

function isSide(side) {
  return side !== null && typeof side === "object" && typeof side.name === "string";
}

export function validateReport(report) {
  if (report === null || typeof report !== "object" || !Array.isArray(report.duplicates)) {
    return "report must be an object with a `duplicates` array (jscpd json reporter)";
  }
  for (const [i, d] of report.duplicates.entries()) {
    if (d === null || typeof d !== "object" || !isSide(d.firstFile) || !isSide(d.secondFile)) {
      return `duplicates[${i}] lacks firstFile.name / secondFile.name`;
    }
  }
  return null;
}

function lineOf(side, key) {
  const loc = side[`${key}Loc`];
  return side[key] ?? (loc && loc.line) ?? "?";
}

export function describeClone(d) {
  const a = d.firstFile;
  const b = d.secondFile;
  return {
    lines: Number(d.lines) || 0,
    tokens: Number(d.tokens) || 0,
    first: `${normalizePath(a.name)}:${lineOf(a, "start")}-${lineOf(a, "end")}`,
    second: `${normalizePath(b.name)}:${lineOf(b, "start")}-${lineOf(b, "end")}`,
  };
}

export function findViolations(report, files) {
  const clones = report.duplicates.filter(
    (d) => !files || files.some((f) => samePath(d.firstFile.name, f) || samePath(d.secondFile.name, f)),
  );
  return clones.map(describeClone);
}

function fail(message) {
  console.error(`[dry-gate] ${message}`);
  process.exit(2);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.input) {
    console.error("Usage: node dry-gate.mjs --input <jscpd-report.json> [--files a,b] [--max-percent N] [--json]");
    process.exit(args.help ? 0 : 2);
  }
  if (args.maxPercent !== null && !Number.isFinite(args.maxPercent)) {
    fail(`invalid --max-percent (must be a number): ${args.maxPercent}`);
  }
  if (args.files !== null && args.files.length === 0) {
    fail("--files was given but names no file");
  }

  let report;
  try {
    report = JSON.parse(readFileSync(args.input, "utf8"));
  } catch (err) {
    fail(`cannot read ${args.input}: ${err.message}`);
  }
  const shapeError = validateReport(report);
  if (shapeError) fail(shapeError);

  let percentage = null;
  if (args.maxPercent !== null) {
    percentage = Number(report.statistics?.total?.percentage);
    if (!Number.isFinite(percentage)) fail("--max-percent needs statistics.total.percentage in the report");
  }

  const clones = findViolations(report, args.files);
  const overPercent = percentage !== null && percentage > args.maxPercent;

  if (args.json) {
    console.log(JSON.stringify({ files: args.files, maxPercent: args.maxPercent, percentage, overPercent, clones }, null, 2));
  } else {
    for (const c of clones) {
      console.log(`CLONE ${c.lines} lines (${c.tokens} tokens)\t${c.first} <-> ${c.second}`);
    }
    if (overPercent) console.log(`Duplicated lines ${percentage}% exceed --max-percent ${args.maxPercent}.`);
    const scope = args.files ? `touching ${args.files.length} file(s)` : "in the report";
    console.log(`\n${clones.length} clone(s) ${scope}.`);
  }

  process.exit(clones.length > 0 || overPercent ? 1 : 0);
}

// Run as CLI only when invoked directly, so the module can be imported for tests.
if (isMain(import.meta.url)) {
  main();
}
