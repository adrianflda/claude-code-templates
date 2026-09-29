import './hermetic-git.mjs';
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, symlinkSync, chmodSync, unlinkSync, cpSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Workspace mode for the gate (explicit --workspace): a listed repo's verify contract and critical
// surface come from <workspace>/repos/<name>/ at the workspace commit the ref pins, and win over
// the repo's own. Without --workspace nothing changes.
const here = dirname(fileURLToPath(import.meta.url));
const TOOLS = { verify: 'node --test guard.test.mjs', productionGlobs: ['src/**'] };
const WEAK_TOOLS = { verify: 'true', productionGlobs: ['src/**'] };
const SURFACE = { criticalGlobs: ['src/auth/**'], safeGlobs: ['docs/**'] };
const CODE_OK = 'export const f = () => 1;';
const CODE_BROKEN = 'export const f = () => 2;';
const TWEAK = { 'src/code.mjs': 'export const f = () => 1; // tweak' };
const GUARD = "import { test } from 'node:test'; import a from 'node:assert'; import { f } from './src/code.mjs'; test('g', () => a.strictEqual(f(), 1));";

function write(dir, p, c) { const d = join(dir, p); mkdirSync(dirname(d), { recursive: true }); writeFileSync(d, c); }
function repo(dir, files) {
  mkdirSync(dir, { recursive: true });
  const git = (...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  for (const [p, c] of Object.entries(files)) write(dir, p, c);
  git('add', '-A'); git('commit', '-qm', 'init');
  return git;
}
const manifest = JSON.stringify({ version: 1, org: 'Org', repos: { app: { role: 'app', base: 'main' } } });
const WS_FILES = { 'workspace.json': manifest, 'repos/app/tools.json': JSON.stringify(TOOLS), 'repos/app/critical-surface.json': JSON.stringify(SURFACE) };

// org(): <root>/app with base+head commits, and optionally <root>/workspace.
function org({ appOwn = {}, wsFiles = WS_FILES, change = TWEAK } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'qk-wsg-')));
  const app = join(root, 'app');
  const git = repo(app, { 'src/code.mjs': CODE_OK, 'guard.test.mjs': GUARD, 'docs/a.md': 'a', ...appOwn });
  const base = git('rev-parse', 'HEAD').stdout.trim();
  for (const [p, c] of Object.entries(change)) write(app, p, c);
  git('add', '-A'); git('commit', '-qm', 'change');
  const head = git('rev-parse', 'HEAD').stdout.trim();
  const ws = join(root, 'workspace');
  const wsGit = wsFiles ? repo(ws, wsFiles) : null;
  return { root, app, ws, wsGit, base, head };
}
function run(script, o, extra = []) {
  const r = spawnSync('node', [join(here, script), '--repo', o.app, '--base', o.base, '--head', o.head, ...extra], { encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse((r.stdout || '').trim().split('\n').filter(Boolean).pop()); } catch { /* null */ }
  return { code: r.status, json };
}
const WS = (o) => ['--workspace', o.ws];
const wsSha = (o) => o.wsGit('rev-parse', 'refs/heads/main').stdout.trim();

// --- the mode is explicit: single-repo behaviour is untouched without --workspace ---
test('no --workspace: a sibling workspace is NOT used, a repo without contract stays indeterminate', () => {
  const o = org({ change: { 'src/code.mjs': CODE_BROKEN } });
  const r = run('referee.mjs', o);
  assert.strictEqual(r.code, 2, JSON.stringify(r.json));
  assert.match(r.json.reason, /no \.quality-kernel\/tools\.json at base/);
  const rt = run('route.mjs', o);
  assert.match(rt.json.reason, /no critical-surface config/);
});

// --- referee ---
test('referee: a covered break is caught with the workspace contract (FAIL, exit 1)', () => {
  const r = run('referee.mjs', org({ change: { 'src/code.mjs': CODE_BROKEN } }), []);
  assert.strictEqual(r.code, 2, 'control: without --workspace it is indeterminate');
  const o = org({ change: { 'src/code.mjs': CODE_BROKEN } });
  const w = run('referee.mjs', o, WS(o));
  assert.strictEqual(w.code, 1, JSON.stringify(w.json));
});

test('referee: a clean change passes and the evidence pins the workspace commit', () => {
  const o = org();
  const r = run('referee.mjs', o, WS(o));
  assert.strictEqual(r.code, 0, JSON.stringify(r.json));
  assert.deepStrictEqual(r.json.evidence.toolsSource, { source: 'workspace', workspace: o.ws, ref: 'main', sha: wsSha(o) });
});

test("referee: in workspace mode the workspace contract wins over the repo's own weaker one", () => {
  const o = org({ appOwn: { '.quality-kernel/tools.json': JSON.stringify(WEAK_TOOLS) }, change: { 'src/code.mjs': CODE_BROKEN } });
  assert.strictEqual(run('referee.mjs', o).code, 0, "control: alone, the repo's weak contract passes the break");
  const r = run('referee.mjs', o, WS(o));
  assert.strictEqual(r.code, 1, JSON.stringify(r.json));
  assert.strictEqual(r.json.evidence.toolsSource.source, 'workspace');
});

test("referee: the repo's own contract is used when the workspace has none for it", () => {
  const o = org({ appOwn: { '.quality-kernel/tools.json': JSON.stringify(TOOLS) }, wsFiles: { 'workspace.json': manifest } });
  const r = run('referee.mjs', o, WS(o));
  assert.strictEqual(r.code, 0, JSON.stringify(r.json));
  assert.deepStrictEqual(r.json.evidence.toolsSource, { source: 'repo', ref: o.base });
});

test('referee: an explicit workspace that cannot serve the repo fails closed with the reason', () => {
  const o = org({ appOwn: { '.quality-kernel/tools.json': JSON.stringify(TOOLS) }, wsFiles: { 'workspace.json': JSON.stringify({ version: 1, org: 'O', repos: {}, forbidden: [] }) } });
  const r = run('referee.mjs', o, WS(o));
  assert.strictEqual(r.code, 2, JSON.stringify(r.json));
  assert.match(r.json.reason, /workspace mode: the workspace does not list "app"/);
});

test('referee: a workspace contract that is only in the worktree is not trusted', () => {
  const o = org({ wsFiles: { 'workspace.json': manifest } });
  write(o.ws, 'repos/app/tools.json', JSON.stringify(TOOLS));
  const r = run('referee.mjs', o, WS(o));
  assert.strictEqual(r.code, 2, JSON.stringify(r.json));
  assert.match(r.json.reason, /no tools\.json in the workspace .* nor \.quality-kernel\/tools\.json at base/);
});

test('referee: an unreadable workspace contract fails closed naming the workspace', () => {
  const o = org({ wsFiles: { ...WS_FILES, 'repos/app/tools.json': '{ nope' } });
  const r = run('referee.mjs', o, WS(o));
  assert.strictEqual(r.code, 2, JSON.stringify(r.json));
  assert.match(r.json.reason, /unreadable tools\.json \(workspace/);
});

test('referee: a tag named main cannot swap in a weaker workspace contract', () => {
  const o = org({ change: { 'src/code.mjs': CODE_BROKEN } });
  o.wsGit('switch', '-q', '-c', 'weak');
  write(o.ws, 'repos/app/tools.json', JSON.stringify(WEAK_TOOLS));
  o.wsGit('commit', '-qam', 'weak');
  const weak = o.wsGit('rev-parse', 'HEAD').stdout.trim();
  o.wsGit('switch', '-q', 'main'); o.wsGit('tag', 'main', weak);
  const r = run('referee.mjs', o, WS(o));
  assert.strictEqual(r.code, 1, JSON.stringify(r.json));
  assert.notStrictEqual(r.json.evidence.toolsSource.sha, weak);
});

test('referee: the ledger records where the contract came from', () => {
  const o = org();
  run('referee.mjs', o, WS(o));
  const lines = readFileSync(join(o.app, '.quality-kernel', 'evidence-ledger.jsonl'), 'utf8').trim().split('\n');
  assert.deepStrictEqual(JSON.parse(lines.pop()).tools_source, { source: 'workspace', workspace: o.ws, ref: 'main', sha: wsSha(o) });
});

test('referee: an option-looking --workspace-ref is refused and writes nothing', () => {
  const o = org();
  const out = join(o.root, 'pwned.txt');
  const r = run('referee.mjs', o, [...WS(o), '--workspace-ref', `--output=${out}`]);
  assert.strictEqual(r.code, 2, JSON.stringify(r.json));
  assert.strictEqual(existsSync(out) || existsSync(`${out}:workspace.json`), false);
});

// --- route ---
test('route: the workspace surface classifies (safe docs change -> trivial) and reports its source', () => {
  const o = org({ change: { 'docs/a.md': 'b' } });
  const r = run('route.mjs', o, WS(o));
  assert.strictEqual(r.code, 0, JSON.stringify(r.json));
  assert.strictEqual(r.json.tier, 'trivial');
  assert.deepStrictEqual(r.json.configSource, { source: 'workspace', workspace: o.ws, ref: 'main', sha: wsSha(o) });
});

test('route: the workspace surface marks critical paths', () => {
  const o = org({ change: { 'src/auth/login.mjs': 'export const x = 1;' } });
  const r = run('route.mjs', o, WS(o));
  assert.strictEqual(r.json.tier, 'critical');
  assert.deepStrictEqual(r.json.criticalFiles, ['src/auth/login.mjs']);
});

test("route: in workspace mode the workspace surface wins over the repo's own permissive one", () => {
  const o = org({ appOwn: { '.quality-kernel/critical-surface.json': JSON.stringify({ safeGlobs: ['src/**'] }) }, change: { 'src/auth/login.mjs': 'export const x = 1;' } });
  assert.strictEqual(run('route.mjs', o).json.tier, 'trivial', "control: the repo's surface alone calls it trivial");
  const r = run('route.mjs', o, WS(o));
  assert.strictEqual(r.json.tier, 'critical', JSON.stringify(r.json));
});

test("route: the repo's own surface is used when the workspace has none, and says so", () => {
  const o = org({ appOwn: { '.quality-kernel/critical-surface.json': JSON.stringify(SURFACE) }, wsFiles: { 'workspace.json': manifest }, change: { 'docs/a.md': 'b' } });
  const r = run('route.mjs', o, WS(o));
  assert.strictEqual(r.json.tier, 'trivial', JSON.stringify(r.json));
  assert.deepStrictEqual(r.json.configSource, { source: 'repo', ref: o.base });
});

test('route: --workspace-ref selects the workspace commit', () => {
  const o = org({ wsFiles: { 'workspace.json': manifest }, change: { 'docs/a.md': 'b' } });
  o.wsGit('switch', '-q', '-c', 'trusted');
  write(o.ws, 'repos/app/critical-surface.json', JSON.stringify(SURFACE));
  o.wsGit('add', '-A'); o.wsGit('commit', '-qm', 'surface');
  assert.strictEqual(run('route.mjs', o, WS(o)).json.tier, 'critical', 'control: main has no surface');
  assert.strictEqual(run('route.mjs', o, [...WS(o), '--workspace-ref', 'trusted']).json.tier, 'trivial');
});

test('route: an explicit workspace that cannot serve the repo fails closed', () => {
  const o = org({ wsFiles: { 'workspace.json': JSON.stringify({ version: 1, org: 'O', repos: { app: { role: 'app', base: 'main' } }, forbidden: ['app'] }) } });
  const r = run('route.mjs', o, WS(o));
  assert.strictEqual(r.code, 2, JSON.stringify(r.json));
  assert.match(r.json.error, /workspace mode: "app" is forbidden/);
});

test('route: unreadable and invalid workspace surfaces fail closed naming the workspace', () => {
  for (const bad of ['{ nope', '{"criticalGlobs":"src/**"}']) {
    const o = org({ wsFiles: { ...WS_FILES, 'repos/app/critical-surface.json': bad } });
    const r = run('route.mjs', o, WS(o));
    assert.strictEqual(r.code, 2, JSON.stringify(r.json));
    assert.match(r.json.error, /(unreadable|invalid) critical-surface\.json at workspace/);
  }
});

// --- qk-gate: resolves the workspace commit once and hands the SAME sha to route and referee ---
test('qk-gate: clean change with workspace config -> exit 0; route and referee used the same commit', () => {
  const o = org();
  const r = run('qk-gate.mjs', o, WS(o));
  assert.strictEqual(r.code, 0, JSON.stringify(r.json));
  assert.strictEqual(r.json.route.configSource.sha, wsSha(o));
  assert.strictEqual(r.json.referee.evidence.toolsSource.sha, wsSha(o));
});

test('qk-gate: a workspace ref that does not resolve -> indeterminate before anything runs', () => {
  const o = org();
  const r = run('qk-gate.mjs', o, [...WS(o), '--workspace-ref', 'nope']);
  assert.strictEqual(r.code, 2, JSON.stringify(r.json));
  assert.match(r.json.notes.join(' '), /workspace ref "nope" does not resolve/);
});

// --- round 3 ---
test('qk-gate: the SAME pinned sha is what route and referee received (not the symbolic ref), and the output names both', () => {
  const o = org();
  const r = run('qk-gate.mjs', o, WS(o));
  assert.strictEqual(r.code, 0, JSON.stringify(r.json));
  assert.strictEqual(r.json.route.configSource.ref, wsSha(o));
  assert.strictEqual(r.json.referee.evidence.toolsSource.ref, wsSha(o));
  assert.deepStrictEqual(r.json.workspace, { dir: o.ws, ref: 'main', sha: wsSha(o) });
});

test('--workspace with an empty value fails closed in route, referee and qk-gate (never single-repo)', () => {
  // the repo's own weak contract would pass the break if the flag were silently ignored
  const o = org({ appOwn: { '.quality-kernel/tools.json': JSON.stringify(WEAK_TOOLS) }, change: { 'src/code.mjs': CODE_BROKEN } });
  for (const s of ['referee.mjs', 'route.mjs', 'qk-gate.mjs']) {
    const r = spawnSync('node', [join(here, s), '--repo', o.app, '--base', o.base, '--head', o.head, '--workspace', ''], { encoding: 'utf8', cwd: o.app });
    assert.strictEqual(r.status, 2, `${s}: ${r.stdout}`);
  }
});

test('--workspace given last with no value fails closed in route, referee and qk-gate', () => {
  const o = org({ appOwn: { '.quality-kernel/tools.json': JSON.stringify(WEAK_TOOLS) }, change: { 'src/code.mjs': CODE_BROKEN } });
  for (const s of ['referee.mjs', 'route.mjs', 'qk-gate.mjs']) {
    const r = spawnSync('node', [join(here, s), '--repo', o.app, '--base', o.base, '--head', o.head, '--workspace'], { encoding: 'utf8' });
    assert.strictEqual(r.status, 2, `${s}: ${r.stdout}`);
  }
});

test('qk-gate: code executed by the gate that moves the workspace ref makes the run indeterminate', () => {
  const mover = `import { execFileSync } from 'node:child_process';\n`
    + `execFileSync('git', ['-C', ${JSON.stringify(join('WS'))}, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'moved by the change']);\n`
    + `export const f = () => 1;`;
  const o = org({ change: { 'src/code.mjs': 'export const f = () => 1; // placeholder' } });
  // rewrite head with the real workspace path, as a new commit on top of the change
  const git = (...a) => spawnSync('git', ['-C', o.app, ...a], { encoding: 'utf8' });
  write(o.app, 'src/code.mjs', mover.replace('"WS"', JSON.stringify(o.ws)));
  git('commit', '-qam', 'mover'); o.head = git('rev-parse', 'HEAD').stdout.trim();
  const before = wsSha(o);
  const r = run('qk-gate.mjs', o, WS(o));
  assert.notStrictEqual(wsSha(o), before, 'control: the executed code really moved the workspace ref');
  assert.strictEqual(r.code, 2, JSON.stringify(r.json));
  assert.match(r.json.notes.join(' '), /workspace ref "main" moved during the run/);
});

test('route: invoked through a symlinked scripts dir it still runs (no silent exit 0)', () => {
  const link = join(realpathSync(mkdtempSync(join(tmpdir(), 'qk-link-'))), 'scripts');
  symlinkSync(here, link);
  const r = spawnSync('node', [join(link, 'route.mjs')], { encoding: 'utf8' });
  assert.strictEqual(r.status, 2, `stdout=${r.stdout}`);
  assert.match(r.stdout, /need --changed/);
});

// --- round 4: forged config blobs fail closed; a real failure is never downgraded ---
function forge(dir, rev, content) {
  const oid = spawnSync('git', ['-C', dir, 'rev-parse', rev], { encoding: 'utf8' }).stdout.trim();
  const p = join(dir, '.git', 'objects', oid.slice(0, 2), oid.slice(2));
  chmodSync(p, 0o644);
  const body = Buffer.from(content);
  writeFileSync(p, deflateSync(Buffer.concat([Buffer.from(`blob ${body.length}\0`), body])));
}

test('referee: a forged workspace tools.json fails closed (the break is never passed)', () => {
  const o = org({ change: { 'src/code.mjs': CODE_BROKEN } });
  forge(o.ws, 'main:repos/app/tools.json', JSON.stringify(WEAK_TOOLS));
  const r = run('referee.mjs', o, WS(o));
  assert.strictEqual(r.code, 2, JSON.stringify(r.json));
  assert.match(r.json.reason, /does not hash to its id/);
});

test("referee: the repo's own tools.json forged at base fails closed (no workspace)", () => {
  const o = org({ appOwn: { '.quality-kernel/tools.json': JSON.stringify(TOOLS) }, wsFiles: null, change: { 'src/code.mjs': CODE_BROKEN } });
  forge(o.app, `${o.base}:.quality-kernel/tools.json`, JSON.stringify(WEAK_TOOLS));
  const r = run('referee.mjs', o);
  assert.strictEqual(r.code, 2, JSON.stringify(r.json));
  assert.match(r.json.reason, /does not hash to its id/);
});

test('route: forged workspace and repo surfaces fail closed', () => {
  const a = org({ change: { 'src/auth/login.mjs': 'export const x = 1;' } });
  forge(a.ws, 'main:repos/app/critical-surface.json', JSON.stringify({ safeGlobs: ['src/**'] }));
  const ra = run('route.mjs', a, WS(a));
  assert.strictEqual(ra.code, 2, JSON.stringify(ra.json));
  assert.match(ra.json.error, /does not hash to its id/);
  const b = org({ appOwn: { '.quality-kernel/critical-surface.json': JSON.stringify(SURFACE) }, wsFiles: null, change: { 'src/auth/login.mjs': 'export const x = 1;' } });
  forge(b.app, `${b.base}:.quality-kernel/critical-surface.json`, JSON.stringify({ safeGlobs: ['src/**'] }));
  const rb = run('route.mjs', b);
  assert.strictEqual(rb.code, 2, JSON.stringify(rb.json));
  assert.match(rb.json.error, /does not hash to its id/);
});

test('qk-gate: a real failure stays a failure (exit 1) even when the workspace ref moved', () => {
  const o = org();
  const git = (...a) => spawnSync('git', ['-C', o.app, ...a], { encoding: 'utf8' });
  write(o.app, 'src/code.mjs', `import { execFileSync } from 'node:child_process';\n`
    + `execFileSync('git', ['-C', ${JSON.stringify(o.ws)}, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'moved']);\n`
    + `export const f = () => 2;`);
  git('commit', '-qam', 'broken mover'); o.head = git('rev-parse', 'HEAD').stdout.trim();
  const r = run('qk-gate.mjs', o, WS(o));
  assert.strictEqual(r.code, 1, JSON.stringify(r.json));
  assert.match(r.json.notes.join(' '), /moved during the run/);
});

test("referee: a corrupt workspace tree never falls back to the repo's own weak contract", () => {
  const o = org({ appOwn: { '.quality-kernel/tools.json': JSON.stringify(WEAK_TOOLS) }, change: { 'src/code.mjs': CODE_BROKEN } });
  const tree = o.wsGit('rev-parse', 'main:repos/app').stdout.trim();
  const p = join(o.ws, '.git', 'objects', tree.slice(0, 2), tree.slice(2));
  chmodSync(p, 0o644); writeFileSync(p, 'garbage');
  const r = run('referee.mjs', o, WS(o));
  assert.strictEqual(r.code, 2, JSON.stringify(r.json));
  assert.match(r.json.reason, /integrity/);
});

test('a deleted config blob is an integrity error, never "absent" (referee and route, no fallback)', () => {
  const unlinkObj = (dir, rev) => {
    const oid = spawnSync('git', ['-C', dir, 'rev-parse', rev], { encoding: 'utf8' }).stdout.trim();
    unlinkSync(join(dir, '.git', 'objects', oid.slice(0, 2), oid.slice(2)));
  };
  const a = org({ appOwn: { '.quality-kernel/tools.json': JSON.stringify(WEAK_TOOLS) }, change: { 'src/code.mjs': CODE_BROKEN } });
  unlinkObj(a.ws, 'main:repos/app/tools.json');
  const ra = run('referee.mjs', a, WS(a));
  assert.strictEqual(ra.code, 2, JSON.stringify(ra.json));
  assert.match(ra.json.reason, /integrity/);
  const b = org({ appOwn: { '.quality-kernel/critical-surface.json': JSON.stringify({ safeGlobs: ['src/**'] }) }, change: { 'src/auth/login.mjs': 'export const x = 1;' } });
  unlinkObj(b.ws, 'main:repos/app/critical-surface.json');
  const rb = run('route.mjs', b, WS(b));
  assert.strictEqual(rb.code, 2, JSON.stringify(rb.json));
  assert.match(rb.json.error, /integrity/);
});
