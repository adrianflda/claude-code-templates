import './hermetic-git.mjs';
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, existsSync, rmSync, mkdtempSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
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
function runOn(tmp, base, head, env = process.env) {
  const r = spawnSync('node', [referee, '--repo', tmp, '--base', base, '--head', head], { encoding: 'utf8', env });
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

// --- the referee must verify committed bytes, whatever the user's own git config says ---
test('user config — a global attributesFile (export-subst) does not rewrite the verified tree', () => {
  const STAMP = '$Format:%H$';
  const tools = { verify: `node --test guard.test.mjs && grep -qF '${STAMP}' stamp.txt`, productionGlobs: ['src/**'] };
  const { tmp, base, head } = mk(tools, { 'src/code.mjs': CODE_OK, 'guard.test.mjs': GUARD, 'stamp.txt': STAMP },
    { 'src/code.mjs': 'export const f = () => 1; export const g = () => 2;' });
  const cfgDir = mkdtempSync(join(tmpdir(), 'qk-usercfg-'));
  try {
    writeFileSync(join(cfgDir, 'attributes'), 'stamp.txt export-subst\n');
    writeFileSync(join(cfgDir, 'gitconfig'), `[core]\n\tattributesFile = ${join(cfgDir, 'attributes')}\n`);
    const userEnv = { ...process.env, GIT_CONFIG_GLOBAL: join(cfgDir, 'gitconfig') };
    // control: under this config, git archive really does rewrite the committed file
    const plain = spawnSync('git', ['-C', tmp, 'archive', head, 'stamp.txt'], { env: userEnv, encoding: 'utf8' });
    assert.ok(!plain.stdout.includes(STAMP), 'control: the user attributes must rewrite stamp.txt in a plain archive');
    const { code, verdict } = runOn(tmp, base, head, userEnv);
    assert.strictEqual(code, 0, verdict && verdict.reason);
    assert.strictEqual(verdict.pass, true);
  } finally { rmSync(tmp, { recursive: true, force: true }); rmSync(cfgDir, { recursive: true, force: true }); }
});

test('user config — tools.json left out of base by an ignore rule: the reason names the rule', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'qk-ref-ign-'));
  const git = (...a) => spawnSync('git', ['-C', tmp, ...a], { encoding: 'utf8' });
  try {
    git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
    writeFileSync(join(tmp, '.git', 'info', 'exclude'), '.quality-kernel/\n');
    mkdirSync(join(tmp, '.quality-kernel')); mkdirSync(join(tmp, 'src'));
    writeFileSync(join(tmp, '.quality-kernel', 'tools.json'), JSON.stringify(TOOLS));
    writeFileSync(join(tmp, 'src', 'code.mjs'), CODE_OK);
    git('add', '-A'); git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD').stdout.trim();
    writeFileSync(join(tmp, 'src', 'code.mjs'), 'export const f = () => 2;');
    git('commit', '-qam', 'change');
    const { code, verdict } = runOn(tmp, base, 'HEAD');
    assert.strictEqual(code, 2);
    assert.match(verdict.reason, /no \.quality-kernel\/tools\.json at base/);
    assert.match(verdict.reason, /ignored by git \(\.git\/info\/exclude:1: "\.quality-kernel\/"\)/);
    assert.match(verdict.reason, /git add -f \.quality-kernel\/tools\.json/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('user config — tools.json truly absent: no ignore hint is invented', () => {
  const { tmp, base, head } = mk(TOOLS, { 'src/code.mjs': CODE_OK }, { 'src/code.mjs': 'export const f = () => 2;' });
  try {
    const git = (...a) => spawnSync('git', ['-C', tmp, ...a], { encoding: 'utf8' });
    git('rm', '-q', '.quality-kernel/tools.json'); git('commit', '-qm', 'drop contract');
    const noContract = git('rev-parse', 'HEAD').stdout.trim();
    const { code, verdict } = runOn(tmp, noContract, head);
    assert.strictEqual(code, 2);
    assert.match(verdict.reason, /no \.quality-kernel\/tools\.json at base/);
    assert.doesNotMatch(verdict.reason, /ignored by git/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// --- temp trees must not outlive the run, including indeterminate exits ---
for (const [name, tools, change] of [
  ['a verdict', TOOLS, { 'src/code.mjs': 'export const f = () => 1; export const g = () => 2;' }],
  ['an indeterminate exit after the tree is built', { verify: 'this-command-does-not-exist-xyz', productionGlobs: ['src/**'] }, { 'src/code.mjs': 'export const f = () => 2;' }],
]) {
  test(`temp cleanup — ${name} leaves nothing in TMPDIR`, () => {
    const { tmp, base, head } = mk(tools, { 'src/code.mjs': CODE_OK, 'guard.test.mjs': GUARD }, change);
    const privTmp = mkdtempSync(join(tmpdir(), 'qk-privtmp-'));
    try {
      const { code } = runOn(tmp, base, head, { ...process.env, TMPDIR: privTmp });
      assert.ok(code === 0 || code === 2, `unexpected exit ${code}`);
      assert.deepStrictEqual(readdirSync(privTmp), []);
    } finally { rmSync(tmp, { recursive: true, force: true }); rmSync(privTmp, { recursive: true, force: true }); }
  });
}
