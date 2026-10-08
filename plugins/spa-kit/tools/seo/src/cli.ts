#!/usr/bin/env tsx
import { agenticSuite } from "./agentic.ts";
import { indexabilitySuite } from "./indexability.ts";
import { structuredDataSuite } from "./structured-data.ts";
import type { Suite } from "./types.ts";

/**
 * Executable SEO/AEO gate.
 *
 * Exits 1 on any non-advisory failure so it can sit in `verify` and in CI. It
 * reports what it observed, never what it assumes: each line carries evidence.
 */
interface Args {
  base: string;
  canonicalBase: string;
  lang: string | undefined;
  routes: string[];
  only: string[];
  json: boolean;
  minText: number;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined =>
    argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");

  const base = get("base") ?? process.env["KIT_BASE_URL"] ?? "http://localhost:4321";
  return {
    base,
    canonicalBase: get("canonical-base") ?? process.env["KIT_CANONICAL_BASE"] ?? base,
    lang: get("lang") ?? process.env["KIT_LANG"],
    routes: (get("routes") ?? "/").split(",").map((r) => r.trim()).filter(Boolean),
    only: (get("only") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    json: argv.includes("--json"),
    minText: Number(get("min-text") ?? 300),
  };
}

const ICON = { pass: "  ok  ", fail: " FAIL ", advisory: " note " } as const;

function render(suites: Suite[]): { failures: number; advisories: number } {
  let failures = 0;
  let advisories = 0;

  for (const suite of suites) {
    process.stdout.write(`\n${suite.name}\n${"-".repeat(suite.name.length)}\n`);
    for (const check of suite.checks) {
      const state = check.passed ? "pass" : check.advisory ? "advisory" : "fail";
      if (state === "fail") failures += 1;
      if (state === "advisory") advisories += 1;
      process.stdout.write(`[${ICON[state]}] ${check.id} · ${check.target}\n         ${check.evidence}\n`);
    }
  }
  return { failures, advisories };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const wanted = (name: string): boolean => args.only.length === 0 || args.only.includes(name);

  process.stdout.write(
    `kit-seo · base=${args.base}` +
      (args.canonicalBase === args.base ? "" : ` · canonical=${args.canonicalBase}`) +
      ` · routes=${args.routes.join(", ")}\n`,
  );

  const suites: Suite[] = [];
  if (wanted("indexability")) {
    suites.push(await indexabilitySuite(args.base, args.routes, args.canonicalBase));
  }
  if (wanted("schema")) suites.push(await structuredDataSuite(args.base, args.routes));
  if (wanted("agentic")) {
    suites.push(
      await agenticSuite({
        baseUrl: args.base,
        routes: args.routes,
        canonicalBase: args.canonicalBase,
        ...(args.lang ? { expectedLang: args.lang } : {}),
        minVisibleText: args.minText,
      }),
    );
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(suites, null, 2)}\n`);
  }

  const { failures, advisories } = render(suites);
  const total = suites.reduce((n, s) => n + s.checks.length, 0);
  process.stdout.write(
    `\n${total - failures - advisories} passed · ${failures} failed · ${advisories} advisory\n`,
  );
  process.exitCode = failures > 0 ? 1 : 0;
}

await main();
