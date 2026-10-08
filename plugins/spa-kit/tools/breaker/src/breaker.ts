#!/usr/bin/env tsx
import { readFile } from "node:fs/promises";
import { parse } from "node-html-parser";
import { parseContract, type Contract, type Invariant } from "./contract.ts";
import { vectorsFor, type Vector } from "./vectors.ts";

type Verdict = "BREAKER_PASS" | "BREAKER_FAIL" | "BREAKER_INCONCLUSIVE";

interface Attempt {
  invariant: string;
  vector: string;
  rationale: string;
  url: string;
  /** True when this vector falsified the claim. */
  falsified: boolean;
  /** Verbatim observation. Never a restatement of the rule. */
  evidence: string;
}

function visibleText(html: string): string {
  const doc = parse(html);
  for (const el of doc.querySelectorAll("script, style, noscript, template")) el.remove();
  return doc.structuredText.replace(/\s+/g, " ").trim();
}

async function runVector(
  base: string,
  inv: Invariant,
  vector: Vector,
): Promise<Attempt> {
  const seed = {
    invariant: inv.id,
    vector: vector.name,
    rationale: vector.rationale,
  };

  let url: string;
  try {
    url = new URL(vector.transformRoute(inv.route), base).toString();
  } catch (err) {
    // A vector that cannot even be addressed is a defect in the vector, not a
    // property of the system under test. Report it; never take the process down.
    return {
      ...seed,
      url: `${base}${inv.route}`,
      falsified: false,
      evidence: `vector produced an unusable URL, skipped: ${String(err)}`,
    };
  }

  let res: Response;
  let body = "";
  try {
    res = await fetch(url, { method: vector.method, headers: vector.headers, redirect: "follow" });
    if (!vector.bodyless) body = await res.text();
  } catch (err) {
    return { ...seed, url, falsified: true, evidence: `request threw: ${String(err)}` };
  }

  const problems: string[] = [];
  const { expect } = inv;

  if (expect.status !== undefined && res.status !== expect.status) {
    problems.push(`status ${res.status}, contract says ${expect.status}`);
  }
  // A redirect that lands somewhere else silently breaks canonicalisation.
  if (res.redirected && new URL(res.url).pathname !== new URL(url).pathname) {
    problems.push(`redirected to ${res.url}`);
  }

  for (const [name, expected] of Object.entries(expect.headers ?? {})) {
    const actual = res.headers.get(name);
    if (actual === null) problems.push(`header "${name}" absent`);
    else if (!actual.toLowerCase().includes(expected.toLowerCase())) {
      problems.push(`header "${name}" = "${actual}", expected to contain "${expected}"`);
    }
  }

  if (!vector.bodyless) {
    for (const needle of expect.bodyIncludes ?? []) {
      if (!body.includes(needle)) problems.push(`body is missing "${needle}"`);
    }
    for (const needle of expect.bodyExcludes ?? []) {
      if (body.includes(needle)) problems.push(`body leaks "${needle}"`);
    }
    if (expect.selectors?.length) {
      const doc = parse(body);
      for (const selector of expect.selectors) {
        if (doc.querySelectorAll(selector).length === 0) {
          problems.push(`selector "${selector}" matched nothing`);
        }
      }
    }
    if (expect.minVisibleText !== undefined) {
      const text = visibleText(body);
      if (text.length < expect.minVisibleText) {
        problems.push(
          `only ${text.length} chars of visible text (contract requires ${expect.minVisibleText})`,
        );
      }
    }
  }

  return problems.length > 0
    ? { ...seed, url, falsified: true, evidence: problems.join("; ") }
    : {
        ...seed,
        url,
        falsified: false,
        evidence: `HTTP ${res.status}${vector.bodyless ? "" : `, ${body.length} bytes`} — claim held`,
      };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const get = (name: string): string | undefined =>
    argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");

  const base = get("base") ?? process.env["KIT_BASE_URL"] ?? "http://localhost:4321";
  const contractPath = get("contract");
  const asJson = argv.includes("--json");

  if (!contractPath) {
    process.stderr.write("BREAKER_INCONCLUSIVE: --contract=<path.json> is required\n");
    process.exitCode = 2;
    return;
  }

  let contract: Contract;
  try {
    contract = parseContract(await readFile(contractPath, "utf8"));
  } catch (err) {
    process.stderr.write(`BREAKER_INCONCLUSIVE: unusable contract — ${String(err)}\n`);
    process.exitCode = 2;
    return;
  }

  // Reachability first: an unreachable target is inconclusive, never a pass.
  try {
    const probe = await fetch(base, { method: "GET", redirect: "follow" });
    if (probe.status >= 500) throw new Error(`origin returned HTTP ${probe.status}`);
  } catch (err) {
    process.stderr.write(`BREAKER_INCONCLUSIVE: ${base} unreachable — ${String(err)}\n`);
    process.exitCode = 2;
    return;
  }

  const attempts: Attempt[] = [];
  for (const inv of contract.invariants) {
    for (const vector of vectorsFor(inv)) {
      attempts.push(await runVector(base, inv, vector));
    }
  }

  const broken = attempts.filter((a) => a.falsified);
  const verdict: Verdict = broken.length === 0 ? "BREAKER_PASS" : "BREAKER_FAIL";

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ verdict, contract: contract.name, attempts }, null, 2)}\n`);
  } else {
    process.stdout.write(`breaker · contract "${contract.name}" · base ${base}\n\n`);
    for (const a of attempts) {
      process.stdout.write(
        `[${a.falsified ? "BROKEN" : "  ok  "}] ${a.invariant} / ${a.vector}\n` +
          `         ${a.url}\n         ${a.evidence}\n` +
          (a.falsified ? `         why this vector: ${a.rationale}\n` : ""),
      );
    }
    process.stdout.write(
      `\n${verdict} — ${attempts.length - broken.length}/${attempts.length} vectors failed to falsify the contract\n`,
    );
  }

  process.exitCode = verdict === "BREAKER_PASS" ? 0 : 1;
}

await main();
