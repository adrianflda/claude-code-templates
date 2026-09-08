import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { globToRegExp, classify } from './route.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(here, 'fixtures', 'route', 'critical-surface.json'), 'utf8'));

// Real changed-file sets from two past bugs (see plan-m1-route.v1.md §5).
const PHI_IDOR = [
  'app/controllers/copdMonitoringWebsocket.controller.ts',
  'app/services/copdMonitoringSession.ts',
  'tests/unit/copdMonitoringSession.test.ts',
];
const INHALER_560 = [
  'realtime/brain/inhaler/catalog.ts',
  'realtime/brain/inhaler/resolver.ts',
  'realtime/brain/inhaler/types.ts',
  'realtime/eval/inhalerGroundTruth.ts',
  'realtime/tests/inhaler.resolver.test.ts',
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

test('INV-R2 — only safe paths classify trivial', () => {
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

test('INV-R5 (replay / kill-condition) — BOTH real past bugs classify critical', () => {
  assert.strictEqual(classify(PHI_IDOR, cfg, null).tier, 'critical', 'PHI/IDOR must be critical');
  assert.strictEqual(classify(INHALER_560, cfg, null).tier, 'critical', 'inhaler #560 must be critical');
});

test('CLI — route.mjs --changed with QK_CRITICAL_SURFACE env classifies end-to-end', () => {
  const r = spawnSync('node', [join(here, 'route.mjs'), '--changed', PHI_IDOR.join(',')], {
    encoding: 'utf8',
    env: { ...process.env, QK_CRITICAL_SURFACE: join(here, 'fixtures', 'route', 'critical-surface.json') },
  });
  assert.strictEqual(r.status, 0);
  const v = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.strictEqual(v.tier, 'critical');
});
