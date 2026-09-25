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
 * Usage:
 *   npm run kit:add -- shadcn:button
 *   npm run kit:add -- magic:marquee aceternity:spotlight
 *   npm run kit:add -- --list
 */
import { spawn } from "node:child_process";

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

const TARGET_WORKSPACE = "apps/fixture";

function printList() {
  process.stdout.write("registries\n----------\n");
  for (const [key, { note, url }] of Object.entries(REGISTRIES)) {
    process.stdout.write(`${key.padEnd(18)} ${note}\n${" ".repeat(18)} ${url("<component>")}\n\n`);
  }
  process.stdout.write("usage: npm run kit:add -- magic:marquee reactbits:SplitText-TS-CSS\n");
}

async function resolve(spec) {
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

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", cwd: TARGET_WORKSPACE });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code}`));
    });
  });
}

const specs = process.argv.slice(2);
if (specs.length === 0 || specs.includes("--list")) {
  printList();
  process.exit(0);
}

const urls = [];
for (const spec of specs) {
  try {
    urls.push(await resolve(spec));
  } catch (err) {
    process.stderr.write(`kit:add — ${err.message}\n`);
    process.exit(1);
  }
}

process.stdout.write(`kit:add → ${urls.join(" ")}\n`);
await run("npx", ["--yes", "shadcn@latest", "add", ...urls]);
