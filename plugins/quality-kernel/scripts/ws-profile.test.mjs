import './hermetic-git.mjs';
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { profile } from './ws-profile.mjs';

// Phase 1 (deterministic part) of /init-workspace: facts about ONE repo read from its committed
// base branch — never the worktree, never the contents of .env / key files.
const here = dirname(fileURLToPath(import.meta.url));
const gitIn = (dir) => (...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
function write(dir, p, c) { const d = join(dir, p); mkdirSync(dirname(d), { recursive: true }); writeFileSync(d, c); }
function repo(files, { branch = 'main' } = {}) {
  const dir = join(realpathSync(mkdtempSync(join(tmpdir(), 'qk-prof-'))), 'r');
  mkdirSync(dir);
  const git = gitIn(dir);
  git('init', '-q', '-b', branch); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  for (const [p, c] of Object.entries(files)) write(dir, p, c);
  git('add', '-A'); git('commit', '-qm', 'init');
  return { dir, git };
}
const pkg = (o) => JSON.stringify(o);

test('a CRA/Jest repo: stack, npm test script, test files, native local env', () => {
  const { dir } = repo({
    'package.json': pkg({ scripts: { test: 'react-scripts test', start: 'react-scripts start' }, dependencies: { react: '18', 'react-scripts': '5' } }),
    'src/App.js': 'x', 'src/App.test.js': 'x', 'src/pages/A.test.js': 'x',
  });
  const p = profile({ dir });
  assert.strictEqual(p.base, 'main');
  assert.ok(p.stack.frameworks.includes('react-scripts'));
  assert.ok(p.stack.frameworks.includes('react'));
  assert.deepStrictEqual(p.testScripts.npm, { test: 'react-scripts test' });
  assert.strictEqual(p.testFiles.count, 2);
  assert.ok(p.testFiles.conventions.includes('*.test.*'));
  assert.strictEqual(p.localEnv.hint, 'native');
});

test('a Django repo without a local Docker path needs a local env (tests need a database)', () => {
  const { dir } = repo({ 'manage.py': 'x', 'requirements.txt': 'Django==3.2\npsycopg2==2.9\n', 'events/tests.py': 'x' });
  const p = profile({ dir });
  assert.ok(p.stack.frameworks.includes('django'));
  assert.strictEqual(p.testScripts.python.manage, true);
  assert.strictEqual(p.localEnv.hint, 'needs-local-env');
  assert.match(p.localEnv.evidence.join(' '), /django/i);
});

test('a repo that ships a local/test compose file and a make test target uses it (docker-existing)', () => {
  const { dir } = repo({
    'manage.py': 'x', 'requirements.txt': 'Django==3.2\n', 'events/tests.py': 'x',
    'docker-compose.test.yml': 'services: {}', 'Makefile': 'db-up:\n\techo\ntest-all:\n\tdocker compose run web\n.PHONY: test-all\n',
  });
  const p = profile({ dir });
  assert.deepStrictEqual(p.testScripts.make, ['test-all']);
  assert.deepStrictEqual(p.docker.compose, ['docker-compose.test.yml']);
  assert.strictEqual(p.localEnv.hint, 'docker-existing');
  assert.match(p.localEnv.evidence.join(' '), /docker-compose\.test\.yml/);
  assert.match(p.localEnv.evidence.join(' '), /test-all/);
});

test('no test files and no test script -> no-tests', () => {
  const { dir } = repo({ 'README.md': 'docs', 'package.json': pkg({ scripts: { build: 'tsc' } }) });
  assert.strictEqual(profile({ dir }).localEnv.hint, 'no-tests');
});

test('the base branch is resolved origin-first from the preferred list, or taken from the option', () => {
  const { dir, git } = repo({ 'README.md': 'x' });
  git('branch', 'development');
  assert.strictEqual(profile({ dir }).base, 'development');
  assert.strictEqual(profile({ dir, base: 'main' }).base, 'main');
  assert.throws(() => profile({ dir, base: 'nope' }), /base branch "nope" not found/);
});

test('reads the committed base, not the worktree', () => {
  const { dir } = repo({ 'package.json': pkg({ scripts: { test: 'jest' } }), 'a.test.js': 'x' });
  write(dir, 'playwright.config.ts', 'uncommitted');
  write(dir, 'package.json', pkg({ scripts: { test: 'echo tampered' } }));
  const p = profile({ dir });
  assert.deepStrictEqual(p.testScripts.npm, { test: 'jest' });
  assert.ok(!p.stack.frameworks.includes('playwright'));
});

test('.env and key files are reported by name only; their contents are never read', () => {
  const { dir } = repo({ '.env': 'SECRET_TOKEN=ghp_supersecret', 'deploy/key.pem': '-----BEGIN KEY-----', 'package.json': pkg({ scripts: { test: 'jest' } }), 'a.test.js': 'x' });
  const p = profile({ dir });
  assert.deepStrictEqual(p.sensitiveFilesCommitted, ['.env', 'deploy/key.pem']);
  assert.doesNotMatch(JSON.stringify(p), /ghp_supersecret|BEGIN KEY/);
});

test('serverless, next and CI files are detected', () => {
  const { dir } = repo({
    'serverless.ts': 'x', 'package.json': pkg({ scripts: { test: 'node --test' }, dependencies: { next: '13' }, devDependencies: { '@playwright/test': '1' } }),
    '.github/workflows/ci.yml': 'x', 'buildspec.yml': 'x', 'tests/a.test.js': 'x',
  });
  const p = profile({ dir });
  for (const f of ['serverless', 'next', 'playwright']) assert.ok(p.stack.frameworks.includes(f), f);
  assert.deepStrictEqual(p.ci, ['.github/workflows/ci.yml', 'buildspec.yml']);
});

test('an unreadable manifest is an error, not a silent empty profile', () => {
  const { dir } = repo({ 'package.json': '{ not json' });
  assert.throws(() => profile({ dir }), /package\.json/);
});

test('CLI prints the profile JSON', () => {
  const { dir } = repo({ 'package.json': pkg({ scripts: { test: 'jest' } }), 'a.test.js': 'x' });
  const r = spawnSync('node', [join(here, 'ws-profile.mjs'), '--repo', dir], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).localEnv.hint, 'native');
});

// --- round 2 ---
test('base: origin/<branch> is read before a stale local branch, and HEAD on another branch is ignored', () => {
  const up = repo({ 'package.json': pkg({ scripts: { test: 'v1' } }), 'a.test.js': 'x' }, { branch: 'development' });
  const clone = join(dirname(up.dir), 'clone');
  spawnSync('git', ['clone', '-q', up.dir, clone]);
  const cg = gitIn(clone); cg('config', 'user.email', 't@t'); cg('config', 'user.name', 't');
  write(up.dir, 'package.json', pkg({ scripts: { test: 'v2-origin' } })); up.git('commit', '-qam', 'v2');
  cg('fetch', '-q', 'origin');                       // origin/development = v2, local development = v1
  cg('switch', '-q', '-c', 'main');
  write(clone, 'package.json', pkg({ scripts: { test: 'on-main' } })); cg('commit', '-qam', 'main');
  const p = profile({ dir: clone });
  assert.strictEqual(p.baseRef, 'refs/remotes/origin/development');
  assert.deepStrictEqual(p.testScripts.npm, { test: 'v2-origin' });
});

test('only origin/<branch> exists -> it is the base (not a fallback to HEAD)', () => {
  const up = repo({ 'package.json': pkg({ scripts: { test: 'on-dev' } }), 'a.test.js': 'x' }, { branch: 'development' });
  const clone = join(dirname(up.dir), 'c2');
  spawnSync('git', ['clone', '-q', '--branch', 'development', up.dir, clone]);
  const cg = gitIn(clone); cg('switch', '-q', '-c', 'main'); cg('branch', '-q', '-D', 'development');
  const p = profile({ dir: clone });
  assert.strictEqual(p.base, 'development');
  assert.deepStrictEqual(p.testScripts.npm, { test: 'on-dev' });
});

test('more sensitive names are reported (and still never read)', () => {
  const names = ['secrets.json', 'AuthKey.p8', 'service-account-prod.json', 'project_key.json', '.npmrc', 'id_ed25519', 'app.keystore', 'x-firebase-adminsdk.json', '.pgpass', 'prod.tfvars', 'kubeconfig', '.aws/config', '.envrc', 'credentials.yml'];
  const files = Object.fromEntries(names.map((n) => [n, 'TOPSECRET_VALUE']));
  const { dir } = repo({ ...files, 'package.json': pkg({ scripts: { test: 'jest' } }), 'a.test.js': 'x' });
  const p = profile({ dir });
  assert.deepStrictEqual(p.sensitiveFilesCommitted, [...names].sort());
  assert.doesNotMatch(JSON.stringify(p), /TOPSECRET_VALUE/);
});

test('a sensitive-looking requirements file is skipped, not fatal', () => {
  const { dir } = repo({ 'manage.py': 'x', 'requirements.txt': 'Django==3.2\n', 'requirements-credentials.txt': 'TOPSECRET', 'x/tests.py': 'x' });
  const p = profile({ dir });
  assert.ok(p.stack.frameworks.includes('django'));
  assert.ok(p.sensitiveFilesCommitted.includes('requirements-credentials.txt'));
});

test('secret-looking values in npm test scripts are redacted in the profile', () => {
  const { dir } = repo({ 'package.json': pkg({ scripts: { test: 'SENTRY_AUTH_TOKEN=sntrys_LEAKED1234567890abcdef AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP jest' } }), 'a.test.js': 'x' });
  const p = profile({ dir });
  assert.doesNotMatch(JSON.stringify(p), /sntrys_LEAKED|AKIAABCDEFGHIJKLMNOP/);
  assert.match(p.testScripts.npm.test, /SENTRY_AUTH_TOKEN=<redacted>.*jest/);
});

test('a directory inside another repo is refused (it would profile the parent)', () => {
  const { dir } = repo({ 'package.json': pkg({ scripts: { test: 'jest' } }), 'sub/x.txt': 'x' });
  assert.throws(() => profile({ dir: join(dir, 'sub') }), /not the top level/);
});

// --- round 3 ---
test('R3.6: URL credentials, --password values and bare tokens in npm test scripts are redacted', () => {
  const tok = (p, n) => p + 'z'.repeat(n);
  const script = `DATABASE_URL=postgres://admin:Pr0dPw99@prod/db MONGO="mongodb+srv://u:Pr0dPw99@c/x" jest --password Pr0dPw99xyz ${tok('ghp_', 36)} ${tok('AKIA', 16).toUpperCase()} ${tok('xoxb-', 20)} ${tok('sk-', 30)} eyJ${'a'.repeat(12)}.eyJ${'b'.repeat(12)}.${'c'.repeat(12)} TOKEN="quoted value"`;
  const { dir } = repo({ 'package.json': pkg({ scripts: { test: script } }), 'a.test.js': 'x' });
  const p = profile({ dir });
  const out = JSON.stringify(p);
  for (const leak of ['Pr0dPw99', 'ghp_z', 'AKIAZ', 'xoxb-z', 'sk-z', 'eyJaaaa', 'quoted value']) assert.ok(!out.includes(leak), leak);
  assert.match(p.testScripts.npm.test, /jest/);
});

test('envRefs: env NAMES the committed code reads (JS/TS/Python), never values, never the worktree or node_modules', () => {
  const { dir } = repo({
    'package.json': pkg({ scripts: { test: 'mocha' } }),
    'app/constants/index.ts': "const s = process.env.JWT_SECRET; const t = process.env['API_TOKEN_NAME']; const v = process.env.lower_case;",
    'settings.py': "import os\nA = os.environ['DB_NAME']\nB = os.environ.get('CACHE_TTL')\nC = os.getenv(\"LOG_LEVEL\", 'x')",
    'node_modules/dep/index.js': 'process.env.FROM_NODE_MODULES',
    'docs/notes.md': 'process.env.FROM_DOCS',
  });
  writeFileSync(join(dir, 'app/worktree-only.ts'), 'process.env.WORKTREE_ONLY');
  const p = profile({ dir });
  assert.deepStrictEqual(p.envRefs, ['API_TOKEN_NAME', 'CACHE_TTL', 'DB_NAME', 'JWT_SECRET', 'LOG_LEVEL']);
});

test('envRefs: a repo whose code reads no env is an empty list', () => {
  const { dir } = repo({ 'package.json': pkg({ scripts: { test: 'jest' } }), 'src/a.js': 'export const x = 1;' });
  assert.deepStrictEqual(profile({ dir }).envRefs, []);
});
