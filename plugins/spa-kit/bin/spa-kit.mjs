#!/usr/bin/env node
/**
 * spa-kit — generate and verify client SPAs.
 *
 * The toolchain stays here; what ships to a client is the site in its own
 * directory. A generated project has no dependency on this kit: it builds and
 * deploys on its own, and the oracles are run against it from the outside.
 *
 * Designed to be driven by an agent, so: never interactive, `--json` on every
 * command, and stable exit codes.
 *   0  success
 *   1  verification failed (the system under test is wrong)
 *   2  usage or environment error (the run is inconclusive, not a pass)
 */
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, readdir, cp } from "node:fs/promises";
import { existsSync, lstatSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { derivePalette, renderTokenBlock } from "./lib/palette.mjs";
import {
  normaliseBrief,
  renderContentModule,
  renderSiteModule,
  BRIEF_EXAMPLE,
} from "./lib/brief.mjs";
import { toHex } from "./lib/color.mjs";
import {
  computeVerdict,
  exitCodeFor,
  classifyDependencies,
  summariseOutput,
} from "./lib/verify-logic.mjs";
import { slugify, parseArgs, firstFreePort } from "./lib/util.mjs";

const KIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = join(KIT_ROOT, "templates", "spa");
const DEFAULT_PORT_BASE = 4400;

const EXIT = { ok: 0, failed: 1, usage: 2 };

// ---------------------------------------------------------------- utilities

function run(command, args, options = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
      cwd: options.cwd ?? process.cwd(),
      env: { ...process.env, ...options.env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => resolvePromise({ code: 127, stdout, stderr: String(err) }));
    child.on("close", (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
  });
}

async function waitForHttp(url, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: "GET" });
      if (res.status < 500) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

async function readProject(dir) {
  const configPath = join(dir, "spa-kit.json");
  if (!existsSync(configPath)) {
    throw new Error(`${dir} has no spa-kit.json — is it a generated project?`);
  }
  return JSON.parse(await readFile(configPath, "utf8"));
}

async function isEmptyish(dir) {
  if (!existsSync(dir)) return true;
  const entries = await readdir(dir);
  return entries.filter((e) => e !== ".git" && e !== ".DS_Store").length === 0;
}

// --------------------------------------------------------------------- new

async function cmdNew(positional, flags) {
  const target = positional[0];
  if (!target) throw new UsageError("spa-kit new <dir> --name=\"Acme\" --url=https://acme.com");

  const dir = resolve(target);
  if (!(await isEmptyish(dir)) && !flags.force) {
    throw new UsageError(`${dir} is not empty. Pass --force to generate into it anyway.`);
  }

  // A brief is the full input; flags are the shorthand for a simple site.
  let brief;
  if (flags.brief) {
    const raw = JSON.parse(await readFile(resolve(String(flags.brief)), "utf8"));
    brief = normaliseBrief(raw);
  } else {
    brief = normaliseBrief({
      business: {
        name: String(flags.name ?? basename(dir)),
        description: String(
          flags.description ??
            `${flags.name ?? basename(dir)} — a fast, server-rendered site that both search engines and AI answer engines can read.`,
        ),
        locale: String(flags.locale ?? "en_US"),
        url: String(flags.url ?? `http://localhost:${flags.port ?? DEFAULT_PORT_BASE}`),
      },
      brand: { color: String(flags.brand ?? "#2ee6d6"), mode: String(flags.mode ?? "dark") },
      hero: { headline: String(flags.headline ?? flags.name ?? basename(dir)) },
      sections: [],
    });
  }

  const name = brief.business.name;
  const slug = String(flags.slug ?? slugify(name) ?? "site");
  const url = brief.business.url;
  const port = Number(flags.port ?? (await nextFreePort(dir)));
  const description = brief.business.description;
  const headline = brief.hero.headline;
  const locale = brief.business.locale;

  const kitVersion = JSON.parse(await readFile(join(KIT_ROOT, "package.json"), "utf8")).version;

  const replacements = {
    __SPA_NAME__: name,
    __SPA_SLUG__: slug,
    __SPA_URL__: url.replace(/\/$/, ""),
    __SPA_PORT__: String(port),
    __SPA_DESCRIPTION__: description,
    __SPA_HEADLINE__: headline,
    __SPA_LOCALE__: locale,
    __SPA_CREATED__: new Date().toISOString().slice(0, 10),
    __SPA_KIT_VERSION__: kitVersion,
  };

  await mkdir(dir, { recursive: true });
  await cp(TEMPLATE, dir, { recursive: true });
  await substitute(dir, replacements);

  // Brand and content are materialised from the brief, not from placeholders.
  const { report } = await applyBrief(dir, brief);
  await writeFile(join(dir, "brief.json"), `${JSON.stringify(brief, null, 2)}\n`);

  const summary = {
    dir,
    name,
    slug,
    url: replacements.__SPA_URL__,
    port,
    brand: report.brand.hex,
    mode: report.mode,
    contrast: report.contrast,
    contrastTargetsMet: report.meetsTargets,
    ...(brief.warnings.length > 0 ? { warnings: brief.warnings } : {}),
  };

  if (flags.install !== false && flags.install !== "false") {
    const install = await run("npm", ["install", "--no-audit", "--no-fund"], { cwd: dir, capture: true });
    summary.installed = install.code === 0;
    if (install.code !== 0) summary.installError = install.stderr.trim().split("\n").slice(-3).join(" ");
  } else {
    summary.installed = false;
  }

  return summary;
}

/** Picks a port not already claimed by a sibling project. */
async function nextFreePort(dir) {
  const parent = dirname(dir);
  let used = new Set();
  try {
    for (const entry of await readdir(parent)) {
      const config = join(parent, entry, "spa-kit.json");
      if (existsSync(config)) {
        try {
          used.add(JSON.parse(await readFile(config, "utf8")).port);
        } catch {
          /* ignore unreadable sibling */
        }
      }
    }
  } catch {
    /* parent unreadable; fall back to the base port */
  }
  return firstFreePort(used, DEFAULT_PORT_BASE);
}

/** Replaces placeholders in every text file of the generated project. */
async function substitute(dir, replacements) {
  const skipDirs = new Set(["node_modules", ".next", ".git"]);
  const binary = /\.(png|jpg|jpeg|gif|webp|avif|ico|woff2?|ttf|otf|mp4|webm|zip)$/i;

  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) await walk(full);
        continue;
      }
      if (binary.test(entry.name)) continue;
      const original = await readFile(full, "utf8");
      let updated = original;
      for (const [token, value] of Object.entries(replacements)) {
        updated = updated.split(token).join(value);
      }
      if (updated !== original) await writeFile(full, updated);
    }
  }
  await walk(dir);
}



// ------------------------------------------------------------------ doctor

/**
 * Checks that this installation can actually run: Node version, the kit's own
 * dependencies, and Playwright's browsers. Installed as a plugin, none of these
 * are guaranteed, and an agent needs a clear answer rather than a stack trace
 * three commands later.
 */
async function cmdDoctor(_positional, flags) {
  const checks = [];
  const add = (name, ok, detail, remedy, automatable = remedy?.startsWith("npm") ?? false) =>
    checks.push({ name, ok, detail, ...(ok ? {} : { remedy, automatable }) });

  const major = Number(process.versions.node.split(".")[0]);
  add("node", major >= 24, `v${process.versions.node}`, "install Node 24 or newer");

  // A symlinked node_modules is worse than a missing one: `npm install` would
  // write through it into whatever it points at, silently mixing another
  // project's dependency tree with this one's.
  const modulesPath = join(KIT_ROOT, "node_modules");
  // lstat, not existsSync: existsSync follows links, so a symlink whose target
  // is gone would answer false and the link would go undetected — which is the
  // case that most needs reporting.
  let linked = false;
  try {
    linked = lstatSync(modulesPath).isSymbolicLink();
  } catch {
    linked = false; // absent entirely, which the missing-packages branch covers
  }

  const deps = ["tsx", "node-html-parser", "@playwright/test"];
  const depsVerdict = classifyDependencies({
    isSymlink: linked,
    missing: linked ? [] : deps.filter((d) => !existsSync(join(modulesPath, d))),
    modulesPath,
    kitRoot: KIT_ROOT,
  });
  const depsOk = depsVerdict.ok;
  add("dependencies", depsVerdict.ok, depsVerdict.detail, depsVerdict.remedy, depsVerdict.automatable);

  if (depsOk) {
    const browsers = await run("npx", ["playwright", "install", "--dry-run"], {
      cwd: KIT_ROOT,
      capture: true,
    });
    const text = `${browsers.stdout}${browsers.stderr}`;
    const installed = [...text.matchAll(/Install location:\s*(\S+)/g)].map((m) => m[1]);
    const present = installed.filter((p) => existsSync(p));
    add(
      "browsers",
      present.length >= 2,
      `${present.length}/${installed.length} playwright browsers present`,
      `npm run e2e:install --prefix "${KIT_ROOT}"`,
    );
  } else {
    add("browsers", false, "not checked (fix dependencies first)", "resolve the dependencies check");
  }

  add("template", existsSync(join(TEMPLATE, "package.json")), TEMPLATE, "reinstall the plugin");

  if (flags.fix) {
    // Only remedies that are plain npm installs are automated. Anything that
    // needs a path removed (the symlink case) is left to the operator on
    // purpose: deleting the wrong thing there damages another project.
    for (const check of checks.filter((c) => !c.ok && c.automatable)) {
      const [cmd, ...args] = check.remedy.replace(/"/g, "").split(" ");
      const result = await run(cmd, args, { capture: true });
      check.fixed = result.code === 0;
    }
  }

  return { root: KIT_ROOT, healthy: checks.every((c) => c.ok || c.fixed), checks };
}

// ------------------------------------------------------------------- brief

/**
 * Writes everything derived from the brief: the token ramp, the content module
 * and the site metadata. Re-runnable, so editing brief.json and re-applying is
 * the normal way to iterate.
 */
async function applyBrief(dir, brief) {
  const { tokens, report } = derivePalette(brief.brand.color, brief.brand.mode);

  // Re-render tokens.css from the pristine template so apply is idempotent.
  const template = await readFile(join(TEMPLATE, "design", "tokens.css"), "utf8");
  const css = template.replace("__SPA_TOKEN_BLOCK__", renderTokenBlock(tokens, brief.brand.mode));
  await writeFile(join(dir, "design", "tokens.css"), css);

  await writeFile(join(dir, "content.ts"), renderContentModule(brief));
  await writeFile(join(dir, "lib", "site.ts"), renderSiteModule(brief));

  // Light mode needs the document to say so, or the browser paints dark chrome.
  const layoutPath = join(dir, "app", "layout.tsx");
  let layout = await readFile(layoutPath, "utf8");
  const scheme = brief.brand.mode;
  layout = layout
    .replace(/colorScheme: "(dark|light)"/, `colorScheme: "${scheme}"`)
    .replace(/themeColor: "[^"]*"/, `themeColor: "${toHex(tokens.void)}"`);
  await writeFile(layoutPath, layout);

  const globalsPath = join(dir, "app", "globals.css");
  let globals = await readFile(globalsPath, "utf8");
  globals = globals.replace(/color-scheme: (dark|light);/, `color-scheme: ${scheme};`);
  await writeFile(globalsPath, globals);

  return { report };
}

async function cmdApply(positional, flags) {
  const dir = resolve(positional[0] ?? ".");
  const briefPath = flags.brief ? resolve(String(flags.brief)) : join(dir, "brief.json");
  if (!existsSync(briefPath)) throw new UsageError(`no brief at ${briefPath}`);

  const brief = normaliseBrief(JSON.parse(await readFile(briefPath, "utf8")));
  const { report } = await applyBrief(dir, brief);

  if (briefPath !== join(dir, "brief.json")) {
    await writeFile(join(dir, "brief.json"), `${JSON.stringify(brief, null, 2)}\n`);
  }

  return {
    dir,
    brand: report.brand.hex,
    mode: report.mode,
    contrast: report.contrast,
    contrastTargetsMet: report.meetsTargets,
    ...(brief.warnings.length > 0 ? { warnings: brief.warnings } : {}),
  };
}

// ------------------------------------------------------------------ verify

async function cmdVerify(positional, flags) {
  const dir = resolve(positional[0] ?? ".");
  const project = await readProject(dir);
  const base = String(flags.base ?? `http://localhost:${project.port}`);
  const routes = (project.indexableRoutes ?? ["/"]).join(",");

  const steps = [];
  const record = (name, code, detail) => {
    steps.push({ name, passed: code === 0, exitCode: code, ...(detail ? { detail } : {}) });
    return code === 0;
  };

  if (!existsSync(join(dir, "node_modules"))) {
    const install = await run("npm", ["install", "--no-audit", "--no-fund"], { cwd: dir, capture: true });
    if (!record("install", install.code)) return { verdict: "FAILED", base, steps };
  }

  const typecheck = await run("npm", ["run", "typecheck"], { cwd: dir, capture: true });
  record("typecheck", typecheck.code, typecheck.code === 0 ? undefined : tail(typecheck.stdout || typecheck.stderr));

  if (flags["skip-build"] !== true) {
    const build = await run("npm", ["run", "build"], { cwd: dir, capture: true });
    if (!record("build", build.code, build.code === 0 ? undefined : tail(build.stdout || build.stderr))) {
      return { verdict: "FAILED", base, steps };
    }
  }

  // Start the built app ourselves so every oracle sees the same origin.
  const server = spawn("npm", ["start"], { cwd: dir, stdio: "ignore", detached: true });
  try {
    if (!(await waitForHttp(base))) {
      record("server", 1, `no response from ${base} within 120s`);
      return { verdict: "INCONCLUSIVE", base, steps };
    }

    // The site advertises its production origin even when served locally, so
    // canonicals and sitemap entries are checked against that, not against the
    // address we fetched from.
    const seo = await run(
      "npx",
      [
        "tsx",
        join(KIT_ROOT, "tools/seo/src/cli.ts"),
        `--base=${base}`,
        `--canonical-base=${project.url}`,
        `--lang=${String(project.locale ?? "en").split(/[-_]/)[0]}`,
        `--routes=${routes}`,
      ],
      { cwd: KIT_ROOT, capture: true },
    );
    record("seo", seo.code, summarise(seo.stdout, /(\d+ passed · \d+ failed · \d+ advisory)/, seo.stderr));

    const breaker = await run(
      "npx",
      ["tsx", join(KIT_ROOT, "tools/breaker/src/breaker.ts"), `--contract=${join(dir, "contract.json")}`, `--base=${base}`],
      { cwd: KIT_ROOT, capture: true },
    );
    // Exit 2 is BREAKER_INCONCLUSIVE: the breaker could not verify, which is
    // not a falsified contract. Never a pass, but not a proven failure either —
    // collapsing the two would hide an unreachable target behind "FAILED".
    const breakerDetail =
      summarise(breaker.stdout, /(BREAKER_[A-Z]+ — .*)/, breaker.stderr) ??
      (breaker.code === 2 ? "BREAKER_INCONCLUSIVE" : undefined);
    if (breaker.code === 2) {
      steps.push({
        name: "breaker",
        passed: false,
        inconclusive: true,
        exitCode: 2,
        ...(breakerDetail ? { detail: breakerDetail } : {}),
      });
    } else {
      record("breaker", breaker.code, breakerDetail);
    }

    if (flags["skip-e2e"] !== true) {
      // A project with no visual baselines yet would fail its first run purely
      // for lacking a reference image. Seed them instead, and say so.
      const seeded = !existsSync(join(dir, "tests", "__screenshots__"));
      const args = ["playwright", "test", `--config=${join(KIT_ROOT, "tools/e2e/playwright.config.ts")}`];
      if (seeded) args.push("--update-snapshots");

      const e2e = await run("npx", args, {
        cwd: KIT_ROOT,
        capture: true,
        env: { KIT_BASE_URL: base, KIT_PROJECT_DIR: dir },
      });
      const detail = summarise(e2e.stdout, /(\d+ (?:passed|failed).*)/, e2e.stderr);
      record("e2e", e2e.code, seeded ? `${detail ?? ""} · visual baselines created` : detail);
    }
  } finally {
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {
      server.kill("SIGTERM");
    }
  }

  return { verdict: computeVerdict(steps), base, project: project.name, steps };
}

function tail(text, lines = 6) {
  return (text ?? "").trim().split("\n").slice(-lines).join("\n");
}

const summarise = summariseOutput;

// -------------------------------------------------------------------- list

async function cmdList(positional) {
  const parent = resolve(positional[0] ?? ".");
  const projects = [];
  for (const entry of await readdir(parent)) {
    const configPath = join(parent, entry, "spa-kit.json");
    if (!existsSync(configPath)) continue;
    const config = JSON.parse(await readFile(configPath, "utf8"));
    const built = existsSync(join(parent, entry, ".next"));
    projects.push({ dir: join(parent, entry), name: config.name, url: config.url, port: config.port, built });
  }
  return { parent, projects };
}

// -------------------------------------------------------------------- main

class UsageError extends Error {}

const USAGE = `spa-kit — generate and verify client SPAs

  spa-kit new <dir> --brief=brief.json [--port=4400] [--install=false] [--force]
  spa-kit new <dir> --name="Acme" --url=https://acme.com [--brand=#0A5FFF]
                    [--mode=dark|light] [--headline="..."] [--description="..."]
                    [--locale=en_US] [--port=4400] [--install=false] [--force]

  spa-kit brief                      print a brief template to stdout
  spa-kit apply <dir> [--brief=...]  re-apply the brief: palette, content, metadata

  spa-kit verify <dir> [--base=http://localhost:PORT] [--skip-build] [--skip-e2e]

  spa-kit list [<parent-dir>]
  spa-kit doctor [--fix]             check Node, dependencies and browsers

  Global: --json   machine-readable output on stdout

  Exit codes: 0 success · 1 verification failed · 2 usage or environment error
`;

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [command, ...rest] = positional;

  if (!command || flags.help || command === "help") {
    process.stdout.write(USAGE);
    return EXIT.ok;
  }

  try {
    if (command === "new") {
      const result = await cmdNew(rest, flags);
      if (flags.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else {
        process.stdout.write(
          `created ${result.dir}\n  name  ${result.name}\n  url   ${result.url}\n  port  ${result.port}\n` +
            `  brand ${result.brand} (${result.mode})${result.contrastTargetsMet ? "" : " — CONTRAST TARGETS MISSED"}\n` +
            `  deps  ${result.installed ? "installed" : "not installed (run npm install)"}\n` +
            (result.warnings ?? []).map((w) => `  warning: ${w}\n`).join("") +
            `\n` +
            `next: spa-kit verify ${result.dir}\n`,
        );
      }
      return EXIT.ok;
    }

    if (command === "verify") {
      const result = await cmdVerify(rest, flags);
      if (flags.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else {
        process.stdout.write(`verify ${result.project ?? ""} · ${result.base}\n`);
        for (const step of result.steps) {
          const mark = step.passed ? "  ok  " : step.inconclusive ? " ???? " : " FAIL ";
          process.stdout.write(
            `  [${mark}] ${step.name}${step.detail ? ` · ${step.detail}` : ""}\n`,
          );
        }
        process.stdout.write(`\n${result.verdict}\n`);
      }
      return exitCodeFor(result.verdict);
    }

    if (command === "apply") {
      const result = await cmdApply(rest, flags);
      if (flags.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else {
        process.stdout.write(
          `applied brief to ${result.dir}\n  brand ${result.brand} (${result.mode})\n` +
            `  contrast ${result.contrastTargetsMet ? "targets met" : "TARGETS MISSED"}\n`,
        );
        for (const [pair, ratio] of Object.entries(result.contrast)) {
          process.stdout.write(`    ${pair.padEnd(26)} ${ratio}:1\n`);
        }
        for (const warning of result.warnings ?? []) process.stdout.write(`  warning: ${warning}\n`);
      }
      return result.contrastTargetsMet ? EXIT.ok : EXIT.failed;
    }

    if (command === "doctor") {
      const result = await cmdDoctor(rest, flags);
      if (flags.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else {
        process.stdout.write(`spa-kit doctor · ${result.root}\n`);
        for (const c of result.checks) {
          process.stdout.write(
            `  [${c.ok || c.fixed ? "  ok  " : " FAIL "}] ${c.name.padEnd(14)} ${c.detail}\n` +
              (!c.ok && !c.fixed ? `           fix: ${c.remedy}\n` : ""),
          );
        }
        process.stdout.write(`\n${result.healthy ? "healthy" : "not ready — run spa-kit doctor --fix"}\n`);
      }
      return result.healthy ? EXIT.ok : EXIT.usage;
    }

    if (command === "brief") {
      process.stdout.write(`${JSON.stringify(BRIEF_EXAMPLE, null, 2)}\n`);
      return EXIT.ok;
    }

    if (command === "list") {
      const result = await cmdList(rest);
      if (flags.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else {
        if (result.projects.length === 0) process.stdout.write(`no spa-kit projects under ${result.parent}\n`);
        for (const p of result.projects) {
          process.stdout.write(`${p.name.padEnd(24)} :${p.port}  ${p.url}  ${p.built ? "built" : "not built"}\n    ${p.dir}\n`);
        }
      }
      return EXIT.ok;
    }

    process.stderr.write(`unknown command "${command}"\n\n${USAGE}`);
    return EXIT.usage;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (flags.json) process.stdout.write(`${JSON.stringify({ error: message }, null, 2)}\n`);
    else process.stderr.write(`spa-kit: ${message}\n`);
    return EXIT.usage;
  }
}

process.exitCode = await main();
