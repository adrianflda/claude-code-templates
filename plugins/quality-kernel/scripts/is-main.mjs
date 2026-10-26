// True when the module at `metaUrl` is the script node was asked to run.
//
// Node resolves symlinks for the main module, so `import.meta.url` is the real path while
// process.argv[1] is the path as typed. Comparing them directly (or via a `file://` template, which
// also breaks on spaces and non-ASCII) made a gate run through a symlinked path — a symlinked
// plugin install, macOS /tmp -> /private/tmp — skip main() and exit 0: a silent PASS. Compare the
// real paths instead.
// The plain comparison comes first, so a realpath failure can only affect the symlinked case.
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function isMain(metaUrl) {
  if (!process.argv[1]) return false;
  const self = fileURLToPath(metaUrl);
  const target = resolve(process.argv[1]);
  if (self === target) return true;
  try {
    return realpathSync(self) === realpathSync(target);
  } catch {
    return false;
  }
}
