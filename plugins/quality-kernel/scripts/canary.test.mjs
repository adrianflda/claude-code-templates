import './hermetic-git.mjs';
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { sabotage, canaryMatcher } from './canary.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const referee = join(here, 'referee.mjs');

// A committed repo whose base and head are the same commit (the /init-workspace verify case).
function repoWith(tools, files) {
  const tmp = mkdtempSync(join(tmpdir(), 'qk-canary-'));
  const git = (...a) => spawnSync('git', ['-C', tmp, ...a], { encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  const write = (p, c) => { const d = join(tmp, p); mkdirSync(dirname(d), { recursive: true }); writeFileSync(d, c); };
  write('.quality-kernel/tools.json', JSON.stringify(tools));
  for (const [p, c] of Object.entries(files)) write(p, c);
  git('add', '-A'); git('commit', '-qm', 'base');
  return { tmp, sha: git('rev-parse', 'HEAD').stdout.trim(), git };
}
function referee$(tmp, sha, extra = ['--canary']) {
  const r = spawnSync('node', [referee, '--repo', tmp, '--base', sha, '--head', sha, '--no-ledger', ...extra], { encoding: 'utf8' });
  let verdict = null;
  try { verdict = JSON.parse((r.stdout || '').trim().split('\n').filter(Boolean).pop()); } catch { /* null */ }
  return { code: r.status, verdict };
}
const PASSING = { 'src/code.mjs': 'export const f = () => 1;', 'guard.test.mjs': "import { test } from 'node:test'; import a from 'node:assert'; import { f } from './src/code.mjs'; test('g', () => a.strictEqual(f(), 1));" };
const tools = (verify) => ({ verify, productionGlobs: ['src/**'] });

test('an honest suite passes the canary: green run, canary RED, exit 0', () => {
  const { tmp, sha } = repoWith(tools('node --test guard.test.mjs'), PASSING);
  try {
    const { code, verdict } = referee$(tmp, sha);
    assert.strictEqual(code, 0, JSON.stringify(verdict));
    assert.strictEqual(verdict.pass, true);
    assert.notStrictEqual(verdict.canary.exit, 0);
    assert.strictEqual(verdict.canary.sabotaged, 1);
    assert.strictEqual(verdict.canary.proven, true);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// The four no-op shapes the round-3 critic reproduced, as the shell sees them after building.
for (const [name, verify] of [
  ['a command that runs nothing', 'node -e ""'],
  ['a failure swallowed by || true', 'node --test guard.test.mjs || true'],
  ['a runner started with no test files', 'node --test src/code.mjs'],
  ['an ignore-errors wrapper (make -i style)', 'node --test guard.test.mjs; exit 0'],
]) {
  test(`a no-op verify is NOT verified by the canary: ${name} -> exit 2, canary green`, () => {
    const { tmp, sha } = repoWith(tools(verify), PASSING);
    try {
      const { code, verdict } = referee$(tmp, sha);
      assert.strictEqual(code, 2, JSON.stringify(verdict));
      assert.strictEqual(verdict.pass, false);
      assert.strictEqual(verdict.indeterminate, true);
      assert.strictEqual(verdict.canary.exit, 0);
      assert.strictEqual(verdict.canary.proven, false);
      assert.match(verdict.reason, /RED canary stayed green/);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
}

test('without --canary the gate is unchanged: the same no-op still passes (opt-in, backward compatible)', () => {
  const { tmp, sha } = repoWith(tools('node -e ""'), PASSING);
  try {
    const { code, verdict } = referee$(tmp, sha, []);
    assert.strictEqual(code, 0);
    assert.strictEqual(verdict.canary, undefined);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('no test file to sabotage -> indeterminate (a command never seen RED is not verified)', () => {
  const { tmp, sha } = repoWith(tools('node src/code.mjs'), { 'src/code.mjs': 'export const f = () => 1;' });
  try {
    const { code, verdict } = referee$(tmp, sha);
    assert.strictEqual(code, 2);
    assert.deepStrictEqual(verdict.canary, { proven: false, sabotaged: 0, exit: null });
    assert.match(verdict.reason, /no JS\/TS\/Python test file to sabotage/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('narrow declared testGlobs cannot dodge the canary: conventions are sabotaged too', () => {
  const t = { ...tools('node --test guard.test.mjs'), testGlobs: ['nothing-here/**'] };
  const { tmp, sha } = repoWith(t, PASSING);
  try {
    const { code, verdict } = referee$(tmp, sha);
    assert.strictEqual(code, 0, JSON.stringify(verdict));
    assert.strictEqual(verdict.canary.sabotaged, 1);
    assert.notStrictEqual(verdict.canary.exit, 0);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('the canary never touches the repo: worktree and committed bytes are unchanged', () => {
  const { tmp, sha, git } = repoWith(tools('node --test guard.test.mjs'), PASSING);
  try {
    referee$(tmp, sha);
    assert.strictEqual(git('status', '--porcelain').stdout, '');
    assert.strictEqual(readFileSync(join(tmp, 'guard.test.mjs'), 'utf8'), PASSING['guard.test.mjs']);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('sabotage: JS/TS raise first, after a shebang; Python after shebang + encoding; other files untouched', () => {
  assert.strictEqual(sabotage('a.test.js', 'x();').toString(), 'throw new Error("quality-kernel canary: this run must fail");\nx();');
  assert.strictEqual(sabotage('a.test.ts', '#!/usr/bin/env node\nx();').toString(), '#!/usr/bin/env node\nthrow new Error("quality-kernel canary: this run must fail");\nx();');
  assert.strictEqual(sabotage('test_a.py', '#!/usr/bin/env python\n# -*- coding: utf-8 -*-\nimport os').toString(),
    '#!/usr/bin/env python\n# -*- coding: utf-8 -*-\nraise RuntimeError("quality-kernel canary: this run must fail")\nimport os');
  assert.strictEqual(sabotage('a.test.json', '{}'), null);
  assert.strictEqual(sabotage('README.md', '# x'), null);
});

test('canaryMatcher: test conventions of JS and Python, never production or non-code files', () => {
  const m = canaryMatcher([]);
  for (const p of ['src/a.test.js', 'src/__tests__/b.jsx', 'tests/test_views.py', 'app/tests.py', 'pkg/x_test.py', 'e2e/login.spec.ts', 'test/unit.mjs']) assert.ok(m(p), p);
  for (const p of ['src/app.js', 'manage.py', 'src/a.test.snap', 'tests/data.json', 'README.md']) assert.ok(!m(p), p);
  assert.ok(canaryMatcher(['checks/**'])('checks/run.mjs'), 'declared testGlobs are added');
});

// Round-4 finding H2: a setup step that restores the test files would undo the sabotage unseen.
test('a verify/setup chain that restores the sabotaged test files -> not proven (exit 2)', () => {
  // Only the canary copy is touched: the setup restores the file when it finds the canary marker.
  const t = { ...tools('node --test guard.test.mjs'), verifySetup: 'if grep -q "quality-kernel canary" guard.test.mjs; then cp .orig guard.test.mjs; fi' };
  const files = { ...PASSING, '.orig': PASSING['guard.test.mjs'] };
  const { tmp, sha } = repoWith(t, files);
  try {
    const { code, verdict } = referee$(tmp, sha);
    assert.strictEqual(code, 2, JSON.stringify(verdict));
    assert.strictEqual(verdict.canary.proven, false);
    assert.match(verdict.reason, /rewrote or removed a sabotaged test file \("guard\.test\.mjs"\)/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// QA round-4 HIGH-1: the Python path end to end through the real referee and a real interpreter.
const python = spawnSync('python3', ['-c', 'import unittest'], { encoding: 'utf8' }).status === 0;
const PY = { 'src/calc.py': 'def add(a, b):\n    return a + b\n', 'tests/test_calc.py': '#!/usr/bin/env python3\n# -*- coding: utf-8 -*-\nimport unittest, sys\nsys.path.insert(0, "src")\nfrom calc import add\nclass T(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(2, 2), 4)\n' };
test('Python: an honest unittest suite is proven (canary RED); a swallowed one is not', { skip: python ? false : 'python3 not available' }, () => {
  const run = 'PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests';
  for (const [verify, proven] of [[run, true], [`${run} || true`, false]]) {
    const { tmp, sha } = repoWith(tools(verify), PY);
    try {
      const { code, verdict } = referee$(tmp, sha);
      assert.strictEqual(code, proven ? 0 : 2, JSON.stringify(verdict));
      assert.strictEqual(verdict.canary.proven, proven);
      assert.strictEqual(verdict.canary.sabotaged, 1);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }
});

// QA round-4 MEDIUM-5: TypeScript/ESM test files are sabotaged and still fail to load.
test('an ESM .test.mts file is sabotaged and the canary goes RED', () => {
  const files = { 'src/code.mjs': 'export const f = () => 1;', 'guard.test.mts': "import { test } from 'node:test';\ntest('g', () => {});\n" };
  const strip = spawnSync('node', ['--experimental-strip-types', '-e', '0'], { encoding: 'utf8' }).status === 0;
  const { tmp, sha } = repoWith(tools(`node ${strip ? '--experimental-strip-types ' : ''}--test guard.test.mts`), files);
  try {
    const { code, verdict } = referee$(tmp, sha);
    assert.strictEqual(code, 0, JSON.stringify(verdict));
    assert.strictEqual(verdict.canary.proven, true);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
