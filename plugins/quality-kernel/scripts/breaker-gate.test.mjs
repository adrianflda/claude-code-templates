import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const gate = join(here, 'breaker-gate.mjs');
const contract = join(here, 'fixtures', 'm2', 'contracts', 'example.md');

// a critical change (src/auth/**) with a green referee -> qk-gate exit 3 (blocked-needs-breaker)
function criticalRepo() {
  const tmp = mkdtempSync(join(tmpdir(), 'qk-bgate-'));
  const git = (...a) => spawnSync('git', ['-C', tmp, ...a], { encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  const w = (p, c) => { const d = join(tmp, p); mkdirSync(dirname(d), { recursive: true }); writeFileSync(d, c); };
  w('.quality-kernel/tools.json', JSON.stringify({ verify: 'node --test x.test.mjs', productionGlobs: ['src/**'] }));
  w('.quality-kernel/critical-surface.json', JSON.stringify({ criticalGlobs: ['**/auth/**'], safeGlobs: ['**/*.md'] }));
  w('x.test.mjs', "import { test } from 'node:test'; import a from 'node:assert'; test('ok', () => a.ok(true));");
  w('src/auth/thing.ts', 'export const x = 1;');
  git('add', '-A'); git('commit', '-qm', 'base'); const base = git('rev-parse', 'HEAD').stdout.trim();
  w('src/auth/thing.ts', 'export const x = 2;');
  git('add', '-A'); git('commit', '-qm', 'change'); const head = git('rev-parse', 'HEAD').stdout.trim();
  return { tmp, base, head };
}
function stub(verdict) {
  const tmp = mkdtempSync(join(tmpdir(), 'qk-brk-'));
  const p = join(tmp, 'stub.mjs');
  writeFileSync(p, `let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{console.log(JSON.stringify({verdict:'${verdict}'}));});`);
  return { tmp, cmd: `node ${p}` };
}
const run = (repo, base, head, extra = []) => spawnSync('node', [gate, '--repo', repo, '--base', base, '--head', head, ...extra], { encoding: 'utf8' });
const json = (r) => JSON.parse((r.stdout || '').trim().split('\n').filter(Boolean).pop());

test('breaker-gate — critical + green referee + NO breaker -> exit 3 (still unenforced)', () => {
  const { tmp, base, head } = criticalRepo();
  try { const r = run(tmp, base, head); assert.strictEqual(r.status, 3); assert.strictEqual(json(r).gate, 'blocked-needs-breaker'); }
  finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('breaker-gate — critical + green referee + breaker PASS -> exit 0', () => {
  const { tmp, base, head } = criticalRepo(); const s = stub('BREAKER_PASS');
  try {
    const r = run(tmp, base, head, ['--breaker', s.cmd, '--contract', contract, '--probe', 'true', '--url', 'http://x']);
    assert.strictEqual(r.status, 0); assert.strictEqual(json(r).gate, 'pass');
  } finally { rmSync(tmp, { recursive: true, force: true }); rmSync(s.tmp, { recursive: true, force: true }); }
});

test('breaker-gate — critical + green referee + breaker FAIL -> exit 1', () => {
  const { tmp, base, head } = criticalRepo(); const s = stub('BREAKER_FAIL');
  try {
    // --probe/--url are REQUIRED now: a breaker with no live target cannot produce a trusted verdict,
    // so they must be supplied to reach the breaker at all (otherwise it fails closed as exit 2).
    const r = run(tmp, base, head, ['--breaker', s.cmd, '--contract', contract, '--probe', 'true', '--url', 'http://x']);
    assert.strictEqual(r.status, 1); assert.strictEqual(json(r).gate, 'breaker-fail');
  } finally { rmSync(tmp, { recursive: true, force: true }); rmSync(s.tmp, { recursive: true, force: true }); }
});

// --- review regression (#25): the contract lint is a PRECONDITION, not a documented prerequisite ---
test('breaker-gate (RED) — a contract with no invariants blocks even with a PASSing breaker', () => {
  const { tmp, base, head } = criticalRepo(); const s = stub('BREAKER_PASS');
  const c = mkdtempSync(join(tmpdir(), 'qk-contract-'));
  try {
    const md = join(c, 'empty.md'), acc = join(c, 'empty.test.mjs');
    writeFileSync(md, '# Contract\n\n## QA procedure\n1. open the app\n');   // no ## Invariants table
    writeFileSync(acc, "import { test } from 'node:test'; test('x', () => {});");
    const r = run(tmp, base, head, ['--breaker', s.cmd, '--contract', md, '--acceptance', acc, '--probe', 'true', '--url', 'http://x']);
    assert.strictEqual(r.status, 3);
    assert.strictEqual(json(r).gate, 'blocked-invalid-contract');
  } finally { [tmp, s.tmp, c].forEach((d) => rmSync(d, { recursive: true, force: true })); }
});

// a critical change that ALSO edits a test file -> referee overlays it -> human review is required
function testChangeRepo() {
  const tmp = mkdtempSync(join(tmpdir(), 'qk-bgate-tc-'));
  const git = (...a) => spawnSync('git', ['-C', tmp, ...a], { encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  const w = (p, c) => { const d = join(tmp, p); mkdirSync(dirname(d), { recursive: true }); writeFileSync(d, c); };
  w('.quality-kernel/tools.json', JSON.stringify({ verify: 'node --test x.test.mjs', productionGlobs: ['src/**'] }));
  w('.quality-kernel/critical-surface.json', JSON.stringify({ criticalGlobs: ['**/auth/**'], safeGlobs: ['**/*.md'] }));
  w('x.test.mjs', "import { test } from 'node:test'; import a from 'node:assert'; test('ok', () => a.ok(true));");
  w('src/auth/thing.ts', 'export const x = 1;');
  git('add', '-A'); git('commit', '-qm', 'base'); const base = git('rev-parse', 'HEAD').stdout.trim();
  w('src/auth/thing.ts', 'export const x = 2;');
  w('x.test.mjs', "import { test } from 'node:test'; import a from 'node:assert'; test('ok', () => a.ok(true)); test('extra', () => a.ok(true));");
  git('add', '-A'); git('commit', '-qm', 'change'); const head = git('rev-parse', 'HEAD').stdout.trim();
  return { tmp, base, head };
}
test('breaker-gate (RED) — a PASSing breaker does NOT clear the human-review cause of exit 3', () => {
  const { tmp, base, head } = testChangeRepo(); const s = stub('BREAKER_PASS');
  try {
    const r = run(tmp, base, head, ['--breaker', s.cmd, '--contract', contract, '--probe', 'true', '--url', 'http://x']);
    const v = json(r);
    assert.strictEqual(v.refereeGate.requiresHumanReview, true, 'the referee overlaid a changed test file');
    assert.strictEqual(r.status, 3, 'a test change is a contract change: the human still owns it');
    assert.strictEqual(v.gate, 'blocked-needs-human-review');
  } finally { [tmp, s.tmp].forEach((d) => rmSync(d, { recursive: true, force: true })); }
});
