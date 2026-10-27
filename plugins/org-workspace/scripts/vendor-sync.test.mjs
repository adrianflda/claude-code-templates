import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// OG-16 / INV-OG-11: the git-invocation and entrypoint-detection helpers are vendor-copied into
// both org-workspace and quality-kernel (F12 — no cross-plugin import, no shared package; see the
// contract's design question 4). A repo-level check fails the moment they diverge, instead of a
// human needing to notice by reading both plugins (F12's actual finding: the two copies had already
// diverged, with different export names and different comments naming the wrong plugin).
const here = dirname(fileURLToPath(import.meta.url));
const qk = join(here, '..', '..', 'quality-kernel', 'scripts');
const read = (p) => readFileSync(p, 'utf8');

for (const [ours, theirs] of [
  ['safe-git.mjs', 'safe-git.mjs'],
  ['hermetic-git.mjs', 'hermetic-git.mjs'],
  ['entrypoint.mjs', 'is-main.mjs'],
]) {
  test(`OG-16: org-workspace/${ours} is byte-identical to quality-kernel/${theirs}`, () => {
    assert.strictEqual(read(join(here, ours)), read(join(qk, theirs)), `${ours} has drifted from quality-kernel's ${theirs} — re-vendor it`);
  });
}
