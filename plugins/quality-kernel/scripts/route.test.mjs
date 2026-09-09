import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { globToRegExp, classify, parseDiffZ } from './route.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const routeCli = join(here, 'route.mjs');
const cfg = JSON.parse(readFileSync(join(here, 'fixtures', 'route', 'critical-surface.json'), 'utf8'));

// Domain-agnostic synthetic changesets representing real risk FAMILIES (no app/domain names).
const ACCESS_CONTROL = [        // an IDOR / broken-access-control shaped change
  'app/controllers/session.controller.ts',
  'app/auth/session.ts',
  'tests/session.test.ts',
];
const MONEY_AND_DATA = [        // a money + data-migration shaped change
  'src/payments/charge.ts',
  'db/migrations/004_add_ledger.sql',
  'tests/payments.test.ts',
];

test('T2 — glob matcher: ** crosses dirs, * does not, literal segments are exact', () => {
  assert.ok(globToRegExp('**/auth/**').test('app/auth/login.ts'));
  assert.ok(globToRegExp('**/auth/**').test('auth/y.ts'));           // zero leading dirs
  assert.ok(!globToRegExp('**/auth/**').test('app/authz/x.ts'));     // authz != auth
  assert.ok(globToRegExp('**/*.sql').test('db/migrate.sql'));
  assert.ok(globToRegExp('src/*').test('src/a.ts'));
  assert.ok(!globToRegExp('src/*').test('src/a/b.ts'));              // * does not cross /
});

test('INV-R1 — a critical-surface path classifies critical + requiresBreaker', () => {
  const v = classify(['app/auth/login.ts'], cfg, null);
  assert.strictEqual(v.tier, 'critical');
  assert.strictEqual(v.tierFloor, 'critical');
  assert.strictEqual(v.requiresBreaker, true);
});

test('INV-R2 — only truly inert paths classify trivial', () => {
  const v = classify(['README.md', 'docs/guide.md'], cfg, null);
  assert.strictEqual(v.tier, 'trivial');
  assert.strictEqual(v.requiresBreaker, false);
});

test('INV-R3 — no config -> fail-safe critical', () => {
  const v = classify(['src/util.ts'], null, null);
  assert.strictEqual(v.tier, 'critical');
});

test('INV-R4 — the floor holds: a proposal may raise, never lower', () => {
  assert.strictEqual(classify(['app/auth/x.ts'], cfg, 'trivial').tier, 'critical'); // cannot lower
  assert.strictEqual(classify(['README.md'], cfg, 'critical').tier, 'critical');     // can raise
});

test('INV-R5 (recall on risk families) — both synthetic risk-family changes classify critical', () => {
  assert.strictEqual(classify(ACCESS_CONTROL, cfg, null).tier, 'critical', 'access-control family must be critical');
  assert.strictEqual(classify(MONEY_AND_DATA, cfg, null).tier, 'critical', 'money+migration family must be critical');
});

test('PRECISION — a docs file that merely mentions a risk word is NOT critical', () => {
  assert.strictEqual(classify(['docs/payments-guide.md', 'README.md'], cfg, null).tier, 'trivial');
});

// --- test-surface semantics (hardening from the panel) ---

test('RED-TEAM — deleting a test file is always critical', () => {
  const v = classify(['src/util.ts'], cfg, null, ['src/util.test.ts']);
  assert.strictEqual(v.tier, 'critical');
  assert.deepStrictEqual(v.deletedTests, ['src/util.test.ts']);
});

test('RED-TEAM — EDITING a test is a contract change -> critical (human review; Option B)', () => {
  const v = classify(['src/util.test.ts'], cfg, null);
  assert.strictEqual(v.tier, 'critical');
  assert.strictEqual(v.requiresBreaker, true);
  assert.deepStrictEqual(v.changedTests, ['src/util.test.ts']);
});

test('RED-TEAM — touching .quality-kernel/** is always critical', () => {
  assert.strictEqual(classify(['.quality-kernel/tools.json'], cfg, null).tier, 'critical');
  assert.strictEqual(classify(['.quality-kernel/critical-surface.json'], cfg, null).tier, 'critical');
});

// --- diff parsing (panel finding H1 + non-ASCII #7) ---

test('parseDiffZ — a rename counts the OLD path as deleted and the NEW path as changed', () => {
  const buf = 'R100\0src/auth/old.ts\0src/legacy/new.ts\0M\0src/x.ts\0';
  const { changed, deleted } = parseDiffZ(buf);
  assert.ok(deleted.includes('src/auth/old.ts'), 'renamed-away path is a deletion');
  assert.ok(changed.includes('src/legacy/new.ts'));
  assert.ok(changed.includes('src/x.ts'));
});

test('parseDiffZ — a type change counts as delete + add; D as delete; non-ASCII preserved', () => {
  const buf = 'T\0src/link\0D\0tests/señal.test.ts\0A\0src/new.ts\0';
  const { changed, deleted } = parseDiffZ(buf);
  assert.ok(deleted.includes('src/link') && changed.includes('src/link'));
  assert.ok(deleted.includes('tests/señal.test.ts'));
  assert.ok(changed.includes('src/new.ts'));
});

test('RED-TEAM (H1) — renaming a test away is still a deletion -> critical', () => {
  // simulate what parseDiffZ+classify do for `git mv guard.test.ts guard-old.ts`
  const { changed, deleted } = parseDiffZ('R100\0guard.test.ts\0guard-old.ts\0');
  const v = classify(changed, cfg, null, deleted);
  assert.strictEqual(v.tier, 'critical', 'a renamed-away test is a deleted test');
});

// --- CLI: base..head from committed refs, config read from the BASE ref ---

function gitRepo(mutate) {
  const tmp = mkdtempSync(join(tmpdir(), 'qk-route-'));
  const git = (...a) => spawnSync('git', ['-C', tmp, ...a], { encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  mkdirSync(join(tmp, '.quality-kernel'), { recursive: true });
  writeFileSync(join(tmp, '.quality-kernel', 'critical-surface.json'), JSON.stringify(cfg));
  writeFileSync(join(tmp, 'README.md'), 'base');
  git('add', '-A'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD').stdout.trim();
  mutate(tmp, git);
  git('add', '-A'); git('commit', '-qm', 'change');
  const head = git('rev-parse', 'HEAD').stdout.trim();
  return { tmp, base, head, git };
}
const json = (r) => JSON.parse((r.stdout || '').trim().split('\n').filter(Boolean).pop());

test('CLI — base..head diff, config from base ref, critical surface forces critical', () => {
  const { tmp, base, head } = gitRepo((t) => {
    mkdirSync(join(t, 'app', 'auth'), { recursive: true });
    writeFileSync(join(t, 'app', 'auth', 'login.ts'), 'export const x = 1;');
  });
  try {
    const r = spawnSync('node', [routeCli, '--repo', tmp, '--base', base, '--head', head], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(json(r).tier, 'critical');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('CLI RED-TEAM (#9) — an UNTRACKED permissive critical-surface in the worktree is ignored (config comes from base)', () => {
  const { tmp, base, head } = gitRepo((t) => {
    mkdirSync(join(t, 'app', 'auth'), { recursive: true });
    writeFileSync(join(t, 'app', 'auth', 'login.ts'), 'export const x = 1;');
  });
  try {
    // Attacker drops an untracked permissive config after committing.
    writeFileSync(join(tmp, '.quality-kernel', 'critical-surface.json'), JSON.stringify({ criticalGlobs: [], safeGlobs: ['**'] }));
    const r = spawnSync('node', [routeCli, '--repo', tmp, '--base', base, '--head', head], { encoding: 'utf8' });
    assert.strictEqual(json(r).tier, 'critical', 'worktree config is ignored; the base surface still forces critical');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('CLI — unverifiable base ref fails closed (exit 2, critical)', () => {
  const { tmp } = gitRepo((t) => { writeFileSync(join(t, 'README.md'), 'x'); });
  try {
    const r = spawnSync('node', [routeCli, '--repo', tmp, '--base', 'deadbeef', '--head', 'HEAD'], { encoding: 'utf8' });
    assert.strictEqual(r.status, 2);
    assert.strictEqual(json(r).tier, 'critical');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
