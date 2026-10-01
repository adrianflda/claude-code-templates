import './hermetic-git.mjs';
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { propose } from './ws-propose.mjs';
import { verify } from './ws-verify.mjs';

// Phase 3 of /init-workspace: every proposed gate config is RE-EXECUTED through qk-gate (base..base,
// pinned to the proposal commit) and labelled; the labels are committed to the proposal branch.
const gitIn = (dir) => (...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
function write(dir, p, c) { const d = join(dir, p); mkdirSync(dirname(d), { recursive: true }); writeFileSync(d, c); }
const AUTHOR = { name: 't', email: 't@t' };
const GUARD_OK = "import { test } from 'node:test'; import a from 'node:assert'; import { f } from './src/code.mjs'; test('g', () => a.strictEqual(f(), 1));";
function app(org, name, { code = 'export const f = () => 1;', files = {} } = {}) {
  const dir = join(org, name); mkdirSync(dir);
  const git = gitIn(dir);
  git('init', '-q', '-b', 'development'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  write(dir, 'src/code.mjs', code); write(dir, 'guard.test.mjs', GUARD_OK);
  write(dir, 'package.json', JSON.stringify({ scripts: { test: 'node --test guard.test.mjs' } }));
  for (const [p, c] of Object.entries(files)) write(dir, p, c);
  git('add', '-A'); git('commit', '-qm', 'init');
}
const result = (name, over = {}) => ({
  name, role: 'app', harnessOf: null, base: 'development', verify: { runner: 'npm-script', script: 'test' },
  productionGlobs: ['src/**'], testGlobs: ['guard.test.mjs'], linkPaths: [], criticalGlobs: [], safeGlobs: [],
  localEnv: { state: 'native', proposal: null }, evidence: [{ claim: 'x', at: 'guard.test.mjs:1' }], notes: [], ...over,
});
function setup(apps) {
  const org = realpathSync(mkdtempSync(join(tmpdir(), 'qk-ver-')));
  for (const [name, opts] of Object.entries(apps)) app(org, name, opts);
  const results = Object.entries(apps).map(([n, o]) => result(n, o.result));
  const p = propose({ org, date: '2026-09-29', results, author: AUTHOR, forbidden: Object.entries(apps).filter(([, o]) => o.forbidden).map(([n]) => n) });
  return { org, ws: join(org, 'workspace'), branch: p.branch, approved: p.sha };
}
const label = (r, n) => r.results.find((x) => x.name === n);

test('a suite that runs and passes is "verified"; the labels are committed to the proposal branch', () => {
  const s = setup({ a: {} });
  const mainBefore = gitIn(s.ws)('rev-parse', 'main').stdout.trim();
  const r = verify({ org: s.org, branch: s.branch, approved: s.approved, author: AUTHOR });
  assert.strictEqual(label(r, 'a').label, 'verified', JSON.stringify(r));
  const committed = JSON.parse(gitIn(s.ws)('show', `${s.branch}:verification.json`).stdout);
  assert.strictEqual(committed.results[0].label, 'verified');
  assert.match(gitIn(s.ws)('show', `${s.branch}:INIT-REPORT.md`).stdout, /\| a \| app \| development \| native \| tools\.json \+ critical-surface\.json \| verified \|/);
  assert.strictEqual(gitIn(s.ws)('rev-parse', 'main').stdout.trim(), mainBefore, 'main untouched');
});

test('a suite that runs but fails at base is "runs-but-fails" (a finding, not a pass)', () => {
  const s = setup({ a: { code: 'export const f = () => 2;' } });
  assert.strictEqual(label(verify({ org: s.org, branch: s.branch, approved: s.approved, author: AUTHOR }), 'a').label, 'runs-but-fails');
});

// Round-3 vector: a verify command that passes whatever the tests say. The repo's own `npm test`
// swallows failures here; the RED canary (every test file raising) must still expose it.
test('a suite that stays green with every test file raising is "not-proven", never "verified"', () => {
  const s = setup({ a: { files: { 'package.json': JSON.stringify({ scripts: { test: 'node --test guard.test.mjs || true' } }) } } });
  const l = label(verify({ org: s.org, branch: s.branch, approved: s.approved, author: AUTHOR }), 'a');
  assert.strictEqual(l.label, 'not-proven', JSON.stringify(l));
  assert.match(l.reason, /RED canary stayed green/);
  assert.match(gitIn(s.ws)('show', `${s.branch}:INIT-REPORT.md`).stdout, /\| a \| app \| development \| native \| tools\.json \+ critical-surface\.json \| not-proven \|/);
});

test('an app whose suite has no test file the canary can sabotage is "not-proven"', () => {
  const s = setup({ a: { files: { 'package.json': JSON.stringify({ scripts: { test: 'node src/code.mjs' } }) }, result: { testGlobs: ['src/**/*.none'] } } });
  gitIn(join(s.org, 'a'))('rm', '-q', 'guard.test.mjs'); gitIn(join(s.org, 'a'))('commit', '-qm', 'no tests');
  const l = label(verify({ org: s.org, branch: s.branch, approved: s.approved, author: AUTHOR }), 'a');
  assert.strictEqual(l.label, 'not-proven', JSON.stringify(l));
  assert.match(l.reason, /no JS\/TS\/Python test file to sabotage/);
});

test('an app without a gate config (needs-local-env) is labelled, not run', () => {
  const s = setup({ a: { result: { verify: null, localEnv: { state: 'needs-local-env', proposal: { verify: 'x', files: { 'README.md': 'why' } } } } } });
  assert.strictEqual(label(verify({ org: s.org, branch: s.branch, approved: s.approved, author: AUTHOR }), 'a').label, 'no-gate-config');
});

test('a listed app that is not cloned is "cannot-run-here"', () => {
  const s = setup({ a: {} });
  // the proposal lists ghost (as main's repos do after a repo is deleted locally)
  const g = gitIn(s.ws); const wt = join(s.org, 'g-wt'); g('worktree', 'add', '-q', wt, s.branch);
  const m = JSON.parse(readFileSync(join(wt, 'workspace.json'), 'utf8')); m.repos.ghost = { role: 'app', base: 'development' };
  write(wt, 'workspace.json', JSON.stringify(m)); write(wt, 'repos/ghost/tools.json', JSON.stringify({ verify: 'npm test', productionGlobs: ['src/**'] }));
  gitIn(wt)('add', '-A'); gitIn(wt)('commit', '-qm', 'ghost'); g('worktree', 'remove', '--force', wt);
  s.approved = g('rev-parse', s.branch).stdout.trim();
  assert.strictEqual(label(verify({ org: s.org, branch: s.branch, approved: s.approved, author: AUTHOR }), 'ghost').label, 'cannot-run-here');
});

test('main is never a verification target, and an unknown branch is refused', () => {
  const s = setup({ a: {} });
  assert.throws(() => verify({ org: s.org, branch: 'main', approved: s.approved, author: AUTHOR }), /proposal branch/);
  assert.throws(() => verify({ org: s.org, branch: 'init/nope', approved: s.approved, author: AUTHOR }), /does not resolve/);
});

// --- round 2 ---
test('D6: nothing runs without the human approval of this exact proposal', () => {
  const s = setup({ a: {} });
  assert.throws(() => verify({ org: s.org, branch: s.branch, author: AUTHOR }), /approved/);
  assert.throws(() => verify({ org: s.org, branch: s.branch, approved: 'f'.repeat(40), author: AUTHOR }), /approved/);
});

test('D6: a config edited after approval is refused', () => {
  const s = setup({ a: {} });
  const g = gitIn(s.ws); const wt = join(s.org, 'edit-wt');
  g('worktree', 'add', '-q', wt, s.branch);
  write(wt, 'repos/a/tools.json', JSON.stringify({ verify: 'true', productionGlobs: ['src/**'] }));
  gitIn(wt)('commit', '-qam', 'weaken after approval'); g('worktree', 'remove', '--force', wt);
  assert.throws(() => verify({ org: s.org, branch: s.branch, approved: s.approved, author: AUTHOR }), /changed since it was approved/);
});

test('D1: verification writes no ledger into the product repo', () => {
  const s = setup({ a: {} });
  verify({ org: s.org, branch: s.branch, approved: s.approved, author: AUTHOR });
  assert.strictEqual(existsSync(join(s.org, 'a', '.quality-kernel')), false);
});

test('D2: a docker-based config with Docker unavailable is cannot-run-here (not a suite failure)', () => {
  const s = setup({ a: { files: { Makefile: 'test-all:\n\techo\n', 'docker-compose.test.yml': 'services: {}' }, result: { verify: { runner: 'make', target: 'test-all' }, localEnv: { state: 'docker-existing', proposal: null } } } });
  const bin = realpathSync(mkdtempSync(join(tmpdir(), 'qk-nodocker-')));
  writeFileSync(join(bin, 'docker'), '#!/bin/sh\necho "Cannot connect to the Docker daemon" >&2\nexit 1\n'); chmodSync(join(bin, 'docker'), 0o755);
  const saved = process.env.PATH; process.env.PATH = `${bin}:${saved}`;
  try {
    const l = label(verify({ org: s.org, branch: s.branch, approved: s.approved, author: AUTHOR }), 'a');
    assert.strictEqual(l.label, 'cannot-run-here');
    assert.match(l.reason, /docker is not available/i);
  } finally { process.env.PATH = saved; }
});

test('D3/D4: a re-run re-renders the report (no stale table, one section) and binds labels to the config tree', () => {
  const s = setup({ a: { code: 'export const f = () => 2;' } });
  assert.strictEqual(label(verify({ org: s.org, branch: s.branch, approved: s.approved, author: AUTHOR }), 'a').label, 'runs-but-fails');
  const ag = gitIn(join(s.org, 'a')); write(join(s.org, 'a'), 'src/code.mjs', 'export const f = () => 1;'); ag('commit', '-qam', 'fix');
  const r2 = verify({ org: s.org, branch: s.branch, approved: s.approved, author: AUTHOR });
  assert.strictEqual(label(r2, 'a').label, 'verified');
  const rep = gitIn(s.ws)('show', `${s.branch}:INIT-REPORT.md`).stdout;
  assert.match(rep, /\| a \| app \| development \| native \| tools\.json \+ critical-surface\.json \| verified \|/);
  assert.strictEqual(rep.match(/## Verification/g).length, 1);
  const v = JSON.parse(gitIn(s.ws)('show', `${s.branch}:verification.json`).stdout);
  assert.match(v.configTree, /^[0-9a-f]{40}$/);
});

test('D3: agent text cannot remove report sections (the report is rendered, not regex-edited)', () => {
  const s = setup({ a: {} });
  verify({ org: s.org, branch: s.branch, approved: s.approved, author: AUTHOR });
  const rep = gitIn(s.ws)('show', `${s.branch}:INIT-REPORT.md`).stdout;
  assert.match(rep, /## Evidence/); assert.match(rep, /## Verification/);
});

test('D5: a declared base branch that does not exist is cannot-run-here (no fallback to HEAD)', () => {
  const s = setup({ a: {} });
  const g = gitIn(s.ws); const wt = join(s.org, 'b-wt'); g('worktree', 'add', '-q', wt, s.branch);
  const m = JSON.parse(readFileSync(join(wt, 'workspace.json'), 'utf8')); m.repos.a.base = 'nope';
  write(wt, 'workspace.json', JSON.stringify(m)); gitIn(wt)('commit', '-qam', 'base'); g('worktree', 'remove', '--force', wt);
  s.approved = g('rev-parse', s.branch).stdout.trim();
  const l = label(verify({ org: s.org, branch: s.branch, approved: s.approved, author: AUTHOR }), 'a');
  assert.strictEqual(l.label, 'cannot-run-here');
  assert.match(l.reason, /base branch "nope" not found/);
});

// --- round 3 ---
test('approval must be the full sha of a commit of THIS proposal branch', () => {
  const s = setup({ a: {} });
  const sib = propose({ org: s.org, date: '2026-09-29', results: [result('a')], author: AUTHOR });
  for (const approved of [s.approved.slice(0, 12), s.branch, 'main', sib.sha]) {
    assert.throws(() => verify({ org: s.org, branch: s.branch, approved, author: AUTHOR }), /approved/, approved);
  }
});

test('an edit of workspace.json after approval is refused too', () => {
  const s = setup({ a: {} });
  const g = gitIn(s.ws); const wt = join(s.org, 'e2-wt'); g('worktree', 'add', '-q', wt, s.branch);
  const m = JSON.parse(readFileSync(join(wt, 'workspace.json'), 'utf8')); m.repos.a.base = 'evil';
  write(wt, 'workspace.json', JSON.stringify(m)); gitIn(wt)('commit', '-qam', 'edit'); g('worktree', 'remove', '--force', wt);
  assert.throws(() => verify({ org: s.org, branch: s.branch, approved: s.approved, author: AUTHOR }), /changed since it was approved/);
});

test('a non-init branch is refused', () => {
  const s = setup({ a: {} });
  gitIn(s.ws)('branch', 'feature/x', s.branch);
  assert.throws(() => verify({ org: s.org, branch: 'feature/x', approved: s.approved, author: AUTHOR }), /proposal branch/);
});

test('configTree is the tree id of repos/ at the verified commit', () => {
  const s = setup({ a: {} });
  const r = verify({ org: s.org, branch: s.branch, approved: s.approved, author: AUTHOR });
  assert.strictEqual(r.configTree, gitIn(s.ws)('rev-parse', `${s.approved}:repos`).stdout.trim());
});

test('a forbidden entry is labelled "forbidden" and never run', () => {
  const s = setup({ a: {} });
  const g = gitIn(s.ws); const wt = join(s.org, 'f-wt'); g('worktree', 'add', '-q', wt, s.branch);
  const m = JSON.parse(readFileSync(join(wt, 'workspace.json'), 'utf8')); m.forbidden = ['a'];
  write(wt, 'workspace.json', JSON.stringify(m)); gitIn(wt)('commit', '-qam', 'forbid'); g('worktree', 'remove', '--force', wt);
  const approved = g('rev-parse', s.branch).stdout.trim();
  assert.strictEqual(label(verify({ org: s.org, branch: s.branch, approved, author: AUTHOR }), 'a').label, 'forbidden');
});

test('the base is origin/<base> when it exists (not a stale local branch)', () => {
  const s = setup({ a: { code: 'export const f = () => 2;' } });            // local development: broken
  const aDir = join(s.org, 'a'); const up = join(s.org, 'a-up');
  spawnSync('git', ['clone', '-q', '--bare', aDir, up]);
  const ag = gitIn(aDir); ag('remote', 'add', 'origin', up);
  const wt = join(s.org, 'a-fix'); spawnSync('git', ['clone', '-q', up, wt]);
  const wg = gitIn(wt); wg('config', 'user.email', 't@t'); wg('config', 'user.name', 't');
  write(wt, 'src/code.mjs', 'export const f = () => 1;'); wg('commit', '-qam', 'fixed on origin'); wg('push', '-q', 'origin', 'development');
  ag('fetch', '-q', 'origin');
  assert.strictEqual(label(verify({ org: s.org, branch: s.branch, approved: s.approved, author: AUTHOR }), 'a').label, 'verified');
});

// Round-3 finding 2: verify EXECUTED a repo outside the org folder through a symlinked entry.
test('a symlinked entry is never run: cannot-run-here, and the outside repo executes nothing', async () => {
  const { symlinkSync, renameSync } = await import('node:fs');
  const s = setup({ a: {} });
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'qk-ver-outside-')));
  const marker = join(outside, 'EXECUTED');
  renameSync(join(s.org, 'a'), join(outside, 'a'));
  write(join(outside, 'a'), 'package.json', JSON.stringify({ scripts: { test: `node -e "require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')" && node --test guard.test.mjs` } }));
  gitIn(join(outside, 'a'))('commit', '-qam', 'marker');
  symlinkSync(join(outside, 'a'), join(s.org, 'a'));
  const l = label(verify({ org: s.org, branch: s.branch, approved: s.approved, author: AUTHOR }), 'a');
  assert.strictEqual(l.label, 'cannot-run-here', JSON.stringify(l));
  assert.match(l.reason, /is a symlink/);
  assert.strictEqual(existsSync(marker), false, 'the outside repo ran nothing');
});
