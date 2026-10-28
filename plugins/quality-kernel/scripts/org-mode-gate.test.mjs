import './hermetic-git.mjs';
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, symlinkSync, chmodSync, unlinkSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { orgPin } from './org.mjs';

// Org mode for the gate (explicit --org): a listed repo's verify contract and critical surface come
// from <org>/.quality-kernel/repos/<name>/ — outside every product repo — pinned by content, and win
// over the repo's own. Without --org nothing changes.
const here = dirname(fileURLToPath(import.meta.url));
const TOOLS = { verify: 'node --test guard.test.mjs', productionGlobs: ['src/**'] };
const WEAK_TOOLS = { verify: 'true', productionGlobs: ['src/**'] };
const SURFACE = { criticalGlobs: ['src/auth/**'], safeGlobs: ['docs/**'] };
const CODE_OK = 'export const f = () => 1;';
const CODE_BROKEN = 'export const f = () => 2;';
const TWEAK = { 'src/code.mjs': 'export const f = () => 1; // tweak' };
const GUARD = "import { test } from 'node:test'; import a from 'node:assert'; import { f } from './src/code.mjs'; test('g', () => a.strictEqual(f(), 1));";
const GUIDE = { org: 'Org', repos: [{ name: 'app', role: 'app', base: 'main' }], forbidden: [] };
const CFG = { 'app/tools.json': JSON.stringify(TOOLS), 'app/critical-surface.json': JSON.stringify(SURFACE) };

function write(dir, p, c) { const d = join(dir, p); mkdirSync(dirname(d), { recursive: true }); writeFileSync(d, c); }
function repo(dir, files) {
  mkdirSync(dir, { recursive: true });
  const git = (...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  for (const [p, c] of Object.entries(files)) write(dir, p, c);
  git('add', '-A'); git('commit', '-qm', 'init');
  return git;
}
// org(): <root>/app with base+head commits, plus (optionally) the org guide and config.
function org({ appOwn = {}, guide = GUIDE, cfg = CFG, change = TWEAK } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'qk-orgg-')));
  const app = join(root, 'app');
  const git = repo(app, { 'src/code.mjs': CODE_OK, 'guard.test.mjs': GUARD, 'docs/a.md': 'a', ...appOwn });
  const base = git('rev-parse', 'HEAD').stdout.trim();
  for (const [p, c] of Object.entries(change)) write(app, p, c);
  git('add', '-A'); git('commit', '-qm', 'change');
  const head = git('rev-parse', 'HEAD').stdout.trim();
  if (guide) write(root, '.claude/org-workspace/guide.json', JSON.stringify(guide));
  for (const [p, c] of Object.entries(cfg || {})) write(root, `.quality-kernel/repos/${p}`, c);
  return { root, app, git, base, head };
}
function run(script, o, extra = []) {
  const r = spawnSync('node', [join(here, script), '--repo', o.app, '--base', o.base, '--head', o.head, ...extra], { encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse((r.stdout || '').trim().split('\n').filter(Boolean).pop()); } catch { /* null */ }
  return { code: r.status, json };
}
const ORG = (o) => ['--org', o.root];
const src = (o) => ({ source: 'org', org: o.root, pin: orgPin(o.root) });

// --- the mode is explicit: single-repo behaviour is untouched without --org ---
test('no --org: the org config is NOT used, a repo without contract stays indeterminate', () => {
  const o = org({ change: { 'src/code.mjs': CODE_BROKEN } });
  const r = run('referee.mjs', o);
  assert.strictEqual(r.code, 2, JSON.stringify(r.json));
  assert.match(r.json.reason, /no \.quality-kernel\/tools\.json at base/);
  assert.match(run('route.mjs', o).json.reason, /no critical-surface config/);
});

// --- referee ---
test('referee: a covered break is caught with the org contract (FAIL, exit 1)', () => {
  const o = org({ change: { 'src/code.mjs': CODE_BROKEN } });
  assert.strictEqual(run('referee.mjs', o).code, 2, 'control: without --org it is indeterminate');
  assert.strictEqual(run('referee.mjs', o, ORG(o)).code, 1);
});

test('referee: a clean change passes and the evidence names the org config pin', () => {
  const o = org();
  const r = run('referee.mjs', o, ORG(o));
  assert.strictEqual(r.code, 0, JSON.stringify(r.json));
  assert.deepStrictEqual(r.json.evidence.toolsSource, src(o));
});

test("referee: in org mode the org contract wins over the repo's own weaker one", () => {
  const o = org({ appOwn: { '.quality-kernel/tools.json': JSON.stringify(WEAK_TOOLS) }, change: { 'src/code.mjs': CODE_BROKEN } });
  assert.strictEqual(run('referee.mjs', o).code, 0, "control: alone, the repo's weak contract passes the break");
  const r = run('referee.mjs', o, ORG(o));
  assert.strictEqual(r.code, 1, JSON.stringify(r.json));
  assert.strictEqual(r.json.evidence.toolsSource.source, 'org');
});

test("referee: the repo's own contract is used when the org has none for it", () => {
  const o = org({ appOwn: { '.quality-kernel/tools.json': JSON.stringify(TOOLS) }, cfg: null });
  const r = run('referee.mjs', o, ORG(o));
  assert.strictEqual(r.code, 0, JSON.stringify(r.json));
  assert.deepStrictEqual(r.json.evidence.toolsSource, { source: 'repo', ref: o.base });
});

test('referee: an org that cannot serve the repo fails closed with the reason', () => {
  const o = org({ appOwn: { '.quality-kernel/tools.json': JSON.stringify(TOOLS) }, guide: { org: 'O', repos: [], forbidden: [] } });
  const r = run('referee.mjs', o, ORG(o));
  assert.strictEqual(r.code, 2, JSON.stringify(r.json));
  assert.match(r.json.reason, /org mode: the org guide does not list "app"/);
});

test('referee: an unreadable org contract fails closed naming the org', () => {
  const o = org({ cfg: { ...CFG, 'app/tools.json': '{ nope' } });
  const r = run('referee.mjs', o, ORG(o));
  assert.strictEqual(r.code, 2, JSON.stringify(r.json));
  assert.match(r.json.reason, /unreadable tools\.json \(org/);
});

test('referee: a pin that no longer matches the org config is refused (indeterminate, nothing run)', () => {
  const o = org({ change: { 'src/code.mjs': CODE_BROKEN } });
  const r = run('referee.mjs', o, [...ORG(o), '--org-pin', 'f'.repeat(64)]);
  assert.strictEqual(r.code, 2, JSON.stringify(r.json));
  assert.match(r.json.reason, /changed since it was pinned/);
});

test('referee: a symlinked org tools.json fails closed (the break is never passed)', () => {
  const o = org({ change: { 'src/code.mjs': CODE_BROKEN } });
  const weak = join(o.root, 'weak.json'); writeFileSync(weak, JSON.stringify(WEAK_TOOLS));
  const p = join(o.root, '.quality-kernel/repos/app/tools.json'); unlinkSync(p); symlinkSync(weak, p);
  const r = run('referee.mjs', o, ORG(o));
  assert.strictEqual(r.code, 2, JSON.stringify(r.json));
  assert.match(r.json.reason, /symlink/);
});

test('referee: the ledger records where the contract came from', () => {
  const o = org();
  run('referee.mjs', o, ORG(o));
  const lines = readFileSync(join(o.app, '.quality-kernel', 'evidence-ledger.jsonl'), 'utf8').trim().split('\n');
  assert.deepStrictEqual(JSON.parse(lines.pop()).tools_source, src(o));
});

// --- route ---
test('route: the org surface classifies (safe docs change -> trivial) and reports its source', () => {
  const o = org({ change: { 'docs/a.md': 'b' } });
  const r = run('route.mjs', o, ORG(o));
  assert.strictEqual(r.code, 0, JSON.stringify(r.json));
  assert.strictEqual(r.json.tier, 'trivial');
  assert.deepStrictEqual(r.json.configSource, src(o));
});

test('route: the org surface marks critical paths', () => {
  const o = org({ change: { 'src/auth/login.mjs': 'export const x = 1;' } });
  const r = run('route.mjs', o, ORG(o));
  assert.strictEqual(r.json.tier, 'critical');
  assert.deepStrictEqual(r.json.criticalFiles, ['src/auth/login.mjs']);
});

test("route: in org mode the org surface wins over the repo's own permissive one", () => {
  const o = org({ appOwn: { '.quality-kernel/critical-surface.json': JSON.stringify({ safeGlobs: ['src/**'] }) }, change: { 'src/auth/login.mjs': 'export const x = 1;' } });
  assert.strictEqual(run('route.mjs', o).json.tier, 'trivial', "control: the repo's surface alone calls it trivial");
  assert.strictEqual(run('route.mjs', o, ORG(o)).json.tier, 'critical');
});

test("route: the repo's own surface is used when the org has none, and says so", () => {
  const o = org({ appOwn: { '.quality-kernel/critical-surface.json': JSON.stringify(SURFACE) }, cfg: { 'app/tools.json': JSON.stringify(TOOLS) }, change: { 'docs/a.md': 'b' } });
  const r = run('route.mjs', o, ORG(o));
  assert.strictEqual(r.json.tier, 'trivial', JSON.stringify(r.json));
  assert.deepStrictEqual(r.json.configSource, { source: 'repo', ref: o.base });
});

test('route: an org that cannot serve the repo fails closed', () => {
  const o = org({ guide: { org: 'O', repos: [{ name: 'app', role: 'app', base: 'main' }], forbidden: ['app'] } });
  const r = run('route.mjs', o, ORG(o));
  assert.strictEqual(r.code, 2, JSON.stringify(r.json));
  assert.match(r.json.error, /org mode: "app" is forbidden/);
});

test('route: unreadable and invalid org surfaces fail closed naming the org', () => {
  for (const bad of ['{ nope', '{"criticalGlobs":"src/**"}']) {
    const o = org({ cfg: { ...CFG, 'app/critical-surface.json': bad } });
    const r = run('route.mjs', o, ORG(o));
    assert.strictEqual(r.code, 2, JSON.stringify(r.json));
    assert.match(r.json.error, /(unreadable|invalid) critical-surface\.json at org/);
  }
});

// --- qk-gate: pins the org config once and hands the SAME pin to route and referee ---
test('qk-gate: clean change with org config -> exit 0; route and referee used the same pin', () => {
  const o = org();
  const r = run('qk-gate.mjs', o, ORG(o));
  assert.strictEqual(r.code, 0, JSON.stringify(r.json));
  assert.strictEqual(r.json.route.configSource.pin, orgPin(o.root));
  assert.strictEqual(r.json.referee.evidence.toolsSource.pin, orgPin(o.root));
  assert.deepStrictEqual(r.json.org, { dir: o.root, pin: orgPin(o.root) });
});

test('qk-gate: a caller-supplied --org-pin is ignored — the pin is computed by the gate itself', () => {
  const o = org();
  const r = run('qk-gate.mjs', o, [...ORG(o), '--org-pin', 'f'.repeat(64)]);
  assert.strictEqual(r.code, 0, JSON.stringify(r.json));
  assert.strictEqual(r.json.org.pin, orgPin(o.root));
});

test('qk-gate: an org config that cannot be pinned (a symlink in it) -> indeterminate before anything runs', () => {
  const o = org();
  const p = join(o.root, '.quality-kernel/repos/app/critical-surface.json');
  const elsewhere = join(o.root, 'x.json'); writeFileSync(elsewhere, '{}'); unlinkSync(p); symlinkSync(elsewhere, p);
  const r = run('qk-gate.mjs', o, ORG(o));
  assert.strictEqual(r.code, 2, JSON.stringify(r.json));
  assert.match(r.json.notes.join(' '), /cannot be pinned: .*symlink/);
});

test('--org with an empty value, or given last with no value, fails closed in route, referee and qk-gate (never single-repo)', () => {
  // the repo's own weak contract would pass the break if the flag were silently ignored
  const o = org({ appOwn: { '.quality-kernel/tools.json': JSON.stringify(WEAK_TOOLS) }, change: { 'src/code.mjs': CODE_BROKEN } });
  for (const tail of [['--org', ''], ['--org']]) {
    for (const s of ['referee.mjs', 'route.mjs', 'qk-gate.mjs']) {
      const r = spawnSync('node', [join(here, s), '--repo', o.app, '--base', o.base, '--head', o.head, ...tail], { encoding: 'utf8', cwd: o.app });
      assert.strictEqual(r.status, 2, `${s} ${tail.join(' ')}: ${r.stdout}`);
    }
  }
});

function mover(o, { broken = false } = {}) {
  write(o.app, 'src/code.mjs', `import { writeFileSync } from 'node:fs';\n`
    + `writeFileSync(${JSON.stringify(join(o.root, '.quality-kernel/repos/app/critical-surface.json'))}, JSON.stringify({ safeGlobs: ['src/**'] }));\n`
    + `export const f = () => ${broken ? 2 : 1};`);
  o.git('commit', '-qam', 'mover'); o.head = o.git('rev-parse', 'HEAD').stdout.trim();
}
test('qk-gate: code executed by the gate that rewrites the org config makes the run indeterminate', () => {
  const o = org();
  mover(o);
  const before = orgPin(o.root);
  const r = run('qk-gate.mjs', o, ORG(o));
  assert.notStrictEqual(orgPin(o.root), before, 'control: the executed code really rewrote the org config');
  assert.strictEqual(r.code, 2, JSON.stringify(r.json));
  assert.match(r.json.notes.join(' '), /the org config changed during the run/);
});

test('qk-gate: a real failure stays a failure (exit 1) even when the org config changed', () => {
  const o = org();
  mover(o, { broken: true });
  const r = run('qk-gate.mjs', o, ORG(o));
  assert.strictEqual(r.code, 1, JSON.stringify(r.json));
  assert.match(r.json.notes.join(' '), /changed during the run/);
});

test('route: invoked through a symlinked scripts dir it still runs (no silent exit 0)', () => {
  const link = join(realpathSync(mkdtempSync(join(tmpdir(), 'qk-link-'))), 'scripts');
  symlinkSync(here, link);
  const r = spawnSync('node', [join(link, 'route.mjs')], { encoding: 'utf8' });
  assert.strictEqual(r.status, 2, `stdout=${r.stdout}`);
  assert.match(r.stdout, /need --changed/);
});

// --- the repo's own (single-repo) config: forged blobs fail closed ---
function forge(dir, rev, content) {
  const oid = spawnSync('git', ['-C', dir, 'rev-parse', rev], { encoding: 'utf8' }).stdout.trim();
  const p = join(dir, '.git', 'objects', oid.slice(0, 2), oid.slice(2));
  chmodSync(p, 0o644);
  const body = Buffer.from(content);
  writeFileSync(p, deflateSync(Buffer.concat([Buffer.from(`blob ${body.length}\0`), body])));
}
test("referee and route: the repo's own config forged at base fails closed (no org)", () => {
  const a = org({ appOwn: { '.quality-kernel/tools.json': JSON.stringify(TOOLS) }, guide: null, cfg: null, change: { 'src/code.mjs': CODE_BROKEN } });
  forge(a.app, `${a.base}:.quality-kernel/tools.json`, JSON.stringify(WEAK_TOOLS));
  const ra = run('referee.mjs', a);
  assert.strictEqual(ra.code, 2, JSON.stringify(ra.json));
  assert.match(ra.json.reason, /does not hash to its id/);
  const b = org({ appOwn: { '.quality-kernel/critical-surface.json': JSON.stringify(SURFACE) }, guide: null, cfg: null, change: { 'src/auth/login.mjs': 'export const x = 1;' } });
  forge(b.app, `${b.base}:.quality-kernel/critical-surface.json`, JSON.stringify({ safeGlobs: ['src/**'] }));
  const rb = run('route.mjs', b);
  assert.strictEqual(rb.code, 2, JSON.stringify(rb.json));
  assert.match(rb.json.error, /does not hash to its id/);
});
