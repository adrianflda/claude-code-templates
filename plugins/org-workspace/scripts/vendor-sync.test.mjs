import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, mkdtempSync, symlinkSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
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
  ['prop-kit.mjs', 'prop-kit.mjs'],
]) {
  test(`OG-16: org-workspace/${ours} is byte-identical to quality-kernel/${theirs}`, () => {
    assert.strictEqual(read(join(here, ours)), read(join(qk, theirs)), `${ours} has drifted from quality-kernel's ${theirs} — re-vendor it`);
  });
}

// OG-19(e)/F22: the entrypoint/is-main check invoked through a symlinked script path still runs
// (non-empty output, exit 0) — no test ever invoked a CLI script through a symlink to the scripts
// directory itself, only to a target file/repo dir.
test('OG-19(e): org-discover.mjs still runs (isMain is true) when invoked through a symlinked path', () => {
  const org = realpathSync(mkdtempSync(join(tmpdir(), 'og19e-org-')));
  mkdirSync(join(org, 'app'));
  const symDir = realpathSync(mkdtempSync(join(tmpdir(), 'og19e-sym-'))); // a symlinked /tmp-style parent
  const linkedScript = join(symDir, 'org-discover.mjs');
  symlinkSync(join(here, 'org-discover.mjs'), linkedScript);
  const r = spawnSync(process.execPath, [linkedScript, '--org', org], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.trim().length > 0, 'expected non-empty JSON output, not a silent exit 0 from main() never running');
  assert.ok(JSON.parse(r.stdout).candidates.some((c) => c.name === 'app'));
});
