import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const gate = join(here, 'qk-gate.mjs');

test('qk-gate — composes route (critical) + referee (green) on a real temp git repo', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'qkgate-'));
  const git = (...a) => spawnSync('git', ['-C', tmp, ...a], { encoding: 'utf8' });
  try {
    git('init', '-q');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    mkdirSync(join(tmp, '.quality-kernel'), { recursive: true });
    writeFileSync(join(tmp, '.quality-kernel', 'tools.json'), JSON.stringify({ verify: 'node --test x.test.mjs' }));
    writeFileSync(join(tmp, '.quality-kernel', 'critical-surface.json'),
      JSON.stringify({ criticalGlobs: ['**/auth/**'], safeGlobs: ['**/*.md'] }));
    writeFileSync(join(tmp, 'x.test.mjs'),
      "import { test } from 'node:test'; import a from 'node:assert'; test('ok', () => a.ok(true));");
    mkdirSync(join(tmp, 'src', 'auth'), { recursive: true });
    writeFileSync(join(tmp, 'src', 'auth', 'thing.ts'), 'export const x = 1;');
    git('add', '-A');
    git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD').stdout.trim();

    // a change on the CRITICAL surface (auth), with a passing verify suite
    writeFileSync(join(tmp, 'src', 'auth', 'thing.ts'), 'export const x = 2;');
    git('add', '-A');
    git('commit', '-qm', 'change');

    const r = spawnSync('node', [gate, '--repo', tmp, '--base', base], { encoding: 'utf8' });
    const v = JSON.parse(r.stdout.trim().split('\n').pop());

    assert.strictEqual(r.status, 0, 'referee re-executed a green suite -> exit 0');
    assert.strictEqual(v.pass, true);
    assert.strictEqual(v.tier, 'critical', 'the auth change is critical');
    assert.strictEqual(v.requiresBreaker, true);
    assert.ok(v.notes.some((n) => /breaker/i.test(n)), 'flags the M2 breaker requirement honestly');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
