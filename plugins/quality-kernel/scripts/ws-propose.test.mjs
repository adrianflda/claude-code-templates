import './hermetic-git.mjs';
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { propose, renderReport } from './ws-propose.mjs';

// Phase 4 of /init-workspace: validate the profiler agents' JSON deterministically, RE-PROFILE each
// repo, build the gated verify from those facts, and write the proposal to a NEW branch of the
// workspace repo — never to main.
// Fake secrets are assembled at runtime so no literal token-like string sits in this file.
const fake = (prefix, n, ch = 'a') => prefix + ch.repeat(n);
const here = dirname(fileURLToPath(import.meta.url));
const gitIn = (dir) => (...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
function write(dir, p, c) { const d = join(dir, p); mkdirSync(dirname(d), { recursive: true }); writeFileSync(d, c); }
const AUTHOR = { name: 't', email: 't@t' };
const DEFAULT_FILES = { 'package.json': JSON.stringify({ scripts: { test: 'jest' } }), 'a.test.js': 'x' };
function makeRepo(org, name, { branch = 'development', files = DEFAULT_FILES } = {}) {
  const dir = join(org, name); mkdirSync(dir, { recursive: true });
  const g = gitIn(dir);
  g('init', '-q', '-b', branch); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  for (const [p, c] of Object.entries(files)) write(dir, p, c);
  g('add', '-A'); g('commit', '-qm', 'init');
  return g;
}
function orgDir({ workspace, repos = {} } = {}) {
  const org = realpathSync(mkdtempSync(join(tmpdir(), 'qk-prop-')));
  for (const [name, files] of Object.entries(repos)) makeRepo(org, name, { files });
  if (workspace) {
    const ws = join(org, 'workspace'); mkdirSync(ws);
    const git = gitIn(ws);
    git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
    for (const [p, c] of Object.entries(workspace)) write(ws, p, c);
    git('add', '-A'); git('commit', '-qm', 'existing');
  }
  return org;
}
const show = (ws, rev, path) => { const r = gitIn(ws)('show', `${rev}:${path}`); return r.status === 0 ? r.stdout : null; };
const APP = {
  name: 'app', role: 'app', harnessOf: null, base: 'development',
  verify: { runner: 'npm-script', script: 'test' }, productionGlobs: ['src/**'], testGlobs: ['src/**/*.test.js'], linkPaths: ['node_modules'],
  criticalGlobs: ['src/auth/**'], safeGlobs: ['**/*.md'],
  localEnv: { state: 'native', proposal: null },
  evidence: [{ claim: 'tests run with jest', at: 'package.json:5' }], notes: [],
};
const HARNESS = { ...APP, name: 'app-qa-local', role: 'harness', harnessOf: 'app', verify: null, productionGlobs: [], testGlobs: [], criticalGlobs: [], safeGlobs: [], linkPaths: [] };
// Create any repo a result names (default: an npm/jest repo on branch development), then propose.
function run(org, results, extra = {}) {
  for (const r of results) if (r && typeof r.name === 'string' && /^[a-z0-9-]+$/i.test(r.name) && !existsSync(join(org, r.name))) makeRepo(org, r.name);
  return propose({ org, date: '2026-09-29', results, author: AUTHOR, ...extra });
}
const branches = (ws) => gitIn(ws)('branch', '--list', 'init/*').stdout.trim();
const needs = (files, verify = 'docker compose -f docker-compose.test.yml run --rm tests') => ({ ...APP, verify: null, localEnv: { state: 'needs-local-env', proposal: { verify, files } } });

test('creates the workspace repo when absent and writes the proposal on init/<date>, not main', () => {
  const org = orgDir();
  const r = run(org, [APP, HARNESS], { forbidden: ['app-qa'] });
  const ws = join(org, 'workspace');
  assert.strictEqual(r.branch, 'init/2026-09-29');
  assert.deepStrictEqual(JSON.parse(show(ws, r.branch, 'workspace.json')), { version: 1, org: null, repos: { app: { role: 'app', base: 'development', harness: 'app-qa-local' } }, forbidden: ['app-qa'] });
  const tools = JSON.parse(show(ws, r.branch, 'repos/app/tools.json'));
  assert.strictEqual(tools.verify, 'npm test', 'built from the spec');
  assert.deepStrictEqual(tools.verifySpec, { runner: 'npm-script', script: 'test' });
  assert.deepStrictEqual(JSON.parse(show(ws, r.branch, 'repos/app/critical-surface.json')).criticalGlobs, ['src/auth/**']);
  assert.strictEqual(show(ws, 'main', 'workspace.json'), null, 'main has no proposal');
});

test('an existing workspace main is untouched; its other files and repo entries are kept', () => {
  const org = orgDir({ workspace: {
    'README.md': 'hello',
    'workspace.json': JSON.stringify({ version: 1, org: 'Org', repos: { old: { role: 'app', base: 'main' } }, forbidden: ['x-qa'] }),
    'repos/old/tools.json': '{"verify":"true"}',
  } });
  const ws = join(org, 'workspace');
  const before = gitIn(ws)('rev-parse', 'main').stdout.trim();
  write(ws, 'dirty.txt', 'uncommitted');
  const r = run(org, [APP]);
  assert.strictEqual(gitIn(ws)('rev-parse', 'main').stdout.trim(), before);
  assert.strictEqual(readFileSync(join(ws, 'dirty.txt'), 'utf8'), 'uncommitted');
  const m = JSON.parse(show(ws, r.branch, 'workspace.json'));
  assert.deepStrictEqual(Object.keys(m.repos).sort(), ['app', 'old']);
  assert.deepStrictEqual([m.org, m.forbidden], ['Org', ['x-qa']]);
  assert.strictEqual(show(ws, r.branch, 'README.md'), 'hello');
  assert.strictEqual(show(ws, r.branch, 'dirty.txt'), null);
});

test('a second run on the same day gets a new branch; a name taken on origin is skipped too', () => {
  const org = orgDir();
  assert.strictEqual(run(org, [APP]).branch, 'init/2026-09-29');
  assert.strictEqual(run(org, [APP]).branch, 'init/2026-09-29-2');
  gitIn(join(org, 'workspace'))('update-ref', 'refs/remotes/origin/init/2026-09-29-3', 'main');
  assert.strictEqual(run(org, [APP]).branch, 'init/2026-09-29-4');
});

test('structured verify: built only from the re-profiled facts of the repo', () => {
  const files = {
    'package.json': JSON.stringify({ scripts: { test: 'react-scripts test', 'test:unit': 'mocha' } }), 'a.test.js': 'x',
    Makefile: 'test-all:\n\techo\n', 'docker-compose.test.yml': 'services: {}',
  };
  const cases = [
    [{ runner: 'npx', bin: 'react-scripts', args: ['test', '--watchAll=false'], env: { CI: 'true' } }, 'CI=true npx --no -- react-scripts test --watchAll=false'],
    [{ runner: 'npm-script', script: 'test:unit' }, 'npm run test:unit'],
    [{ runner: 'make', target: 'test-all' }, 'make test-all'],
    [{ runner: 'compose', file: 'docker-compose.test.yml', service: 'tests' }, 'docker compose -f docker-compose.test.yml run --rm tests'],
  ];
  for (const [verify, command] of cases) {
    const org = orgDir({ repos: { app: files } });
    const r = run(org, [{ ...APP, verify }]);
    assert.strictEqual(JSON.parse(show(join(org, 'workspace'), r.branch, 'repos/app/tools.json')).verify, command);
  }
});

test('structured verify: free text and every attack vector are refused', () => {
  const vectors = [
    'npm test',
    { runner: 'npm-script', script: 'test', env: { NODE_OPTIONS: '--import=data:x' } },
    { runner: 'npm-script', script: 'test', env: { PATH: '/tmp/evil' } },
    { runner: 'npm-script', script: 'deploy' },
    { runner: 'npm-script', script: 'constructor' },
    { runner: 'npx', bin: 'attacker-package' },
    { runner: 'npx', bin: 'jest', args: ['--prefix', '/elsewhere'] },
    { runner: 'make', target: 'test-all' },
    { runner: 'compose', file: '/tmp/evil.yml', service: 'x' },
    { runner: 'sh', cmd: 'x' },
  ];
  for (const verify of vectors) assert.throws(() => run(orgDir(), [{ ...APP, verify }]), /verify/, JSON.stringify(verify));
  assert.throws(() => run(orgDir(), [{ ...HARNESS, verify: { runner: 'npm-script', script: 'test' } }, APP]), /verify must be null/);
});

test('a repo that cannot be profiled at its base is refused (no gate config from thin air)', () => {
  const org = orgDir(); makeRepo(org, 'app', { branch: 'main' });
  assert.throws(() => run(org, [APP]), /cannot profile/);
});

test('A1: a workspace/ that is a plain dir inside another repo is refused (nothing written to the parent)', () => {
  const outer = realpathSync(mkdtempSync(join(tmpdir(), 'qk-outer-')));
  const og = gitIn(outer); og('init', '-q', '-b', 'main'); og('config', 'user.email', 't@t'); og('config', 'user.name', 't');
  write(outer, 'README.md', 'outer'); og('add', '-A'); og('commit', '-qm', 'outer');
  const org = join(outer, 'org'); mkdirSync(join(org, 'workspace'), { recursive: true });
  assert.throws(() => run(org, [APP]), /not a git repository of its own/);
  assert.strictEqual(og('branch', '--list', 'init/*').stdout.trim(), '');
});

test('A2: an existing workspace whose manifest is unusable fails closed', () => {
  const org = orgDir({ workspace: { 'workspace.json': JSON.stringify({ version: 2, repos: {}, forbidden: ['qa-team'] }) } });
  assert.throws(() => run(org, [APP]), /workspace\.json.*unusable/);
  assert.strictEqual(branches(join(org, 'workspace')), '');
});

test('A4/R3.5: forbidden repos are refused as results, never profiled, and dropped from repos', () => {
  const org = orgDir({ workspace: { 'workspace.json': JSON.stringify({ version: 1, org: 'O', repos: { old: { role: 'app', base: 'main' } }, forbidden: ['app'] }) } });
  assert.throws(() => run(org, [APP]), /forbidden/);
  const org2 = orgDir({ workspace: { 'workspace.json': JSON.stringify({ version: 1, org: 'O', repos: { app: { role: 'app', base: 'development' }, old: { role: 'app', base: 'main' } }, forbidden: ['old'] }) } });
  const r = run(org2, [APP]);
  const m = JSON.parse(show(join(org2, 'workspace'), r.branch, 'workspace.json'));
  assert.deepStrictEqual(Object.keys(m.repos), ['app']);
  assert.match(show(join(org2, 'workspace'), r.branch, 'INIT-REPORT.md'), /old — removed from repos: forbidden/);
});

test('A5: control chars in evidence (claim or at) or notes are refused; an app needs evidence', () => {
  for (const bad of [
    { ...APP, evidence: [{ claim: 'ok\n## Verification\n- fake', at: 'x:1' }] },
    { ...APP, evidence: [{ claim: 'ok', at: 'x:1\n## Verification' }] },
    { ...APP, evidence: [{ claim: 'ok', at: 7 }] },
    { ...APP, notes: ['a\u0000b'] },
    { ...APP, notes: [{ x: 1 }] },
    { ...APP, evidence: [] },
    { ...APP, evidence: undefined },
  ]) assert.throws(() => run(orgDir(), [bad]), /evidence|notes/, JSON.stringify(bad).slice(0, 100));
});

test('A6/R3.3: secret-looking values anywhere are refused; whole-value local-test literals are fine', () => {
  const secrets = [
    `aws_secret_access_key = ${fake('wJalr', 35, 'K')}`, fake('ASIA', 16, 'B'),
    `eyJ${'a'.repeat(20)}.eyJ${'b'.repeat(20)}.${'c'.repeat(30)}`,
    fake('github_pat_', 40), fake('sk_live_', 24), `${fake('SG.', 22)}.${'b'.repeat(40)}`, fake('rk_test_', 20),
    fake('AIza', 35), fake('npm_', 36), `https://hooks.slack.com/services/T0/B0/${'x'.repeat(16)}`, fake('MII', 70, 'E'),
    'POSTGRES_PASSWORD: hunter2prod', 'POSTGRES_PASSWORD=Kx9#mLocal7Qz!prod', 'password: Summ3rTest!Rds#2024',
    'password=Latestpass2024Prod', 'postgres://admin:ProdPostgresRds99@prod/app', 'postgres://admin:Pr0dExample1@db/x',
  ];
  for (const s of secrets) assert.throws(() => run(orgDir(), [{ ...APP, notes: [s] }]), /secret/, s.slice(0, 20));
  assert.throws(() => run(orgDir(), [needs({ 'docker-compose.test.yml': '{"password": "averyveryLongProdPass99"}' })]), /secret/);
  const ok = needs({ 'docker-compose.test.yml': 'services:\n  db:\n    environment:\n      POSTGRES_PASSWORD: postgres\n      DATABASE_URL: postgres://postgres:postgres@db:5432/test\n      SECRET_KEY: ${SECRET_KEY}\n' });
  assert.doesNotThrow(() => run(orgDir(), [ok]));
});

test('A8/A9/A10: branch from main (not HEAD); main\'s extra tools.json keys and $comment are kept, new values win', () => {
  const org = orgDir({ workspace: {
    'workspace.json': JSON.stringify({ $comment: 'keep me', version: 1, org: 'O', repos: { app: { role: 'app', base: 'development' } }, forbidden: [] }),
    'repos/app/tools.json': JSON.stringify({ verify: 'old', productionGlobs: ['old/**'], testGlobs: ['old'], linkPaths: ['old'], localEnv: 'old', outputGlobs: ['dist/**'], verifySetup: 'npm ci', acceptance: 'node acc.mjs' }),
  } });
  const ws = join(org, 'workspace'); const g = gitIn(ws);
  g('switch', '-q', '-c', 'wip'); write(ws, 'unmerged.txt', 'x'); write(ws, 'workspace.json', JSON.stringify({ $comment: 'from HEAD', version: 1, org: 'O', repos: {}, forbidden: [] })); g('add', '-A'); g('commit', '-qm', 'wip');
  const r = run(org, [APP]);
  assert.strictEqual(show(ws, r.branch, 'unmerged.txt'), null);
  const t = JSON.parse(show(ws, r.branch, 'repos/app/tools.json'));
  assert.deepStrictEqual([t.outputGlobs, t.verifySetup, t.acceptance], [['dist/**'], 'npm ci', 'node acc.mjs']);
  assert.deepStrictEqual([t.verify, t.productionGlobs, t.testGlobs, t.linkPaths, t.localEnv], ['npm test', APP.productionGlobs, APP.testGlobs, APP.linkPaths, 'native']);
  assert.strictEqual(JSON.parse(show(ws, r.branch, 'workspace.json')).$comment, 'keep me');
});

test('A12: every validator rule rejects its case', () => {
  const cases = [
    [{ ...APP, safeGlobs: ['**'] }, /safeGlobs/], [{ ...APP, criticalGlobs: ['*'] }, /criticalGlobs/], [{ ...APP, testGlobs: ['../x'] }, /testGlobs/],
    [{ ...APP, productionGlobs: ['**/*'] }, /productionGlobs/], [{ ...APP, productionGlobs: ['/etc/**'] }, /productionGlobs/],
    [{ ...APP, productionGlobs: ['../x/**'] }, /productionGlobs/], [{ ...APP, productionGlobs: [' '] }, /productionGlobs/],
    [{ ...APP, productionGlobs: 'src/**' }, /productionGlobs/], [{ ...APP, productionGlobs: ['./src/**'] }, /productionGlobs/],
    [{ ...APP, productionGlobs: ['pages/**/*.{ts,tsx}'] }, /unsupported glob syntax/], [{ ...APP, productionGlobs: ['!src/**'] }, /unsupported/],
    [{ ...APP, productionGlobs: [] }, /productionGlobs/],
    [{ ...APP, linkPaths: ['/abs'] }, /linkPaths/], [{ ...APP, linkPaths: [''] }, /linkPaths/], [{ ...APP, linkPaths: ['../x'] }, /linkPaths/],
    [{ ...APP, base: 'x.lock' }, /base/], [{ ...APP, base: 'a..b' }, /base/], [{ ...APP, base: '-x' }, /base/], [{ ...APP, base: 'main~1' }, /base/],
    [{ ...APP, role: 'boss' }, /role/], [{ ...APP, name: '../evil' }, /name/],
    [{ ...APP, localEnv: { state: 'bogus', proposal: null } }, /localEnv\.state/],
    [{ ...APP, verify: null, localEnv: { state: 'needs-local-env', proposal: { files: {} } } }, /proposal/], [needs({ 'README.md': 7 }), /must be text/],
    [needs({ 'README.md': 'x' }, 'line1\nline2'), /single line/],
    [{ ...HARNESS, harnessOf: 'ghost' }, /harnessOf/], [{ ...APP, name: 'lib', role: 'library', harnessOf: 'app' }, /harnessOf/],
  ];
  for (const [bad, re] of cases) assert.throws(() => run(orgDir(), [bad]), re, JSON.stringify(bad).slice(0, 100));
  assert.throws(() => run(orgDir(), [APP, APP]), /duplicate/);
  const org = orgDir({ workspace: { 'workspace.json': JSON.stringify({ version: 1, org: 'O', repos: { app: { role: 'app', base: 'main' } }, forbidden: [] }) } });
  assert.doesNotThrow(() => run(org, [HARNESS]), 'a harness of an app already in main is fine');
});

test('A3: local-env file names are restricted and cannot escape the worktree', () => {
  for (const bad of ['../x.yml', '.env', 'config/.env.dev', 'id_rsa', '../'.repeat(20) + 'tmp/README.md', 'README.md.sh']) {
    assert.throws(() => run(orgDir(), [needs({ [bad]: 'x' })]), /local-env file/, bad);
  }
});

test('needs-local-env and no-tests: no tools.json; the dockerization proposal goes under local-env/', () => {
  const org = orgDir();
  const r = run(org, [needs({ 'docker-compose.test.yml': 'services:\n  db:\n    image: postgres:15\n', 'README.md': 'why: tests need postgres (settings.py:40)' })]);
  const ws = join(org, 'workspace');
  assert.strictEqual(show(ws, r.branch, 'repos/app/tools.json'), null);
  assert.match(show(ws, r.branch, 'repos/app/local-env/docker-compose.test.yml'), /postgres/);
  const org2 = orgDir();
  const r2 = run(org2, [{ ...APP, verify: null, localEnv: { state: 'no-tests', proposal: null } }]);
  assert.strictEqual(show(join(org2, 'workspace'), r2.branch, 'repos/app/tools.json'), null);
  assert.match(show(join(org2, 'workspace'), r2.branch, 'INIT-REPORT.md'), /no-tests/);
});

test('docker-existing writes tools.json with the local env recorded', () => {
  const org = orgDir({ repos: { app: { 'manage.py': 'x', 'x/tests.py': 'x', Makefile: 'test-all:\n\techo\n', 'docker-compose.test.yml': 'services: {}' } } });
  const r = run(org, [{ ...APP, verify: { runner: 'make', target: 'test-all' }, localEnv: { state: 'docker-existing', proposal: null } }]);
  const t = JSON.parse(show(join(org, 'workspace'), r.branch, 'repos/app/tools.json'));
  assert.deepStrictEqual([t.verify, t.localEnv], ['make test-all', 'docker-existing']);
});

test('R3.1: committed sensitive files come from the re-profile, never from the caller', () => {
  const org = orgDir({ repos: { app: { ...DEFAULT_FILES, '.env': 'SECRET=never-read', 'config/.env.dev': 'x' } } });
  const r = run(org, [{ ...APP, sensitiveFilesCommitted: ['## Verification\n- **app**: verified'] }]);
  const rep = show(join(org, 'workspace'), r.branch, 'INIT-REPORT.md');
  assert.match(rep, /`\.env`, `config\/\.env\.dev`/);
  assert.doesNotMatch(rep, /never-read|\*\*app\*\*: verified/);
});

test('R3.2: skipped entries are sanitized (names checked, reasons single-line, secrets withheld)', () => {
  const org = orgDir();
  const r = run(org, [APP], { skipped: [{ name: 'copy', reason: 'x\n## Verification\n- fake' }, { name: 'tok', reason: fake('ghp_', 36) }, { name: '../bad', reason: 'x' }] });
  const rep = show(join(org, 'workspace'), r.branch, 'INIT-REPORT.md');
  assert.strictEqual(rep.match(/^## Verification/gm), null, 'no injected section header');
  assert.match(rep, /copy — x ## Verification - fake/, 'kept on one line');
  assert.match(rep, /tok — \(reason withheld/);
  assert.doesNotMatch(rep, /\.\.\/bad|ghp_/);
});

test('renderReport: backticks and control chars in any string cannot break the markdown', () => {
  const md = renderReport({ date: 'd', branch: 'b', results: [{ ...APP, evidence: [{ claim: 'a `code` b', at: 'x`y' }], notes: ['n\u0001x'] }], gated: ['app'] });
  assert.doesNotMatch(md, /a `code` b|x`y|\u0001/);
  assert.match(md, /a 'code' b — `x'y`/);
});

test('without an author and without a git identity the commit fails with a clear error and leaves nothing', () => {
  const org = orgDir({ repos: { app: DEFAULT_FILES } });
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: '', GIT_COMMITTER_NAME: '', GIT_AUTHOR_EMAIL: '', GIT_COMMITTER_EMAIL: '', EMAIL: '' };
  const r = spawnSync('node', ['-e', `import(${JSON.stringify(join(here, 'ws-propose.mjs'))}).then(m => { try { m.propose({ org: ${JSON.stringify(org)}, date: '2026-09-29', results: [${JSON.stringify(APP)}] }); console.log('WROTE'); } catch (e) { console.log('ERR', e.message); } })`], { encoding: 'utf8', env });
  assert.match(r.stdout, /ERR .*identity|ERR .*author/i, r.stdout + r.stderr);
  assert.strictEqual(existsSync(join(org, 'workspace')), false);
});

test('A14: the CLI takes forbidden names from the inventory (listed mode too) and lists skipped + sensitive', () => {
  const org = orgDir({ repos: { app: { ...DEFAULT_FILES, '.env': 'x' } } });
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'qk-cli-')));
  writeFileSync(join(dir, 'results.json'), JSON.stringify([APP]));
  writeFileSync(join(dir, 'inventory.json'), JSON.stringify({ forbidden: ['app-qa'], candidates: [{ name: 'app', listed: true, kind: 'repo', suggested: true, reasons: [] }, { name: 'app (Copy)', listed: true, kind: 'copy', suggested: false, reasons: ['copy'] }, { name: 'app-qa', opened: false, forbidden: true, suggested: false, reasons: ['forbidden'] }] }));
  const r = spawnSync('node', [join(here, 'ws-propose.mjs'), '--org', org, '--results', join(dir, 'results.json'), '--inventory', join(dir, 'inventory.json'), '--date', '2026-09-29'], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  assert.strictEqual(r.status, 0, r.stderr);
  const ws = join(org, 'workspace'); const b = JSON.parse(r.stdout).branch;
  assert.deepStrictEqual(JSON.parse(show(ws, b, 'workspace.json')).forbidden, ['app-qa']);
  const rep = show(ws, b, 'INIT-REPORT.md');
  assert.match(rep, /`\.env`/); assert.match(rep, /app \(Copy\)/);
  assert.ok(show(ws, b, 'init-report.json'));
});

// Round-3 finding 2: propose followed symlinks that discover refuses.
test('a symlinked entry pointing outside the org folder is refused before it is opened', async () => {
  const { symlinkSync } = await import('node:fs');
  const org = orgDir();
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'qk-prop-outside-')));
  makeRepo(outside, 'ext');
  symlinkSync(join(outside, 'ext'), join(org, 'ext'));
  assert.throws(() => propose({ org, date: '2026-09-30', results: [{ ...APP, name: 'ext' }], author: AUTHOR }), /ext: .*is a symlink/);
  assert.strictEqual(existsSync(join(org, 'workspace')), false, 'nothing written');
});

test('a symlink to a forbidden repo is refused before anything is opened', async () => {
  const { symlinkSync } = await import('node:fs');
  const org = orgDir({ repos: { 'secret-app': DEFAULT_FILES } });
  symlinkSync(join(org, 'secret-app'), join(org, 'lnk'));
  assert.throws(() => propose({ org, date: '2026-09-30', results: [{ ...APP, name: 'lnk' }], author: AUTHOR, forbidden: ['secret-app'] }), /lnk: .*is a symlink/);
});

test('a non-gated symlinked entry (verify: null) is refused too, not listed in workspace.json', async () => {
  const { symlinkSync } = await import('node:fs');
  const org = orgDir({ repos: { app: DEFAULT_FILES } });
  symlinkSync(join(org, 'app'), join(org, 'app-qa-local'));
  assert.throws(() => propose({ org, date: '2026-09-30', results: [APP, HARNESS], author: AUTHOR }), /app-qa-local: .*is a symlink/);
});
