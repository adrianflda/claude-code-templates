import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const gate = join(here, 'qk-gate.mjs');

// Build a temp git repo with a committed base (tools.json verify + green suite + critical-surface),
// then apply `change(tmp)` and commit it. Returns { tmp, base }.
function mkRepo(change, criticalGlobs = ['**/auth/**']) {
  const tmp = mkdtempSync(join(tmpdir(), 'qkgate-'));
  const git = (...a) => spawnSync('git', ['-C', tmp, ...a], { encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  mkdirSync(join(tmp, '.quality-kernel'), { recursive: true });
  writeFileSync(join(tmp, '.quality-kernel', 'tools.json'), JSON.stringify({ verify: 'node --test x.test.mjs', productionGlobs: ['src/**', '**/*.md'] }));
  writeFileSync(join(tmp, '.quality-kernel', 'critical-surface.json'), JSON.stringify({ criticalGlobs, safeGlobs: ['**/*.md'] }));
  writeFileSync(join(tmp, 'x.test.mjs'),
    "import { test } from 'node:test'; import a from 'node:assert'; test('ok', () => a.ok(true));");
  writeFileSync(join(tmp, 'README.md'), 'v1');
  mkdirSync(join(tmp, 'src', 'auth'), { recursive: true });
  writeFileSync(join(tmp, 'src', 'auth', 'thing.ts'), 'export const x = 1;');
  git('add', '-A'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD').stdout.trim();
  change(tmp, git);
  git('add', '-A'); git('commit', '-qm', 'change');
  return { tmp, base, git };
}

test('qk-gate — CRITICAL change, referee green but breaker unenforced -> exit 3 (do-not-merge)', () => {
  const { tmp } = mkRepo((t) => writeFileSync(join(t, 'src', 'auth', 'thing.ts'), 'export const x = 2;'));
  const base = spawnSync('git', ['-C', tmp, 'rev-parse', 'HEAD~1'], { encoding: 'utf8' }).stdout.trim();
  try {
    const r = spawnSync('node', [gate, '--repo', tmp, '--base', base], { encoding: 'utf8' });
    const v = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.strictEqual(r.status, 3, 'exit 3: green but breaker required-and-unenforced on a critical change');
    assert.strictEqual(v.gate, 'blocked-needs-breaker');
    assert.strictEqual(v.refereePass, true, 'the suite genuinely passed (referee re-executed)');
    assert.strictEqual(v.tier, 'critical');
    assert.ok(v.notes.some((n) => /breaker/i.test(n)));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('qk-gate — TRIVIAL change (a .md), referee green -> exit 0 pass', () => {
  const { tmp } = mkRepo((t) => writeFileSync(join(t, 'README.md'), 'v2'));
  const base = spawnSync('git', ['-C', tmp, 'rev-parse', 'HEAD~1'], { encoding: 'utf8' }).stdout.trim();
  try {
    const r = spawnSync('node', [gate, '--repo', tmp, '--base', base], { encoding: 'utf8' });
    const v = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.strictEqual(r.status, 0, 'exit 0: trivial + verified green');
    assert.strictEqual(v.gate, 'pass');
    assert.strictEqual(v.tier, 'trivial');
    assert.strictEqual(v.requiresBreaker, false);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
