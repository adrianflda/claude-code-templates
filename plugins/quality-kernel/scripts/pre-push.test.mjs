// Smoke test for the pre-push invoker: it must BLOCK a push whose gate is non-zero and ALLOW a
// clean one — exercising the real git pre-push stdin protocol.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const GATE = join(here, 'qk-gate.mjs');
const HOOK = join(here, '..', 'hooks', 'pre-push.sample');
const PASS_TEST = "import { test } from 'node:test'; import a from 'node:assert'; test('ok', () => a.ok(true));";
const FAIL_TEST = "import { test } from 'node:test'; import a from 'node:assert'; test('bad', () => a.ok(false));";

function repo(changeFn) {
  const tmp = mkdtempSync(join(tmpdir(), 'qk-prepush-'));
  const git = (...a) => spawnSync('git', ['-C', tmp, ...a], { encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  mkdirSync(join(tmp, '.quality-kernel'), { recursive: true });
  writeFileSync(join(tmp, '.quality-kernel', 'tools.json'), JSON.stringify({ verify: 'node --test x.test.mjs' }));
  writeFileSync(join(tmp, '.quality-kernel', 'critical-surface.json'), JSON.stringify({ criticalGlobs: ['**/auth/**'], safeGlobs: ['**/*.md'] }));
  writeFileSync(join(tmp, 'x.test.mjs'), PASS_TEST);
  writeFileSync(join(tmp, 'README.md'), 'v1');
  git('add', '-A'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD').stdout.trim();
  changeFn(tmp);
  git('add', '-A'); git('commit', '-qm', 'change');
  const head = git('rev-parse', 'HEAD').stdout.trim();
  return { tmp, base, head };
}
function runHook(tmp, head, base) {
  return spawnSync('bash', [HOOK], {
    cwd: tmp, encoding: 'utf8',
    input: `refs/heads/main ${head} refs/heads/main ${base}\n`,
    env: { ...process.env, QK_GATE: GATE },
  });
}

test('pre-push — BLOCKS a push whose suite is red (gate non-zero)', () => {
  const { tmp, base, head } = repo((t) => writeFileSync(join(t, 'x.test.mjs'), FAIL_TEST));
  try {
    const r = runHook(tmp, head, base);
    assert.notStrictEqual(r.status, 0, 'a red suite must block the push');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('pre-push — ALLOWS a clean trivial push (gate exit 0)', () => {
  const { tmp, base, head } = repo((t) => writeFileSync(join(t, 'README.md'), 'v2'));
  try {
    const r = runHook(tmp, head, base);
    assert.strictEqual(r.status, 0, 'a trivial, green change is allowed');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
