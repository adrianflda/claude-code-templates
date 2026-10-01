import './hermetic-git.mjs';
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, realpathSync, readdirSync, chmodSync, symlinkSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { findWorkspace, showWorkspaceFile, resolveWorkspaceRef, readWorkspaceManifest, isRepoName, orgRepoDir } from './workspace.mjs';

// An org folder: <root>/app (a product repo) and <root>/workspace (the control repo).
const gitIn = (dir) => (...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
function write(dir, p, c) { const d = join(dir, p); mkdirSync(dirname(d), { recursive: true }); writeFileSync(d, c); }
function repo(root, name, files = { 'README.md': name }) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const git = gitIn(dir);
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  for (const [p, c] of Object.entries(files)) write(dir, p, c);
  git('add', '-A'); git('commit', '-qm', 'init');
  return { dir, git, sha: () => git('rev-parse', 'HEAD').stdout.trim() };
}
function commit(r, files, msg = 'more') {
  for (const [p, c] of Object.entries(files)) write(r.dir, p, c);
  r.git('add', '-A'); r.git('commit', '-qm', msg);
  return r.sha();
}
const manifest = (extra = {}, repos = { app: { role: 'app', base: 'main' } }) =>
  JSON.stringify({ version: 1, org: 'Org', repos, forbidden: [], ...extra });
const TOOLS = '{"verify":"node --test"}';
function org({ appName = 'app', workspaceFiles = { 'workspace.json': manifest(), 'repos/app/tools.json': TOOLS } } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'qk-ws-')));
  const app = repo(root, appName);
  const ws = workspaceFiles ? repo(root, 'workspace', workspaceFiles) : null;
  return { root, app, ws };
}

// --- mode is explicit ---
test('without an explicit workspace the mode is off, even when a sibling workspace lists the repo', () => {
  const { app } = org();
  assert.strictEqual(findWorkspace(app.dir), null);
  assert.strictEqual(findWorkspace(app.dir, {}), null);
});

test('an explicit workspace that lists the repo is pinned to the commit of its main', () => {
  const { app, ws } = org();
  assert.deepStrictEqual(findWorkspace(app.dir, { workspace: ws.dir }), { dir: ws.dir, ref: 'main', sha: ws.sha(), name: 'app' });
});

test('the repo is resolved from a subdirectory to its top level', () => {
  const { app, ws } = org();
  mkdirSync(join(app.dir, 'src'));
  assert.strictEqual(findWorkspace(join(app.dir, 'src'), { workspace: ws.dir }).name, 'app');
});

// --- an explicit workspace that cannot serve the repo fails closed with a reason ---
const errorOf = (r) => (r && r.error) || '';

test('a workspace that does not list the repo -> error', () => {
  const { app, ws } = org({ workspaceFiles: { 'workspace.json': manifest({}, { other: { role: 'app', base: 'main' } }) } });
  assert.match(errorOf(findWorkspace(app.dir, { workspace: ws.dir })), /does not list "app"/);
});

test('a forbidden repo -> error', () => {
  const { app, ws } = org({ workspaceFiles: { 'workspace.json': manifest({ forbidden: ['app'] }) } });
  assert.match(errorOf(findWorkspace(app.dir, { workspace: ws.dir })), /forbidden/);
});

test('a listed repo whose role is not "app" -> error', () => {
  const { app, ws } = org({ workspaceFiles: { 'workspace.json': manifest({}, { app: { role: 'harness', base: 'main' } }) } });
  assert.match(errorOf(findWorkspace(app.dir, { workspace: ws.dir })), /role/);
});

test('an unsupported manifest version -> error', () => {
  const { app, ws } = org({ workspaceFiles: { 'workspace.json': manifest({ version: 2 }) } });
  assert.match(errorOf(findWorkspace(app.dir, { workspace: ws.dir })), /no usable workspace\.json/);
});

test('a manifest that is only in the worktree (never committed) is not trusted', () => {
  const { app, ws } = org({ workspaceFiles: { 'README.md': 'ws' } });
  write(ws.dir, 'workspace.json', manifest());
  assert.match(errorOf(findWorkspace(app.dir, { workspace: ws.dir })), /no usable workspace\.json/);
});

test('a key inherited from Object.prototype does not count as listed', () => {
  const { app, ws } = org({ appName: 'constructor', workspaceFiles: { 'workspace.json': manifest() } });
  assert.match(errorOf(findWorkspace(app.dir, { workspace: ws.dir })), /does not list "constructor"/);
});

test('a workspace that is only a subfolder of another repo is refused', () => {
  const { root, app } = org({ workspaceFiles: null });
  repo(root, 'outer', { 'ws/workspace.json': manifest(), 'ws/repos/app/tools.json': TOOLS });
  assert.match(errorOf(findWorkspace(app.dir, { workspace: join(root, 'outer', 'ws') })), /not a git repository of its own/);
});

test('a repo cannot be its own workspace', () => {
  const { app } = org({ workspaceFiles: null });
  commit(app, { 'workspace.json': manifest(), 'repos/app/tools.json': TOOLS });
  assert.match(errorOf(findWorkspace(app.dir, { workspace: app.dir })), /cannot be its own workspace/);
});

test('a product dir that is not a git repo -> error', () => {
  const { root, ws } = org({ workspaceFiles: { 'workspace.json': manifest() } });
  mkdirSync(join(root, 'plain'));
  assert.match(errorOf(findWorkspace(join(root, 'plain'), { workspace: ws.dir })), /not a git repository/);
});

test('repo names with spaces and parentheses are supported', () => {
  const { app, ws } = org({ appName: 'mbvs-server-v2 (Copy)', workspaceFiles: { 'workspace.json': manifest({}, { 'mbvs-server-v2 (Copy)': { role: 'app', base: 'main' } }), 'repos/mbvs-server-v2 (Copy)/tools.json': TOOLS } });
  const found = findWorkspace(app.dir, { workspace: ws.dir });
  assert.strictEqual(found.name, 'mbvs-server-v2 (Copy)');
  assert.strictEqual(showWorkspaceFile(found, 'tools.json'), TOOLS);
});

test('isRepoName accepts plain sibling names only', () => {
  for (const ok of ['mbvs-client-v2', 'mbvs-server-v2 (Copy)', 'a.b_c']) assert.strictEqual(isRepoName(ok), true, ok);
  for (const bad of ['', '.', '..', '../x', 'a/b', 'a\\b', null, 7]) assert.strictEqual(isRepoName(bad), false, String(bad));
});

// --- files are read from the pinned commit only ---
test('uncommitted edits in the workspace are ignored', () => {
  const { app, ws } = org();
  write(ws.dir, 'repos/app/tools.json', '{"verify":"true"}');
  assert.strictEqual(showWorkspaceFile(findWorkspace(app.dir, { workspace: ws.dir }), 'tools.json'), TOOLS);
});

test('files are read at the pinned SHA even if main moves afterwards', () => {
  const { app, ws } = org();
  const found = findWorkspace(app.dir, { workspace: ws.dir });
  commit(ws, { 'repos/app/tools.json': '{"verify":"true"}' }, 'weaken');
  assert.strictEqual(showWorkspaceFile(found, 'tools.json'), TOOLS);
});

test('a workspace file that does not exist -> null', () => {
  const { app, ws } = org();
  assert.strictEqual(showWorkspaceFile(findWorkspace(app.dir, { workspace: ws.dir }), 'critical-surface.json'), null);
});

test('file names cannot leave repos/<name>/ even when the target is committed', () => {
  const { app, ws } = org({ workspaceFiles: { 'workspace.json': manifest(), 'repos/app/tools.json': TOOLS, 'repos/app/nested/tools.json': '{"verify":"true"}', 'secret.json': '{}' } });
  const found = findWorkspace(app.dir, { workspace: ws.dir });
  assert.strictEqual(showWorkspaceFile(found, 'nested/tools.json'), null);
  assert.strictEqual(showWorkspaceFile(found, '../../secret.json'), null);
  assert.strictEqual(showWorkspaceFile(found, 'tools.json:x'), null);
});

// --- ref resolution: qualified, pinned, not injectable ---
test('a tag named like the branch cannot shadow it', () => {
  const { ws } = org();
  const honest = ws.sha();
  ws.git('switch', '-q', '-c', 'weak');
  const weak = commit(ws, { 'repos/app/tools.json': '{"verify":"true"}' }, 'weak');
  ws.git('switch', '-q', 'main');
  ws.git('tag', 'main', weak);
  assert.strictEqual(ws.git('rev-parse', 'main').stdout.trim(), weak, 'control: git itself resolves the tag first');
  assert.strictEqual(resolveWorkspaceRef(ws.dir, 'main'), honest);
});

// A clone of an upstream workspace: origin/main and the local main both exist.
function cloned() {
  const { root } = org({ workspaceFiles: null });
  const upstream = repo(root, 'upstream', { 'workspace.json': manifest() });
  spawnSync('git', ['clone', '-q', upstream.dir, join(root, 'workspace')]);
  const ws = { dir: join(root, 'workspace'), git: gitIn(join(root, 'workspace')) };
  ws.git('config', 'user.email', 't@t'); ws.git('config', 'user.name', 't');
  return { root, upstream, ws };
}

test('origin/<ref> and the local branch on the same commit -> that commit', () => {
  const { upstream, ws } = cloned();
  assert.strictEqual(resolveWorkspaceRef(ws.dir, 'main'), upstream.sha());
});

test('origin/<ref> and the local branch on different commits -> refused (which one is trusted is ambiguous)', () => {
  const { upstream, ws } = cloned();
  write(ws.dir, 'x.txt', 'unreviewed'); ws.git('add', '-A'); ws.git('commit', '-qm', 'local only');
  assert.notStrictEqual(ws.git('rev-parse', 'refs/heads/main').stdout.trim(), upstream.sha(), 'control: local main moved');
  assert.strictEqual(resolveWorkspaceRef(ws.dir, 'main'), null);
});

test('only origin/<ref> exists -> origin', () => {
  const { upstream, ws } = cloned();
  ws.git('switch', '-q', '--detach'); ws.git('branch', '-q', '-D', 'main');
  assert.strictEqual(resolveWorkspaceRef(ws.dir, 'main'), upstream.sha());
});

test('a tree or blob id is not a commit and is refused as the ref', () => {
  const { ws } = org();
  write(ws.dir, 'staged.txt', 'never committed'); ws.git('add', 'staged.txt');
  const tree = ws.git('write-tree').stdout.trim();
  const blob = ws.git('hash-object', '-w', 'staged.txt').stdout.trim();
  assert.match(tree, /^[0-9a-f]{40}$/);
  assert.strictEqual(resolveWorkspaceRef(ws.dir, tree), null);
  assert.strictEqual(resolveWorkspaceRef(ws.dir, blob), null);
});

test('an empty --workspace value is mode ON and fails closed (not single-repo)', () => {
  const { app } = org();
  assert.match(errorOf(findWorkspace(app.dir, { workspace: '' })), /empty/);
});

test('a manifest whose "forbidden" is not an array is unusable', () => {
  for (const forbidden of [{ app: 1 }, 'app', 7]) {
    const { app, ws } = org({ workspaceFiles: { 'workspace.json': manifest({ forbidden }) } });
    assert.strictEqual(readWorkspaceManifest(ws.dir, 'main'), null, JSON.stringify(forbidden));
    assert.match(errorOf(findWorkspace(app.dir, { workspace: ws.dir })), /no usable workspace\.json/);
  }
});

test('a full commit SHA is accepted as the ref', () => {
  const { ws } = org();
  const sha = ws.sha();
  assert.strictEqual(resolveWorkspaceRef(ws.dir, sha), sha);
});

test('revision syntax, abbreviated SHAs and missing refs are refused', () => {
  const { ws } = org();
  commit(ws, { 'x.txt': '1' });
  for (const bad of ['main~1', 'main^', 'HEAD', ws.sha().slice(0, 12), 'nope', '', undefined]) {
    assert.strictEqual(resolveWorkspaceRef(ws.dir, bad), null, String(bad));
  }
});

test('an option-looking ref cannot inject git options (no file is written)', () => {
  const { root, ws } = org();
  const out = join(root, 'pwned.txt');
  assert.strictEqual(resolveWorkspaceRef(ws.dir, `--output=${out}`), null);
  assert.strictEqual(readWorkspaceManifest(ws.dir, `--output=${out}`), null);
  assert.deepStrictEqual(readdirSync(root).filter((f) => f.startsWith('pwned')), []);
  assert.strictEqual(existsSync(out), false);
});

test('readWorkspaceManifest returns the pinned SHA it read from', () => {
  const { ws } = org();
  const m = readWorkspaceManifest(ws.dir, 'main');
  assert.strictEqual(m.sha, ws.sha());
  assert.deepStrictEqual(Object.keys(m.repos), ['app']);
});

// --- round 4: config blobs are hash-verified (a forged loose object is not "absent") ---
// Rewrite the loose object of `rev` in place with new bytes under the SAME id (what code executed
// by a gate could do). git show / cat-file then return the forged bytes without complaint.
function forge(dir, rev, content) {
  const oid = spawnSync('git', ['-C', dir, 'rev-parse', rev], { encoding: 'utf8' }).stdout.trim();
  const p = join(dir, '.git', 'objects', oid.slice(0, 2), oid.slice(2));
  chmodSync(p, 0o644);
  const body = Buffer.from(content);
  writeFileSync(p, deflateSync(Buffer.concat([Buffer.from(`blob ${body.length}\0`), body])));
  return oid;
}

test('a forged repos/<name>/ blob throws (fails closed) instead of reading as the pinned file', () => {
  const { app, ws } = org();
  const found = findWorkspace(app.dir, { workspace: ws.dir });
  forge(ws.dir, 'main:repos/app/tools.json', '{"verify":"true"}');
  assert.strictEqual(ws.git('show', 'main:repos/app/tools.json').stdout, '{"verify":"true"}', 'control: git show returns the forged bytes');
  assert.throws(() => showWorkspaceFile(found, 'tools.json'), /does not hash to its id/);
});

test('a forged workspace.json makes the manifest unusable', () => {
  const { app, ws } = org();
  forge(ws.dir, 'main:workspace.json', manifest({}, { app: { role: 'app', base: 'main' }, evil: { role: 'app', base: 'main' } }));
  assert.strictEqual(readWorkspaceManifest(ws.dir, 'main'), null);
  assert.match(errorOf(findWorkspace(app.dir, { workspace: ws.dir })), /no usable workspace\.json/);
});

test('a corrupt tree on the path is an integrity error, not "absent" (no fallback)', () => {
  const { app, ws } = org();
  const found = findWorkspace(app.dir, { workspace: ws.dir });
  const tree = ws.git('rev-parse', 'main:repos/app').stdout.trim();
  const p = join(ws.dir, '.git', 'objects', tree.slice(0, 2), tree.slice(2));
  chmodSync(p, 0o644); writeFileSync(p, 'garbage');
  assert.notStrictEqual(ws.git('rev-parse', '--verify', '-q', 'main:repos/app/tools.json').status, 0, 'control: git cannot resolve the path any more');
  assert.throws(() => showWorkspaceFile(found, 'tools.json'), /integrity/);
});

test('a symlink entry at a config path is refused (not parsed as config)', () => {
  const { app, ws } = org({ workspaceFiles: { 'workspace.json': manifest() } });
  mkdirSync(join(ws.dir, 'repos', 'app'), { recursive: true });
  symlinkSync('{"verify":"true"}', join(ws.dir, 'repos', 'app', 'tools.json'));
  ws.git('add', 'repos/app/tools.json'); ws.git('commit', '-qm', 'symlink config');
  assert.throws(() => showWorkspaceFile(findWorkspace(app.dir, { workspace: ws.dir }), 'tools.json'), /not a regular file/);
});

// orgRepoDir: the guard /init-workspace propose and verify use before a repo is opened or run.
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
