// Smoke + red-team for the pre-push invoker: it must BLOCK a push whose gated commit is broken and
// ALLOW a clean trivial one, and it must gate the PUSHED sha (local_sha), not the worktree.
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
const CODE_OK = 'export const f = () => 1;';
const GUARD = "import { test } from 'node:test'; import a from 'node:assert'; import { f } from './src/code.mjs'; test('g', () => a.strictEqual(f(), 1));";

function repo(changeFn) {
  const tmp = mkdtempSync(join(tmpdir(), 'qk-prepush-'));
  const git = (...a) => spawnSync('git', ['-C', tmp, ...a], { encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  const write = (p, c) => { const d = join(tmp, p); mkdirSync(dirname(d), { recursive: true }); writeFileSync(d, c); };
  write('.quality-kernel/tools.json', JSON.stringify({ verify: 'node --test guard.test.mjs', productionGlobs: ['src/**', '**/*.md'] }));
  write('.quality-kernel/critical-surface.json', JSON.stringify({ criticalGlobs: ['**/auth/**'], safeGlobs: ['**/*.md'] }));
  write('src/code.mjs', CODE_OK); write('guard.test.mjs', GUARD); write('README.md', 'v1');
  git('add', '-A'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD').stdout.trim();
  changeFn(tmp, write);
  git('add', '-A'); git('commit', '-qm', 'change');
  const head = git('rev-parse', 'HEAD').stdout.trim();
  return { tmp, base, head, git };
}
function runHook(tmp, head, base) {
  return spawnSync('bash', [HOOK], {
    cwd: tmp, encoding: 'utf8',
    input: `refs/heads/main ${head} refs/heads/main ${base}\n`,
    env: { ...process.env, QK_GATE: GATE },
  });
}

test('pre-push — BLOCKS a push whose gated commit breaks production', () => {
  const { tmp, base, head } = repo((t, w) => w('src/code.mjs', 'export const f = () => 999;'));
  try {
    const r = runHook(tmp, head, base);
    assert.notStrictEqual(r.status, 0, 'broken production must block the push');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('pre-push — ALLOWS a clean trivial push (gate exit 0)', () => {
  const { tmp, base, head } = repo((t, w) => w('README.md', 'v2'));
  try {
    const r = runHook(tmp, head, base);
    assert.strictEqual(r.status, 0, 'a trivial, green change is allowed');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('pre-push RED-TEAM (#3) — gates the PUSHED sha, not the worktree (revert the worktree, still blocked)', () => {
  const { tmp, base, head, git } = repo((t, w) => w('src/code.mjs', 'export const f = () => 999;'));
  try {
    // Attacker makes the worktree look clean by checking out base, but pushes the broken head sha.
    git('checkout', '-q', base);
    const r = runHook(tmp, head, base);
    assert.notStrictEqual(r.status, 0, 'the committed head (broken) is gated regardless of a clean worktree');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
