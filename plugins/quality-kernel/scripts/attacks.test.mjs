// Red-team regressions (Constitution P11: "red-team the gate itself"). Each test is an attack
// the specialist panel used to falsify the M0/M1 guarantees; they must now stay defeated forever.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const referee = join(here, 'referee.mjs');
const route = join(here, 'route.mjs');

const PASS_TEST = "import { test } from 'node:test'; import a from 'node:assert'; test('ok', () => a.ok(1 + 1 === 2));";
const FAIL_TEST = "import { test } from 'node:test'; import a from 'node:assert'; test('bad', () => a.ok(1 + 1 === 3));";

// Base repo: committed verify command (node --test x.test.mjs) + a passing suite. Then `change`.
function repo(change) {
  const tmp = mkdtempSync(join(tmpdir(), 'qk-attack-'));
  const git = (...a) => spawnSync('git', ['-C', tmp, ...a], { encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  mkdirSync(join(tmp, '.quality-kernel'), { recursive: true });
  writeFileSync(join(tmp, '.quality-kernel', 'tools.json'), JSON.stringify({ verify: 'node --test x.test.mjs' }));
  writeFileSync(join(tmp, '.quality-kernel', 'critical-surface.json'), JSON.stringify({ criticalGlobs: ['**/auth/**'], safeGlobs: ['**/*.md'] }));
  writeFileSync(join(tmp, 'x.test.mjs'), PASS_TEST);
  git('add', '-A'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD').stdout.trim();
  change(tmp, git);
  git('add', '-A'); git('commit', '-qm', 'change');
  return { tmp, base };
}
const json = (r) => JSON.parse((r.stdout || '').trim().split('\n').filter(Boolean).pop());

test('ATTACK 1 — weakening tools.json in the change cannot force a pass (verify read from base ref)', () => {
  // The agent breaks the suite AND rewrites the verify command to a no-op in the same change.
  const { tmp, base } = repo((t) => {
    writeFileSync(join(t, 'x.test.mjs'), FAIL_TEST);
    writeFileSync(join(t, '.quality-kernel', 'tools.json'), JSON.stringify({ verify: 'true' }));
  });
  try {
    const r = spawnSync('node', [referee, '--repo', tmp, '--base', base], { encoding: 'utf8' });
    // The referee uses the BASE verify command (node --test x.test.mjs), runs the now-red suite -> FAIL.
    assert.strictEqual(r.status, 1, 'the weakened worktree verify is ignored; the base command catches the red suite');
    assert.strictEqual(json(r).pass, false);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('ATTACK 2 — deleting a test to go green is caught by route (critical)', () => {
  const { tmp, base } = repo((t) => { rmSync(join(t, 'x.test.mjs')); });
  try {
    const r = spawnSync('node', [route, '--repo', tmp, '--base', base], { encoding: 'utf8' });
    const v = json(r);
    assert.strictEqual(v.tier, 'critical');
    assert.ok(v.deletedTests.includes('x.test.mjs'), 'the removed test is flagged');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('ATTACK 3 — invoking route without --base fails closed (never an empty-diff downgrade to trivial)', () => {
  const { tmp } = repo((t) => { mkdirSync(join(t, 'src', 'auth'), { recursive: true }); writeFileSync(join(t, 'src', 'auth', 'f.ts'), 'export const x=1;'); });
  try {
    const r = spawnSync('node', [route, '--repo', tmp], { encoding: 'utf8' }); // NO --base
    assert.strictEqual(r.status, 2, 'no --base -> operational error, fail-closed');
    const v = json(r);
    assert.strictEqual(v.tier, 'critical');
    assert.ok(v.error);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('sanity — the same base repo with a genuine green change still passes the referee', () => {
  const { tmp, base } = repo((t) => { writeFileSync(join(t, 'note.md'), 'docs'); });
  try {
    const r = spawnSync('node', [referee, '--repo', tmp, '--base', base], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(json(r).pass, true);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('ATTACK B (M3) — neutering a test IN PLACE is caught by the trusted base-harness run', () => {
  // A real guard test over code.mjs; the change breaks the code AND rewrites the test to assert(true).
  const tmp = mkdtempSync(join(tmpdir(), 'qk-attackB-'));
  const git = (...a) => spawnSync('git', ['-C', tmp, ...a], { encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  mkdirSync(join(tmp, '.quality-kernel'), { recursive: true });
  writeFileSync(join(tmp, '.quality-kernel', 'tools.json'), JSON.stringify({ verify: 'node --test guard.test.mjs' }));
  writeFileSync(join(tmp, 'code.mjs'), 'export const f = () => 1;');
  writeFileSync(join(tmp, 'guard.test.mjs'),
    "import { test } from 'node:test'; import a from 'node:assert'; import { f } from './code.mjs'; test('g', () => a.strictEqual(f(), 1));");
  git('add', '-A'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD').stdout.trim();
  writeFileSync(join(tmp, 'code.mjs'), 'export const f = () => 999;');                 // break the code
  writeFileSync(join(tmp, 'guard.test.mjs'),                                            // neuter the test in place
    "import { test } from 'node:test'; import a from 'node:assert'; test('g', () => a.ok(true));");
  git('add', '-A'); git('commit', '-qm', 'neuter test + break code');
  try {
    const r = spawnSync('node', [referee, '--repo', tmp, '--base', base], { encoding: 'utf8' });
    const v = json(r);
    assert.strictEqual(r.status, 1, 'base guard run against head code (f()=999) fails -> blocked');
    assert.strictEqual(v.pass, false);
    assert.strictEqual(v.evidence.trustedHarnessExit, 1);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
