// "Is this module the script node was asked to run?" Node resolves import.meta.url to the real path
// but leaves process.argv[1] as typed, so a plain URL comparison is false when the script is invoked
// through a symlink (on macOS /tmp and /var are symlinks) — and a gate whose main() never runs exits
// 0 with no output, which reads as a pass. Compare real paths instead.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function isEntrypoint(metaUrl) {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try { return realpathSync(invoked) === realpathSync(fileURLToPath(metaUrl)); } catch { return false; }
}
