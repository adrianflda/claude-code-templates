#!/usr/bin/env node
/**
 * kit:add — pull an animated component into the project from a registry.
 *
 * Every registry below distributes source through the shadcn CLI: the files are
 * copied into the repo and become ours. There is no package to version-pin, and
 * no runtime dependency beyond what the component itself imports. The trade-off
 * is that updates are manual, which is the right trade for presentation code we
 * intend to modify anyway.
 *
 * Each URL template was verified to resolve (HTTP 200) on 2026-09-24. The script
 * re-checks before delegating, so a moved registry fails loudly here instead of
 * producing a confusing shadcn error.
 *
 * Usage (from inside a generated site, or with --project):
 *   npm run kit:add -- shadcn:button
 *   npm run kit:add -- magic:marquee aceternity:spotlight
 *   npm run kit:add -- --list
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const REGISTRIES = {
  shadcn: {
    url: (name) => `https://ui.shadcn.com/r/styles/new-york/${name}.json`,
    note: "Base primitives. Unstyled behaviour, no motion. Start here.",
  },
  magic: {
    url: (name) => `https://magicui.design/r/${name}.json`,
    note: "Polished micro-interactions and marketing motion. Premium without theatrics.",
  },
  aceternity: {
    url: (name) => `https://ui.aceternity.com/registry/${name}.json`,
    note: "Dramatic effects: spotlights, beams, 3D cards. Use sparingly; check reduced-motion.",
  },
  motionprimitives: {
    url: (name) => `https://motion-primitives.com/c/${name}.json`,
    note: "Composable building blocks with restrained, product-grade motion.",
  },
  reactbits: {
    // Variant suffix is part of the name, e.g. SplitText-TS-CSS.
    url: (name) => `https://reactbits.dev/r/${name}.json`,
    note: "Broad coverage and the only one of these that ships prefers-reduced-motion handling by default.",
  },
};

/**
 * Where the component lands. A generated client project is the only sensible
 * target, so it must be named (or be the working directory) and must carry the
 * components.json the shadcn CLI needs.
 */
function resolveTarget(argv) {
  const flag = argv.find((a) => a.startsWith("--project="));
  const dir = flag ? resolve(flag.split("=").slice(1).join("=")) : process.cwd();
  if (!existsSync(join(dir, "components.json"))) {
    throw new Error(
      `${dir} has no components.json — run this inside a generated site, or pass --project=<dir>`,
    );
  }
  return dir;
}

function printList() {
  process.stdout.write("registries\n----------\n");
  for (const [key, { note, url }] of Object.entries(REGISTRIES)) {
    process.stdout.write(`${key.padEnd(18)} ${note}\n${" ".repeat(18)} ${url("<component>")}\n\n`);
  }
  process.stdout.write("usage: npm run kit:add -- magic:marquee reactbits:SplitText-TS-CSS\n");
}

async function resolveRegistryUrl(spec) {
  const [registry, ...rest] = spec.split(":");
  const name = rest.join(":");
  if (!registry || !name) throw new Error(`"${spec}" must look like registry:component`);

  const entry = REGISTRIES[registry];
  if (!entry) {
    throw new Error(`unknown registry "${registry}". Known: ${Object.keys(REGISTRIES).join(", ")}`);
  }

  const url = entry.url(name);
  const res = await fetch(url, { method: "GET", headers: { "user-agent": "kit-add/0.1" } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}; check the component name`);
  return url;
}

function run(command, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "inherit", cwd });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} exited with ${code}`));
    });
  });
}

const argv = process.argv.slice(2);
const specs = argv.filter((a) => !a.startsWith("--project="));

if (specs.length === 0 || specs.includes("--list")) {
  printList();
  process.exit(0);
}

let target;
try {
  target = resolveTarget(argv);
} catch (err) {
  process.stderr.write(`kit:add — ${err.message}\n`);
  process.exit(1);
}
const urls = [];
for (const spec of specs) {
  try {
    urls.push(await resolveRegistryUrl(spec));
  } catch (err) {
    process.stderr.write(`kit:add — ${err.message}\n`);
    process.exit(1);
  }
}

process.stdout.write(`kit:add → ${target}\n           ${urls.join(" ")}\n`);
try {
  await run("npx", ["--yes", "shadcn@latest", "add", ...urls], target);
} catch (err) {
  // The shadcn CLI fetches the component itself and has its own 10s timeout, so
  // this is most often a slow network rather than a bad component name — the URL
  // was already verified reachable above.
  process.stderr.write(
    `\nkit:add — the shadcn CLI failed: ${err.message}\n` +
      `           the registry URL resolved, so this is usually a network timeout. Retry, or run:\n` +
      `           cd "${target}" && npx shadcn@latest add ${urls.join(" ")}\n`,
  );
  process.exit(1);
}
