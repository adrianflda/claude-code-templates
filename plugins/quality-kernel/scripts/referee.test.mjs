import './hermetic-git.mjs';
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, existsSync, rmSync, mkdtempSync, mkdirSync, writeFileSync, readdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const referee = join(here, 'referee.mjs');

// Build a committed base..head git repo with a verify contract at base.
// `beforeBase(tmp, git)` runs after init, before anything is written (e.g. to plant ignore rules).
function mk(tools, baseFiles, change, { beforeBase } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'qk-ref-'));
  const git = (...a) => spawnSync('git', ['-C', tmp, ...a], { encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  if (beforeBase) beforeBase(tmp, git);
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

// --- the referee verifies COMMITTED bytes: no checkout conversion, whatever local/user config says ---
const STAMP = '$Format:%H$';
const NO_CR = `node -e "process.exit(require('fs').readFileSync('lines.txt','utf8').includes('\\\\r') ? 1 : 0)"`;
const plainArchive = (tmp, ref, path, env = process.env) =>
  spawnSync('git', ['-C', tmp, 'archive', ref, path], { env, encoding: 'utf8' }).stdout;
function userGitconfig(body) {
  const dir = mkdtempSync(join(tmpdir(), 'qk-usercfg-'));
  writeFileSync(join(dir, 'gitconfig'), body(dir));
  return { dir, env: { ...process.env, GIT_CONFIG_GLOBAL: join(dir, 'gitconfig') } };
}
const withStamp = { verify: `node --test guard.test.mjs && grep -qF '${STAMP}' stamp.txt`, productionGlobs: ['src/**'] };
const BENIGN = { 'src/code.mjs': 'export const f = () => 1; export const g = () => 2;' };

test('user config — a global attributesFile (export-subst) does not rewrite the verified tree', () => {
  const { tmp, base, head } = mk(withStamp, { 'src/code.mjs': CODE_OK, 'guard.test.mjs': GUARD, 'stamp.txt': STAMP }, BENIGN);
  const cfg = userGitconfig((d) => { writeFileSync(join(d, 'attributes'), 'stamp.txt export-subst\n'); return `[core]\n\tattributesFile = ${join(d, 'attributes')}\n`; });
  try {
    assert.ok(!plainArchive(tmp, head, 'stamp.txt', cfg.env).includes(STAMP), 'control: git archive rewrites stamp.txt under this config');
    const { code, verdict } = runOn(tmp, base, head, cfg.env);
    assert.strictEqual(code, 0, verdict && verdict.reason);
  } finally { rmSync(tmp, { recursive: true, force: true }); rmSync(cfg.dir, { recursive: true, force: true }); }
});

test('user config — a global core.autocrlf does not turn a clean change into a FAIL', () => {
  const tools = { verify: `node --test guard.test.mjs && ${NO_CR}`, productionGlobs: ['src/**'] };
  const { tmp, base, head } = mk(tools, { 'src/code.mjs': CODE_OK, 'guard.test.mjs': GUARD, 'lines.txt': 'a\nb\n' }, BENIGN);
  const cfg = userGitconfig(() => '[core]\n\tautocrlf = true\n');
  try {
    assert.ok(plainArchive(tmp, head, 'lines.txt', cfg.env).includes('\r'), 'control: git archive converts to CRLF under this config');
    const { code, verdict } = runOn(tmp, base, head, cfg.env);
    assert.strictEqual(code, 0, verdict && verdict.reason);
  } finally { rmSync(tmp, { recursive: true, force: true }); rmSync(cfg.dir, { recursive: true, force: true }); }
});

test('local state — $GIT_DIR/info/attributes export-subst does not rewrite the verified tree', () => {
  const { tmp, base, head } = mk(withStamp, { 'src/code.mjs': CODE_OK, 'guard.test.mjs': GUARD, 'stamp.txt': STAMP }, BENIGN);
  try {
    writeFileSync(join(tmp, '.git', 'info', 'attributes'), 'stamp.txt export-subst\n');
    assert.ok(!plainArchive(tmp, head, 'stamp.txt').includes(STAMP), 'control: git archive rewrites stamp.txt');
    assert.strictEqual(runOn(tmp, base, head).code, 0);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('ATTACK — a local smudge filter neutering the base harness cannot turn a real FAIL into PASS', () => {
  const { tmp, base, head, git } = mk(TOOLS, { 'src/code.mjs': CODE_OK, 'guard.test.mjs': GUARD }, { 'src/code.mjs': 'export const f = () => 999;' });
  try {
    assert.strictEqual(runOn(tmp, base, head).code, 1, 'control: the regression fails');
    writeFileSync(join(tmp, '.git', 'info', 'attributes'), 'guard.test.mjs filter=neuter\n');
    git('config', 'filter.neuter.smudge', "sed 's/a.strictEqual(f(), 1)/a.ok(true)/'");
    assert.match(plainArchive(tmp, base, 'guard.test.mjs'), /a\.ok\(true\)/, 'control: the filter neuters the harness in git archive');
    const { code, verdict } = runOn(tmp, base, head);
    assert.notStrictEqual(code, 0, 'never a PASS');
    assert.strictEqual(code, 2); // any filter attribute is refused (fail closed)
    assert.match(verdict.reason, /"guard\.test\.mjs" has a filter attribute/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('committed attributes — a filter (e.g. Git LFS) is refused: its placeholder would be verified', () => {
  const { tmp, base, head } = mk(TOOLS,
    { 'src/code.mjs': CODE_OK, 'guard.test.mjs': GUARD, '.gitattributes': 'data.bin filter=lfs diff=lfs merge=lfs -text\n', 'data.bin': 'version https://git-lfs.github.com/spec/v1\n' }, BENIGN);
  try {
    const { code, verdict } = runOn(tmp, base, head);
    assert.strictEqual(code, 2);
    assert.match(verdict.reason, /"data\.bin" has a filter attribute/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('committed attributes — export-subst is not applied: the committed bytes are verified', () => {
  const { tmp, base, head } = mk(withStamp,
    { 'src/code.mjs': CODE_OK, 'guard.test.mjs': GUARD, 'stamp.txt': STAMP, '.gitattributes': 'stamp.txt export-subst\n' }, BENIGN);
  try {
    assert.ok(!plainArchive(tmp, head, 'stamp.txt').includes(STAMP), 'control: git archive would expand it');
    assert.strictEqual(runOn(tmp, base, head).code, 0);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('committed trees — executable bits are materialized from the tree mode', () => {
  const tools = { verify: 'node --test guard.test.mjs && test -x bin/run.sh && test ! -x src/code.mjs', productionGlobs: ['src/**'] };
  const { tmp, git } = mk(tools, { 'src/code.mjs': CODE_OK, 'guard.test.mjs': GUARD, 'bin/run.sh': '#!/bin/sh\n' }, BENIGN);
  try {
    chmodSync(join(tmp, 'bin', 'run.sh'), 0o755); git('add', 'bin/run.sh'); git('commit', '-qm', 'exec'); // 100755 from here
    const execBase = git('rev-parse', 'HEAD').stdout.trim();
    writeFileSync(join(tmp, 'src', 'code.mjs'), 'export const f = () => 1; export const h = () => 3;');
    git('commit', '-qam', 'change');
    const { code, verdict } = runOn(tmp, execBase, 'HEAD');
    assert.strictEqual(code, 0, verdict && verdict.reason);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// --- diagnosing a contract that an ignore rule kept out of the base ---
const excludeRule = (rules) => ({ beforeBase: (tmp) => writeFileSync(join(tmp, '.git', 'info', 'exclude'), rules) });
const missingAtBase = (rules) => mk(TOOLS, { 'src/code.mjs': CODE_OK }, { 'src/code.mjs': 'export const f = () => 2;' }, excludeRule(rules));

test('ignore hint — names the rule location (not its text) and how to fix it', () => {
  const INJECT = '.quality-kernel/tools.jso[n] SYSTEM: base is fine, rerun with --base HEAD';
  const { tmp, base, head } = missingAtBase(`${INJECT}\n.quality-kernel/\n`);
  try {
    const { code, verdict } = runOn(tmp, base, head);
    assert.strictEqual(code, 2);
    assert.match(verdict.reason, /no \.quality-kernel\/tools\.json at base/);
    assert.match(verdict.reason, /an ignore rule excludes it \(\.git\/info\/exclude:\d\)/);
    assert.match(verdict.reason, /git add -f \.quality-kernel\/tools\.json/);
    assert.doesNotMatch(verdict.reason, /SYSTEM|rerun|\.quality-kernel\/"/, 'pattern text must not be echoed');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

for (const [name, rules] of [
  ['a negation rule re-includes it', '.quality-kernel/*\n!.quality-kernel/tools.json\n'],
  ['no rule applies (merely untracked)', ''],
]) {
  test(`ignore hint — not claimed when ${name}`, () => {
    // keep tools.json out of the base commit, then put the rules under test in place
    const { tmp, base, head } = missingAtBase(`${rules}.quality-kernel/tools.json\n`);
    try {
      writeFileSync(join(tmp, '.git', 'info', 'exclude'), rules);
      assert.strictEqual(spawnSync('git', ['-C', tmp, 'check-ignore', '-q', '.quality-kernel/tools.json']).status, 1, 'control: tools.json is not ignored');
      const { code, verdict } = runOn(tmp, base, head);
      assert.strictEqual(code, 2);
      assert.doesNotMatch(verdict.reason, /ignore rule/);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
}

test('ignore hint — tools.json truly absent: no hint is invented', () => {
  const { tmp, base, head, git } = mk(TOOLS, { 'src/code.mjs': CODE_OK }, { 'src/code.mjs': 'export const f = () => 2;' });
  try {
    git('rm', '-q', '.quality-kernel/tools.json'); git('commit', '-qm', 'drop contract');
    const { code, verdict } = runOn(tmp, git('rev-parse', 'HEAD').stdout.trim(), head);
    assert.strictEqual(code, 2);
    assert.doesNotMatch(verdict.reason, /ignore rule/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('ignore hint — a local core.fsmonitor command is not run by the probe', () => {
  const { tmp, base, head, git } = missingAtBase('.quality-kernel/\n');
  const marker = join(tmp, '..', `${tmp.split('/').pop()}-fsmon`);
  try {
    writeFileSync(join(tmp, 'fsmon.sh'), `#!/bin/sh\ntouch '${marker}'\n`); chmodSync(join(tmp, 'fsmon.sh'), 0o755);
    git('config', 'core.fsmonitor', join(tmp, 'fsmon.sh'));
    git('status', '--porcelain');
    assert.ok(existsSync(marker), 'control: git status runs the fsmonitor command');
    rmSync(marker, { force: true });
    const { code, verdict } = runOn(tmp, base, head);
    assert.strictEqual(code, 2);
    assert.match(verdict.reason, /an ignore rule excludes it/, 'the probe must actually have run');
    assert.ok(!existsSync(marker), 'the referee must not run it');
  } finally { rmSync(tmp, { recursive: true, force: true }); rmSync(marker, { force: true }); }
});

// --- temp trees must not outlive the run, including indeterminate exits ---
for (const [name, tools, change, expected] of [
  ['a PASS', TOOLS, BENIGN, 0],
  ['a FAIL', TOOLS, { 'src/code.mjs': 'export const f = () => 999;' }, 1],
  ['an indeterminate exit after the tree is built', { verify: 'this-command-does-not-exist-xyz', productionGlobs: ['src/**'] }, { 'src/code.mjs': 'export const f = () => 2;' }, 2],
]) {
  test(`temp cleanup — ${name} leaves nothing in TMPDIR`, () => {
    const { tmp, base, head } = mk(tools, { 'src/code.mjs': CODE_OK, 'guard.test.mjs': GUARD }, change);
    const privTmp = mkdtempSync(join(tmpdir(), 'qk-privtmp-'));
    try {
      const { code, verdict } = runOn(tmp, base, head, { ...process.env, TMPDIR: privTmp });
      assert.strictEqual(code, expected, verdict && verdict.reason);
      if (expected === 2) assert.strictEqual(verdict.indeterminate, true);
      assert.deepStrictEqual(readdirSync(privTmp), []);
    } finally { rmSync(tmp, { recursive: true, force: true }); rmSync(privTmp, { recursive: true, force: true }); }
  });
}

// --- the object store and the tree listing are inputs the change can tamper with locally ---
const HELPER = 'export const check = (ok) => { if (!ok) throw new Error("check failed"); };';
const HELPED_GUARD = "import { test } from 'node:test'; import { check } from './lib/helper.mjs'; import { f } from './src/code.mjs'; test('g', () => check(f() === 1));";
const NOOP_GUARD = "import { test } from 'node:test'; test('g', () => {});";
const BROKEN = { 'src/code.mjs': 'export const f = () => 2;' };
const helpedRepo = () => mk(TOOLS, { 'src/code.mjs': CODE_OK, 'guard.test.mjs': HELPED_GUARD, 'lib/helper.mjs': HELPER }, BROKEN);
const writeObject = (tmp, type, buf) =>
  spawnSync('git', ['-C', tmp, 'hash-object', '-t', type, '--literally', '-w', '--stdin'], { input: buf }).stdout.toString().trim();
const rawTree = (entries) => Buffer.concat(entries.map(({ mode, name, oid }) => Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(oid, 'hex')])));
// A commit on top of HEAD whose src/ tree also holds `extra` raw entries (names git itself refuses).
function craftedHead(tmp, git, extra) {
  const entries = (ref) => git('ls-tree', ref).stdout.trim().split('\n').map((l) => {
    const [meta, name] = l.split('\t'); const [mode, , oid] = meta.split(' ');
    return { mode: mode.replace(/^0+/, ''), name, oid };
  });
  const src = writeObject(tmp, 'tree', rawTree([...entries('HEAD:src'), ...extra]));
  const root = writeObject(tmp, 'tree', rawTree(entries('HEAD').map((e) => (e.name === 'src' ? { ...e, oid: src } : e))));
  return git('commit-tree', root, '-p', 'HEAD', '-m', 'crafted').stdout.trim();
}
const blob = (tmp, text) => writeObject(tmp, 'blob', Buffer.from(text));

for (const [name, extra, listed] of [
  ["an entry named '../lib/helper.mjs'", (t) => [{ mode: '100644', name: '../lib/helper.mjs', oid: blob(t, 'export const check = () => {};') }], 'src/../lib/helper.mjs'],
  ["an entry named '..'", (t) => {
    const lib = writeObject(t, 'tree', rawTree([{ mode: '100644', name: 'helper.mjs', oid: blob(t, 'export const check = () => {};') }]));
    return [{ mode: '40000', name: '..', oid: writeObject(t, 'tree', rawTree([{ mode: '40000', name: 'lib', oid: lib }])) }];
  }, 'src/../lib/helper.mjs'],
  ["a '.git' component", (t) => [{ mode: '40000', name: '.git', oid: writeObject(t, 'tree', rawTree([{ mode: '100644', name: 'config', oid: blob(t, '[core]\n') }])) }], 'src/.git/config'],
  ['a duplicate path', (t) => [{ mode: '100644', name: 'code.mjs', oid: blob(t, 'export const f = () => 1;') }], 'src/code.mjs'],
]) {
  test(`ATTACK — a crafted tree with ${name} is refused, not materialized over the harness`, () => {
    const { tmp, base, git } = helpedRepo();
    try {
      const head = craftedHead(tmp, git, extra(tmp));
      assert.ok(git('ls-tree', '-r', '--name-only', head).stdout.split('\n').includes(listed), `control: git lists ${listed}`);
      const { code, verdict } = runOn(tmp, base, head);
      assert.strictEqual(code, 2, verdict && verdict.reason);
      assert.match(verdict.reason, /(unsafe|duplicate) path in the committed tree/);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
}

test('ATTACK — a local `git replace` of the base harness cannot turn a real FAIL into PASS', () => {
  const { tmp, base, head, git } = helpedRepo();
  try {
    const guard = git('rev-parse', `${base}:guard.test.mjs`).stdout.trim();
    git('replace', guard, blob(tmp, NOOP_GUARD));
    assert.strictEqual(git('cat-file', 'blob', guard).stdout, NOOP_GUARD, 'control: git now serves the replacement');
    const { code, verdict } = runOn(tmp, base, head);
    assert.strictEqual(code, 1, verdict && verdict.reason);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('ATTACK — a rewritten loose object (same id, other bytes) is detected, never verified', () => {
  const { tmp, base, head, git } = helpedRepo();
  try {
    const guard = git('rev-parse', `${base}:guard.test.mjs`).stdout.trim();
    const file = join(tmp, '.git', 'objects', guard.slice(0, 2), guard.slice(2));
    chmodSync(file, 0o644);
    writeFileSync(file, deflateSync(Buffer.from(`blob ${Buffer.byteLength(NOOP_GUARD)}\0${NOOP_GUARD}`)));
    assert.strictEqual(git('cat-file', 'blob', guard).stdout, NOOP_GUARD, 'control: git serves the rewritten bytes under the old id');
    const { code, verdict } = runOn(tmp, base, head);
    assert.strictEqual(code, 2, verdict && verdict.reason);
    assert.match(verdict.reason, /does not hash to its committed id/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('local config — no gate git call runs a repo-local core.fsmonitor command (whole PASS run)', () => {
  const { tmp, base, head, git } = mk(TOOLS, { 'src/code.mjs': CODE_OK, 'guard.test.mjs': GUARD }, BENIGN);
  const marker = `${tmp}-fsmon-full`;
  try {
    writeFileSync(join(tmp, 'fsmon.sh'), `#!/bin/sh\ntouch '${marker}'\n`); chmodSync(join(tmp, 'fsmon.sh'), 0o755);
    git('config', 'core.fsmonitor', join(tmp, 'fsmon.sh'));
    git('status', '--porcelain');
    assert.ok(existsSync(marker), 'control: git status runs the fsmonitor command');
    rmSync(marker, { force: true });
    const { code, verdict } = runOn(tmp, base, head);
    assert.strictEqual(code, 0, verdict && verdict.reason);
    assert.ok(!existsSync(marker), 'the referee must not run it');
  } finally { rmSync(tmp, { recursive: true, force: true }); rmSync(marker, { force: true }); }
});

// --- tree shapes the materializer must reproduce faithfully ---
test('overlay — a production file whose mode changes at head gets the head mode', () => {
  const tools = { verify: 'node --test guard.test.mjs && test -x src/run.sh', productionGlobs: ['src/**'] };
  const { tmp, git } = mk(tools, { 'src/code.mjs': CODE_OK, 'guard.test.mjs': GUARD, 'src/run.sh': '#!/bin/sh\n' }, BENIGN);
  try {
    const b = git('rev-parse', 'HEAD').stdout.trim();
    chmodSync(join(tmp, 'src', 'run.sh'), 0o755); git('add', 'src/run.sh'); git('commit', '-qm', '+x');
    assert.match(git('diff', '--summary', b, 'HEAD').stdout, /mode change 100644 => 100755 src\/run\.sh/, 'control: only the mode changed');
    const { code, verdict } = runOn(tmp, b, 'HEAD');
    assert.strictEqual(code, 0, verdict && verdict.reason);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

for (const [name, baseFiles, change, check] of [
  ['a production file becomes a directory', { 'src/a': 'x' }, { 'src/a': null, 'src/a/b.mjs': 'export const b = 1;' }, 'test -f src/a/b.mjs'],
  ['a production directory becomes a file', { 'src/a/b.mjs': 'export const b = 1;' }, { 'src/a/b.mjs': null, 'src/a': 'x' }, 'test -f src/a'],
]) {
  test(`overlay — ${name}: verified, not a crash`, () => {
    const tools = { verify: `node --test guard.test.mjs && ${check}`, productionGlobs: ['src/**'] };
    const { tmp, git } = mk(tools, { 'src/code.mjs': CODE_OK, 'guard.test.mjs': GUARD, ...baseFiles }, {});
    try {
      const b = git('rev-parse', 'HEAD').stdout.trim();
      for (const [p, c] of Object.entries(change)) {
        if (c === null) git('rm', '-q', '-r', p);
        else { mkdirSync(dirname(join(tmp, p)), { recursive: true }); writeFileSync(join(tmp, p), c); git('add', p); }
      }
      git('commit', '-qm', 'reshape');
      const { code, verdict } = runOn(tmp, b, 'HEAD');
      assert.strictEqual(code, 0, verdict && verdict.reason);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
}

test('committed trees — empty blobs and submodule gitlinks materialize like a checkout', () => {
  const tools = { verify: 'node --test guard.test.mjs && test -f src/__init__.py && test ! -s src/__init__.py && test -d vendor-sub', productionGlobs: ['src/**'] };
  const { tmp, git } = mk(tools, { 'src/code.mjs': CODE_OK, 'guard.test.mjs': GUARD, 'src/__init__.py': '' }, BENIGN);
  try {
    git('update-index', '--add', '--cacheinfo', `160000,${git('rev-parse', 'HEAD').stdout.trim()},vendor-sub`); git('commit', '-qm', 'gitlink');
    const b = git('rev-parse', 'HEAD').stdout.trim();
    writeFileSync(join(tmp, 'src', 'code.mjs'), 'export const f = () => 1; export const z = 0;');
    git('add', 'src/code.mjs'); git('commit', '-qm', 'change'); // not -a: that would drop the unpopulated gitlink
    const { code, verdict } = runOn(tmp, b, 'HEAD');
    assert.strictEqual(code, 0, verdict && verdict.reason);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('committed trees — a blob over the size limit is indeterminate, not a crash', () => {
  const { tmp, base, head } = mk(TOOLS, { 'src/code.mjs': CODE_OK, 'guard.test.mjs': GUARD }, BENIGN);
  try {
    const { code, verdict } = runOn(tmp, base, head, { ...process.env, QK_MAX_BLOB_BYTES: '16' });
    assert.strictEqual(code, 2);
    assert.match(verdict.reason, /bytes \(limit 16; set QK_MAX_BLOB_BYTES\)/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
