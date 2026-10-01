import './hermetic-git.mjs';
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, realpathSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { findOrg, showOrgFile, readOrgManifest, orgPin, isRepoName, orgRepoDir, orgSource } from './org.mjs';

// Org mode: the repos come from <org>/.claude/org-workspace/guide.json (written by org-workspace),
// the gate config from <org>/.quality-kernel/repos/<name>/ — outside every product repo — pinned by
// content (orgPin). Explicit only: without --org nothing changes.
const gitIn = (dir) => (...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
function write(dir, p, c) { const d = join(dir, p); mkdirSync(dirname(d), { recursive: true }); writeFileSync(d, c); }
function repo(root, name, files = { 'README.md': name }) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const git = gitIn(dir);
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  for (const [p, c] of Object.entries(files)) write(dir, p, c);
  git('add', '-A'); git('commit', '-qm', 'init');
  return { dir, git };
}
const GUIDE = { org: 'Org', repos: [{ name: 'app', role: 'app', base: 'main' }, { name: 'app-qa', role: 'harness', base: 'main', harnessOf: 'app' }, { name: 'lib', role: 'library', base: 'main' }], forbidden: ['secret-qa'] };
function orgDir({ guide = GUIDE, files = { 'app/tools.json': '{"verify":"x","productionGlobs":["src/**"]}' } } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'qk-orgm-')));
  repo(root, 'app'); repo(root, 'lib'); repo(root, 'secret-qa');
  if (guide !== null) write(root, '.claude/org-workspace/guide.json', typeof guide === 'string' ? guide : JSON.stringify(guide));
  for (const [p, c] of Object.entries(files)) write(root, `.quality-kernel/repos/${p}`, c);
  return root;
}

test('without --org the mode is off, even when the folder has an org guide', () => {
  const root = orgDir();
  assert.strictEqual(findOrg(join(root, 'app'), {}), null);
});

test('an org that lists the repo serves it, with its content pin', () => {
  const root = orgDir();
  const o = findOrg(join(root, 'app'), { org: root });
  assert.deepStrictEqual(o, { dir: root, pin: orgPin(root), name: 'app' });
  assert.match(o.pin, /^[0-9a-f]{64}$/);
  assert.deepStrictEqual(orgSource(o), { source: 'org', org: root, pin: o.pin });
});

test('the repo is resolved from a subdirectory to its top level', () => {
  const root = orgDir();
  mkdirSync(join(root, 'app', 'src', 'deep'), { recursive: true });
  assert.strictEqual(findOrg(join(root, 'app', 'src', 'deep'), { org: root }).name, 'app');
});

test('fail closed: not listed, forbidden, non-app, no guide, empty --org, org is the repo, repo not under the org', () => {
  const root = orgDir();
  repo(root, 'other');
  assert.match(findOrg(join(root, 'other'), { org: root }).error, /does not list "other"/);
  assert.match(findOrg(join(root, 'secret-qa'), { org: root }).error, /does not list|forbidden/);
  assert.match(findOrg(join(root, 'lib'), { org: root }).error, /role "library", only "app" is gated/);
  assert.match(findOrg(join(root, 'app'), { org: '' }).error, /empty --org/);
  assert.match(findOrg(join(root, 'app'), { org: join(root, 'app') }).error, /cannot be the repo itself|not a repo directly under/);
  const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'qk-orgm-x-')));
  const ext = repo(elsewhere, 'app');
  assert.match(findOrg(ext.dir, { org: root }).error, /not a repo directly under the org folder/);
  const bare = orgDir({ guide: null });
  assert.match(findOrg(join(bare, 'app'), { org: bare }).error, /no usable org guide/);
});

test('a forbidden name that is also listed is refused', () => {
  const root = orgDir({ guide: { ...GUIDE, forbidden: ['app'] } });
  assert.match(findOrg(join(root, 'app'), { org: root }).error, /forbidden/);
});

test('an unusable guide: not JSON, repos not an array, an entry without a name, a duplicate, a bad forbidden list', () => {
  for (const g of ['{', JSON.stringify({ repos: {} }), JSON.stringify({ repos: [null] }), JSON.stringify({ repos: [{ name: 'a' }, { name: 'a' }] }), JSON.stringify({ repos: [], forbidden: 'x' }), JSON.stringify({ repos: [], forbidden: [1] })]) {
    const root = orgDir({ guide: g });
    assert.strictEqual(readOrgManifest(root), null, g);
  }
});

test('the manifest maps harnesses to their app; a key inherited from Object.prototype is not listed', () => {
  const root = orgDir();
  const m = readOrgManifest(root);
  assert.strictEqual(m.repos.app.harness, 'app-qa');
  assert.match(findOrg(join(root, 'app'), { org: root }).name, /app/);
  repo(root, 'constructor');
  assert.match(findOrg(join(root, 'constructor'), { org: root }).error, /does not list/);
});

test('the pin is enforced: a config changed after pinning is refused', () => {
  const root = orgDir();
  const pin = orgPin(root);
  write(root, '.quality-kernel/repos/app/tools.json', '{"verify":"true","productionGlobs":["src/**"]}');
  assert.match(findOrg(join(root, 'app'), { org: root, pin }).error, /changed since it was pinned/);
  assert.ok(findOrg(join(root, 'app'), { org: root, pin: orgPin(root) }).name);
});

test('the pin covers the guide and every config file, including new ones', () => {
  const root = orgDir();
  const a = orgPin(root);
  write(root, '.quality-kernel/repos/app/critical-surface.json', '{}');
  const b = orgPin(root);
  assert.notStrictEqual(a, b);
  write(root, '.claude/org-workspace/guide.json', JSON.stringify({ ...GUIDE, org: 'Changed' }));
  assert.notStrictEqual(orgPin(root), b);
});

test('showOrgFile reads repos/<name>/<file>; absent -> null; file names cannot leave the dir', () => {
  const root = orgDir();
  const o = findOrg(join(root, 'app'), { org: root });
  assert.match(showOrgFile(o, 'tools.json'), /"verify":"x"/);
  assert.strictEqual(showOrgFile(o, 'critical-surface.json'), null);
  for (const bad of ['../lib/tools.json', '..', '', 'a/b.json']) assert.strictEqual(showOrgFile(o, bad), null, bad);
});

test('a symlinked config file or directory is refused (pin and read), never followed', () => {
  const root = orgDir();
  const weak = join(root, 'weak.json');
  writeFileSync(weak, '{"verify":"true","productionGlobs":["src/**"]}');
  unlinkSync(join(root, '.quality-kernel/repos/app/tools.json'));
  symlinkSync(weak, join(root, '.quality-kernel/repos/app/tools.json'));
  assert.throws(() => orgPin(root), /symlink/);
  assert.match(findOrg(join(root, 'app'), { org: root }).error, /symlink/);
  const root2 = orgDir({ files: {} });
  const real = realpathSync(mkdtempSync(join(tmpdir(), 'qk-orgm-cfg-')));
  write(real, 'app/tools.json', '{}');
  mkdirSync(join(root2, '.quality-kernel'), { recursive: true });
  symlinkSync(real, join(root2, '.quality-kernel', 'repos'));
  assert.throws(() => orgPin(root2), /symlink/);
});

test('a symlinked guide is refused (the org has no usable guide)', () => {
  const root = orgDir({ guide: null });
  const g = join(root, 'g.json'); writeFileSync(g, JSON.stringify(GUIDE));
  mkdirSync(join(root, '.claude', 'org-workspace'), { recursive: true });
  symlinkSync(g, join(root, '.claude', 'org-workspace', 'guide.json'));
  assert.strictEqual(readOrgManifest(root), null);
});

test('repo names with spaces and parentheses are supported; isRepoName accepts plain names only', () => {
  const root = orgDir({ guide: { repos: [{ name: 'my app (v2)', role: 'app', base: 'main' }] } });
  repo(root, 'my app (v2)');
  assert.strictEqual(findOrg(join(root, 'my app (v2)'), { org: root }).name, 'my app (v2)');
  for (const ok of ['a', 'mbvs-client-v2', 'x.y_z', 'a b (1)']) assert.ok(isRepoName(ok), ok);
  for (const bad of ['', '.', '..', 'a/b', '../x', 7, null]) assert.ok(!isRepoName(bad), String(bad));
});

// orgRepoDir: a repo entry must be a plain repo directly under the org folder, with its own .git.
const orgRoot = () => realpathSync(mkdtempSync(join(tmpdir(), 'qk-orgdir-')));
test('orgRepoDir: a plain repo directly under the org folder is accepted', () => {
  const org = orgRoot(); repo(org, 'app');
  assert.deepStrictEqual(orgRepoDir(org, 'app'), { dir: join(org, 'app') });
});

test('orgRepoDir: missing, non-plain name, plain file and symlinked entries are refused', () => {
  const org = orgRoot(); repo(org, 'app');
  writeFileSync(join(org, 'file'), 'x');
  symlinkSync(join(org, 'app'), join(org, 'alias'));
  assert.match(orgRepoDir(org, 'ghost').error, /repo not found/);
  assert.match(orgRepoDir(org, '../app').error, /not a plain repo name/);
  assert.match(orgRepoDir(org, 'file').error, /not a directory/);
  assert.match(orgRepoDir(org, 'alias').error, /is a symlink/);
});

test('orgRepoDir: a case-folded name (App for app) is refused on a case-insensitive file system', (t) => {
  const org = orgRoot(); repo(org, 'app');
  if (!existsSync(join(org, 'APP'))) { t.skip('case-sensitive file system: App is simply not found'); return; }
  assert.match(orgRepoDir(org, 'App').error, /resolves to .*\/app, not .*\/App/);
});

// Round-4 finding H1: a `.git` gitfile let an innocent name read and run a forbidden repo.
test('orgRepoDir: a .git gitfile pointing at another repository (e.g. a forbidden one) is refused', () => {
  const org = orgRoot(); repo(org, 'secret-qa');
  mkdirSync(join(org, 'innocent'));
  writeFileSync(join(org, 'innocent', '.git'), 'gitdir: ../secret-qa/.git\n');
  assert.match(orgRepoDir(org, 'innocent').error, /gitfile/);
});

test('orgRepoDir: a symlinked .git, an object alternates file and a linked worktree are refused', () => {
  const org = orgRoot(); const qa = repo(org, 'secret-qa');
  mkdirSync(join(org, 'linked')); symlinkSync(join(org, 'secret-qa', '.git'), join(org, 'linked', '.git'));
  assert.match(orgRepoDir(org, 'linked').error, /\.git is a symlink/);
  const borrow = repo(org, 'borrow');
  writeFileSync(join(borrow.dir, '.git', 'objects', 'info', 'alternates'), join(org, 'secret-qa', '.git', 'objects') + '\n');
  assert.match(orgRepoDir(org, 'borrow').error, /alternates/);
  qa.git('worktree', 'add', '-q', join(org, 'wt'));
  assert.match(orgRepoDir(org, 'wt').error, /gitfile/);
});
