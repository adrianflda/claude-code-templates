/**
 * Pure decision logic behind `verify` and `doctor`.
 *
 * Extracted from the CLI so it can be tested without a filesystem, a network or
 * a subprocess. The CLI gathers facts; these functions decide what they mean.
 */

/**
 * Turns step outcomes into one verdict.
 *
 * The three-way distinction is load-bearing: a step that could not be evaluated
 * (an unreachable target, an unusable contract) must not read as a falsified
 * one. A real failure outranks an inconclusive step, because the failure is
 * proven and the inconclusive one is merely unknown.
 */
export function computeVerdict(steps) {
  if (steps.some((s) => !s.passed && !s.inconclusive)) return "FAILED";
  if (steps.some((s) => s.inconclusive)) return "INCONCLUSIVE";
  return "PASSED";
}

/** Process exit code for a verdict. Inconclusive is never 0. */
export function exitCodeFor(verdict) {
  if (verdict === "PASSED") return 0;
  if (verdict === "FAILED") return 1;
  return 2;
}

/**
 * Decides what a dependency tree's state means.
 *
 * A symlinked node_modules is reported as worse than a missing one: installing
 * would write through the link into another project's tree. Removing a path is
 * never offered as an automated fix.
 */
export function classifyDependencies({ isSymlink, missing = [], modulesPath, kitRoot }) {
  // Branch on isSymlink alone. `existsSync` follows links, so a symlink whose
  // target is gone reports exists:false while still being a link — requiring
  // both would fall through and declare a broken tree healthy.
  if (isSymlink) {
    return {
      ok: false,
      automatable: false,
      detail: "node_modules is a symlink — installing would write into its target",
      remedy: `unlink "${modulesPath}" && npm install --prefix "${kitRoot}"`,
    };
  }
  if (missing.length > 0) {
    return {
      ok: false,
      automatable: true,
      detail: `missing: ${missing.join(", ")}`,
      remedy: `npm install --prefix "${kitRoot}"`,
    };
  }
  return { ok: true, automatable: false, detail: "dependencies present" };
}

/**
 * Extracts an oracle's own summary line, falling back to its output when the
 * pattern does not match — which is what a crashed subprocess looks like.
 *
 * stderr is preferred over stdout in the fallback: a Node crash prints progress
 * to stdout and the stack trace to stderr, so taking stdout first would report
 * the noise and drop the error.
 */
export function summariseOutput(stdout, pattern, stderr = "", lines = 4) {
  const match = (stdout ?? "").match(pattern);
  if (match) return match[1];

  const tailOf = (text) =>
    (text ?? "")
      .trim()
      .split("\n")
      .slice(-lines)
      .join("\n")
      .trim();

  return tailOf(stderr) || tailOf(stdout) || undefined;
}
