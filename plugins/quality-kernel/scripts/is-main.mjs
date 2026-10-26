// True when the module at `metaUrl` is the script node was asked to run.
//
// Node resolves symlinks for the main module, so `import.meta.url` is the real path while
// process.argv[1] is the path as typed. Comparing them directly (or via a `file://` template, which
// also breaks on spaces and non-ASCII) made a gate run through a symlinked path — a symlinked
// plugin install, macOS /tmp -> /private/tmp — skip main() and exit 0: a silent PASS. Compare the
// real paths instead.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function isMain(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}
