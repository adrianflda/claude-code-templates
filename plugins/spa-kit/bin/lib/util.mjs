/** Small pure helpers shared by the CLI, kept separate so they can be tested. */

/** Filesystem- and npm-safe name derived from a display name. */
export function slugify(value) {
  return String(value)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/** Splits argv into positionals and flags. `--flag` alone is boolean true. */
export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (const arg of argv) {
    if (arg.startsWith("--")) {
      const [key, ...rest] = arg.slice(2).split("=");
      flags[key] = rest.length > 0 ? rest.join("=") : true;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

/** Lowest port at or above `base` that no sibling project has claimed. */
export function firstFreePort(usedPorts, base) {
  const used = new Set(usedPorts);
  let port = base;
  while (used.has(port)) port += 1;
  return port;
}
