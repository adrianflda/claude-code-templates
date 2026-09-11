import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, existsSync, rmSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const referee = join(here, 'referee.mjs');

// Build a committed base..head git repo with a verify contract at base.
function mk(tools, baseFiles, change) {
  const tmp = mkdtempSync(join(tmpdir(), 'qk-ref-'));
  const git = (...a) => spawnSync('git', ['-C', tmp, ...a], { encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  const write = (p, c) => { const d = join(tmp, p); mkdirSync(dirname(d), { recursive: true }); writeFileSync(d, c); };
  write('.quality-kernel/tools.json', JSON.stringify(tools));
  for (const [p, c] of Object.entries(baseFiles)) write(p, c);
  git('add', '-A'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD').stdout.trim();
  for (const [p, c] of Object.entries(change || {})) write(p, c);
  git('add', '-A'); git('commit', '-qm', 'change');
  const head = git('rev-parse', 'HEAD').stdout.trim();
  return { tmp, base, head, git };
}
function runOn(tmp, base, head) {
  const r = spawnSync('node', [referee, '--repo', tmp, '--base', base, '--head', head], { encoding: 'utf8' });
  let verdict = null;
  try { verdict = JSON.parse((r.stdout || '').trim().split('\n').filter(Boolean).pop()); } catch { /* null */ }
  return { code: r.status, verdict };
}
const TOOLS = { verify: 'node --test guard.test.mjs', productionGlobs: ['src/**'] };
const CODE_OK = 'export const f = () => 1;';
const GUARD = "import { test } from 'node:test'; import a from 'node:assert'; import { f } from './src/code.mjs'; test('g', () => a.strictEqual(f(), 1));";

test('INV2 — a genuine pass yields PASS (exit 0, real verifyExit 0)', () => {
  const { tmp, base, head } = mk(TOOLS, { 'src/code.mjs': CODE_OK, 'guard.test.mjs': GUARD },
    { 'src/code.mjs': 'export const f = () => 1; export const g = () => 2;' });
  try {
    const { code, verdict } = runOn(tmp, base, head);
    assert.strictEqual(code, 0);
    assert.strictEqual(verdict.pass, true);
    assert.strictEqual(verdict.evidence.trustedExit, 0);
    assert.strictEqual(verdict.evidence.headExit, 0);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('INV1 — a forged pass (red suite) is BLOCKED (exit 1)', () => {
  const { tmp, base, head } = mk(TOOLS, { 'src/code.mjs': CODE_OK, 'guard.test.mjs': GUARD },
    { 'src/code.mjs': 'export const f = () => 999;' });
  try {
    const { code, verdict } = runOn(tmp, base, head);
    assert.strictEqual(code, 1);
    assert.strictEqual(verdict.pass, false);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('INV4 — indeterminate fails closed (exit 2) when the verify command cannot run', () => {
  const { tmp, base, head } = mk({ verify: 'this-command-does-not-exist-xyz', productionGlobs: ['src/**'] },
    { 'src/code.mjs': CODE_OK }, { 'src/code.mjs': 'export const f = () => 2;' });
  try {
    const { code, verdict } = runOn(tmp, base, head);
    assert.strictEqual(code, 2);
    assert.strictEqual(verdict.indeterminate, true);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('INV5a — the referee appends the REAL verify exit code to the ledger', () => {
  const { tmp, base, head } = mk(TOOLS, { 'src/code.mjs': CODE_OK, 'guard.test.mjs': GUARD },
    { 'src/code.mjs': 'export const f = () => 1; export const g = () => 3;' });
  try {
    runOn(tmp, base, head);
    const ledger = join(tmp, '.quality-kernel', 'evidence-ledger.jsonl');
    assert.ok(existsSync(ledger), 'referee should have written the ledger');
    const rec = readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).at(-1);
    assert.strictEqual(rec.source, 'referee');
    assert.strictEqual(rec.trusted_exit, 0);
    assert.strictEqual(rec.head_exit, 0);
    assert.strictEqual(rec.pass, true);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// --- review regression (#25): package.json "scripts" is part of the oracle ---
test('manifest (RED) — swapping scripts.test for a no-op is NOT a benign manifest change', () => {
  const PKG = (t) => JSON.stringify({ name: 'x', version: '1.0.0', scripts: { test: t } }, null, 2);
  const { tmp, base, head } = mk(TOOLS,
    { 'src/code.mjs': CODE_OK, 'guard.test.mjs': GUARD, 'package.json': PKG('node --test guard.test.mjs') },
    { 'package.json': PKG('true') });          // the classic "replace your own test command" move
  try {
    const { code, verdict } = runOn(tmp, base, head);
    assert.strictEqual(code, 2);               // indeterminate, NOT a pass
    assert.strictEqual(verdict.pass, false);
    assert.match(verdict.reason, /manifest/i);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
test('manifest — a non-runtime field (description) stays benign and does not block', () => {
  const PKG = (d) => JSON.stringify({ name: 'x', version: '1.0.0', description: d, scripts: { test: 'node --test guard.test.mjs' } }, null, 2);
  const { tmp, base, head } = mk(TOOLS,
    { 'src/code.mjs': CODE_OK, 'guard.test.mjs': GUARD, 'package.json': PKG('before') },
    { 'package.json': PKG('after') });
  try { assert.strictEqual(runOn(tmp, base, head).code, 0); }
  finally { rmSync(tmp, { recursive: true, force: true }); }
});
