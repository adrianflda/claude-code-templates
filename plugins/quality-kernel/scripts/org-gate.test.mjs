import './hermetic-git.mjs';
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, symlinkSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregate, normalizeExit } from './qk-org-gate.mjs';

// qk-org-gate: one feature = the same branch name across the org guide's app repos. Every listed repo
// that has the branch is gated (qk-gate, base = merge-base with its declared base branch) and the
// verdicts are aggregated into one exit code. Anything it cannot verify is exit 2, never skipped.
const here = dirname(fileURLToPath(import.meta.url));
const orgGate = join(here, 'qk-org-gate.mjs');
const TOOLS = { verify: 'node --test guard.test.mjs', productionGlobs: ['src/**'] };
const SURFACE = { criticalGlobs: ['src/auth/**'], safeGlobs: ['docs/**'] };
const GUARD = "import { test } from 'node:test'; import a from 'node:assert'; import { f } from './src/code.mjs'; test('g', () => a.strictEqual(f(), 1));";
const BRANCH = 'feature/x';
const APP_FILES = { 'src/code.mjs': 'export const f = () => 1;', 'guard.test.mjs': GUARD, 'docs/a.md': 'a' };

const gitIn = (dir) => (...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
function write(dir, p, c) { const d = join(dir, p); mkdirSync(dirname(d), { recursive: true }); writeFileSync(d, c); }
function repo(dir, files, branch = 'main') {
  mkdirSync(dir, { recursive: true });
  const git = gitIn(dir);
  git('init', '-q', '-b', branch); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  for (const [p, c] of Object.entries(files)) write(dir, p, c);
  git('add', '-A'); git('commit', '-qm', 'init');
  return git;
}
// Commit `files` on a new branch, then return to the previous branch.
function onBranch(git, dir, files, branch = BRANCH) {
  git('switch', '-q', '-c', branch);
  for (const [p, c] of Object.entries(files)) write(dir, p, c);
  git('add', '-A'); git('commit', '-qm', 'feature');
  git('switch', '-q', '-');
}

const GOOD = { 'src/code.mjs': 'export const f = () => 1; // tweak' };
const BROKEN = { 'src/code.mjs': 'export const f = () => 2;' };
const CRITICAL = { 'src/auth/login.mjs': 'export const x = 1;' };

// org(apps): apps = { name: { base, change, harness, harnessBranch, contract, spec } }.
//   spec overrides the guide entry verbatim (e.g. null, or a bad base); extraRepos adds raw guide
//   entries without creating a directory. The org config is <root>/.claude/org-workspace/guide.json
//   (written by org-workspace) plus <root>/.quality-kernel/repos/<name>/{tools,critical-surface}.json.
export function writeOrgConfig(root, { repos, forbidden = [], files = {} }) {
  write(root, '.claude/org-workspace/guide.json', JSON.stringify({ org: 'Org', repos, forbidden }));
  for (const [p, c] of Object.entries(files)) write(root, `.quality-kernel/repos/${p}`, c);
}
function org(apps, { forbidden = [], extraRepos = [] } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'qk-org-')));
  const repos = [];
  const files = {};
  for (const [name, a] of Object.entries(apps)) {
    const base = a.base || 'main';
    const dir = join(root, name);
    const git = repo(dir, APP_FILES, base);
    if (a.change) onBranch(git, dir, a.change);
    repos.push('spec' in a ? (a.spec === null ? null : { name, ...a.spec }) : { name, role: 'app', base });
    if (a.contract !== false) {
      files[`${name}/tools.json`] = JSON.stringify(TOOLS);
      files[`${name}/critical-surface.json`] = JSON.stringify(SURFACE);
    }
    if (a.harness) {
      repos.push({ name: a.harness, role: 'harness', base: 'main', harnessOf: name });
      const hdir = join(root, a.harness);
      const hgit = repo(hdir, { 'e2e.spec.js': '// e2e' });
      if (a.harnessBranch) onBranch(hgit, hdir, { 'e2e.spec.js': '// e2e updated' });
    }
  }
  writeOrgConfig(root, { repos: [...repos, ...extraRepos], forbidden, files });
  return { root };
}
function run(o, args = ['--branch', BRANCH]) {
  const r = spawnSync('node', [orgGate, '--org', o.root, ...args], { encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse((r.stdout || '').trim().split('\n').filter(Boolean).pop()); } catch { /* null */ }
  return { code: r.status, json, stderr: r.stderr };
}
const byName = (json) => Object.fromEntries(json.repos.map((r) => [r.name, r]));

// --- aggregation (unit) ---
test('aggregate: 1 > 2 > 3 > 0, and nothing gated is 2', () => {
  const ran = (...exits) => exits.map((exit) => ({ status: 'ran', exit }));
  assert.strictEqual(aggregate(ran(0, 0)), 0);
  assert.strictEqual(aggregate(ran(0, 3)), 3);
  assert.strictEqual(aggregate(ran(3, 2)), 2);
  assert.strictEqual(aggregate(ran(2, 1, 3)), 1);
  assert.strictEqual(aggregate([{ status: 'skipped' }]), 2);
  assert.strictEqual(aggregate([]), 2);
  assert.strictEqual(aggregate([{ status: 'rejected', exit: 2 }, { status: 'ran', exit: 0 }]), 2);
});

test('normalizeExit: a crashed or out-of-range qk-gate is indeterminate', () => {
  for (const s of [0, 1, 2, 3]) assert.strictEqual(normalizeExit(s), s);
  for (const s of [null, undefined, 4, 127, -1, 255]) assert.strictEqual(normalizeExit(s), 2, String(s));
});

// --- end to end ---
test('every repo with the branch passes -> exit 0; repos without it are skipped', () => {
  const o = org({ a: { change: GOOD }, b: { change: GOOD }, c: {} });
  const r = run(o);
  assert.strictEqual(r.code, 0, JSON.stringify(r.json));
  const s = byName(r.json);
  assert.strictEqual(s.a.exit, 0); assert.strictEqual(s.b.exit, 0);
  assert.strictEqual(s.c.status, 'skipped');
});

test('one real failure fails the feature -> exit 1', () => {
  const r = run(org({ a: { change: GOOD }, b: { change: BROKEN } }));
  assert.strictEqual(r.code, 1, JSON.stringify(r.json));
  assert.strictEqual(byName(r.json).b.exit, 1);
});

test('a repo that cannot be verified -> exit 2', () => {
  const r = run(org({ a: { change: GOOD }, b: { change: GOOD, contract: false } }));
  assert.strictEqual(r.code, 2, JSON.stringify(r.json));
});

test('a real failure outranks an indeterminate repo -> exit 1', () => {
  assert.strictEqual(run(org({ a: { change: BROKEN }, b: { change: GOOD, contract: false } })).code, 1);
});

test('a critical change blocks with the breaker requirement -> exit 3', () => {
  const r = run(org({ a: { change: GOOD }, b: { change: CRITICAL } }));
  assert.strictEqual(r.code, 3, JSON.stringify(r.json));
  assert.strictEqual(r.json.gate, 'blocked-needs-breaker');
});

test('an indeterminate repo outranks a critical one -> exit 2', () => {
  assert.strictEqual(run(org({ a: { change: CRITICAL }, b: { change: GOOD, contract: false } })).code, 2);
});

test('no listed repo has the branch -> exit 2', () => {
  const r = run(org({ a: {}, b: {} }));
  assert.strictEqual(r.code, 2, JSON.stringify(r.json));
  assert.match(r.json.reason, /no listed repo has branch "feature\/x"/);
});

test('the org config is pinned once by content and every repo was gated against that pin', () => {
  const o = org({ a: { change: GOOD } });
  const r = run(o);
  assert.match(r.json.org.pin, /^[0-9a-f]{64}$/);
  assert.strictEqual(byName(r.json).a.configPin, r.json.org.pin);
});
test('the base is the merge-base with the declared base branch, not its tip', () => {
  const o = org({ a: { change: GOOD } });
  const git = gitIn(join(o.root, 'a'));
  const forkPoint = git('rev-parse', 'main').stdout.trim();
  write(join(o.root, 'a'), 'docs/b.md', 'later'); git('add', '-A'); git('commit', '-qm', 'main moved');
  const r = run(o);
  assert.strictEqual(r.code, 0, JSON.stringify(r.json));
  assert.strictEqual(byName(r.json).a.base, forkPoint);
});

test("each repo's declared base branch is used (dev vs main)", () => {
  const r = run(org({ a: { change: GOOD }, b: { base: 'dev', change: GOOD } }));
  assert.strictEqual(r.code, 0, JSON.stringify(r.json));
  assert.strictEqual(byName(r.json).b.baseBranch, 'dev');
});

test('origin/<base> is preferred over a stale local base branch', () => {
  const o = org({ a: { change: GOOD } });
  const aDir = join(o.root, 'a');
  const up = join(o.root, 'a-upstream');
  spawnSync('git', ['clone', '-q', '--bare', aDir, up]);
  const git = gitIn(aDir);
  git('remote', 'add', 'origin', up); git('fetch', '-q', 'origin');
  git('commit', '-q', '--allow-empty', '-m', 'local only');
  const r = run(o);
  assert.strictEqual(byName(r.json).a.baseRef, 'refs/remotes/origin/main', JSON.stringify(r.json));
});

test('a declared base branch that does not exist -> that repo is exit 2', () => {
  const r = run(org({ a: { change: GOOD, spec: { role: 'app', base: 'nope' } } }));
  assert.strictEqual(r.code, 2, JSON.stringify(r.json));
  assert.match(byName(r.json).a.reason, /base branch "nope" not found/);
});

test('a missing base is that repo\'s exit 2; an entry without a name makes the guide unusable (exit 2)', () => {
  const r = run(org({ a: { change: GOOD, spec: { role: 'app' } }, b: { change: GOOD } }));
  assert.strictEqual(r.code, 2, JSON.stringify(r.json));
  assert.match(byName(r.json).a.reason, /no base branch declared/);
  const r2 = run(org({ a: { change: GOOD }, b: { change: GOOD, spec: null } }));
  assert.strictEqual(r2.code, 2);
  assert.match(r2.json.reason, /no usable org guide/);
});
test('revision syntax in the manifest base is refused', () => {
  const r = run(org({ a: { change: GOOD, spec: { role: 'app', base: 'main~1' } } }));
  assert.strictEqual(r.code, 2, JSON.stringify(r.json));
  assert.match(byName(r.json).a.reason, /invalid base branch/);
});

test('--branch must be a branch name (no revision syntax, no options)', () => {
  const o = org({ a: { change: GOOD } });
  for (const bad of ['feature/x~1', 'main^', '--output=x', 'HEAD']) {
    const r = run(o, ['--branch', bad]);
    assert.strictEqual(r.code, 2, `${bad}: ${JSON.stringify(r.json)}`);
    assert.match(r.json.reason, /not a valid branch name/);
  }
});

test('a listed repo that is not cloned -> exit 2, not skipped', () => {
  const r = run(org({ a: { change: GOOD } }, { extraRepos: [{ name: 'ghost', role: 'app', base: 'main' }] }));
  assert.strictEqual(r.code, 2, JSON.stringify(r.json));
  assert.match(byName(r.json).ghost.reason, /not found/);
});

test('a listed dir that is not a git repo -> exit 2', () => {
  const o = org({ a: { change: GOOD } }, { extraRepos: [{ name: 'plain', role: 'app', base: 'main' }] });
  mkdirSync(join(o.root, 'plain'));
  const r = run(o);
  assert.strictEqual(r.code, 2, JSON.stringify(r.json));
  assert.match(byName(r.json).plain.reason, /no \.git directory of its own|not a git repository/);
});

test('an orphan feature branch (no merge-base) -> exit 2', () => {
  const o = org({ a: {} });
  const git = gitIn(join(o.root, 'a'));
  git('switch', '-q', '--orphan', BRANCH); write(join(o.root, 'a'), 'x.txt', 'x');
  git('add', '-A'); git('commit', '-qm', 'orphan'); git('switch', '-q', 'main');
  const r = run(o);
  assert.strictEqual(r.code, 2, JSON.stringify(r.json));
  assert.match(byName(r.json).a.reason, /no merge-base/);
});

test('forbidden, invalid-name and non-app entries are rejected and never run; harness entries are not gated', () => {
  const o = org({ a: { change: GOOD }, c: { change: BROKEN }, d: { change: BROKEN, spec: { role: 'library', base: 'main' } }, h: { change: BROKEN, spec: { role: 'harness', base: 'main' } } },
    { forbidden: ['c'], extraRepos: [{ name: '../x', role: 'app', base: 'main' }] });
  const r = run(o);
  assert.strictEqual(r.code, 2, JSON.stringify(r.json));
  const s = byName(r.json);
  for (const n of ['c', '../x', 'd']) { assert.strictEqual(s[n].status, 'rejected', n); assert.strictEqual(s[n].gate, undefined, n); }
  assert.strictEqual(s.h.status, 'skipped'); assert.strictEqual(s.h.gate, undefined);
  assert.strictEqual(s.a.exit, 0);
});

test('harness entries alone never make the feature indeterminate', () => {
  const r = run(org({ a: { change: GOOD, harness: 'a-qa', harnessBranch: true } }));
  assert.strictEqual(r.code, 0, JSON.stringify(r.json));
  assert.strictEqual(byName(r.json)['a-qa'].status, 'skipped');
});
test('a repo symlinked from outside the org folder is rejected', () => {
  const o = org({ a: { change: GOOD } }, { extraRepos: [{ name: 'link', role: 'app', base: 'main' }] });
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'qk-outside-')));
  const g = repo(join(outside, 'real'), APP_FILES);
  onBranch(g, join(outside, 'real'), GOOD);
  symlinkSync(join(outside, 'real'), join(o.root, 'link'));
  const r = run(o);
  assert.strictEqual(byName(r.json).link.status, 'rejected', JSON.stringify(r.json));
  assert.match(byName(r.json).link.reason, /is a symlink/);
});

test('repo names with spaces and parentheses work end to end', () => {
  const r = run(org({ 'x (Copy)': { change: GOOD } }));
  assert.strictEqual(r.code, 0, JSON.stringify(r.json));
});

test('an app gated without its harness on the same branch gets a note (non-blocking)', () => {
  const r = run(org({ a: { change: GOOD, harness: 'a-qa' }, b: { change: GOOD, harness: 'b-qa', harnessBranch: true } }));
  assert.strictEqual(r.code, 0, JSON.stringify(r.json));
  assert.ok(r.json.notes.some((n) => /a: harness "a-qa" has no branch "feature\/x"/.test(n)), r.json.notes.join('; '));
  assert.ok(!r.json.notes.some((n) => /^b: harness/.test(n)), r.json.notes.join('; '));
});

test('a forbidden harness is never checked, and says so', () => {
  const r = run(org({ a: { change: GOOD, harness: 'a-qa' } }, { forbidden: ['a-qa'] }));
  assert.ok(r.json.notes.some((n) => /a: harness "a-qa" is forbidden/.test(n)), r.json.notes.join('; '));
});

test('repos come from the org guide only: a repo dir the guide does not list is never gated', () => {
  const o = org({ a: { change: GOOD } });
  const z = join(o.root, 'z');
  onBranch(repo(z, APP_FILES), z, BROKEN);
  const r = run(o);
  assert.strictEqual(r.code, 0, JSON.stringify(r.json));
  assert.deepStrictEqual(r.json.repos.map((x) => x.name), ['a']);
});
test('missing --branch or an unusable org folder -> exit 2', () => {
  const o = org({ a: { change: GOOD } });
  assert.strictEqual(run(o, []).code, 2);
  const r = spawnSync('node', [orgGate, '--org', join(o.root, 'missing'), '--branch', BRANCH], { encoding: 'utf8' });
  assert.strictEqual(r.status, 2);
});

// --- round 3 ---
test('aggregate: a ran result with no exit code is indeterminate', () => {
  assert.strictEqual(aggregate([{ status: 'ran', exit: null }, { status: 'ran', exit: 0 }]), 2);
});

test('invoked through a symlinked scripts dir it still runs (no silent exit 0)', () => {
  const link = join(realpathSync(mkdtempSync(join(tmpdir(), 'qk-link-'))), 'scripts');
  symlinkSync(here, link);
  const r = spawnSync('node', [join(link, 'qk-org-gate.mjs'), '--org', '/nonexistent', '--branch', BRANCH], { encoding: 'utf8' });
  assert.strictEqual(r.status, 2, `stdout=${r.stdout}`);
});

test('a tag named like the feature branch cannot change the verified commit', () => {
  const o = org({ a: { change: BROKEN } });
  const git = gitIn(join(o.root, 'a'));
  git('tag', BRANCH, 'main'); // healthy commit under the branch's name
  const r = run(o);
  assert.strictEqual(r.code, 1, JSON.stringify(r.json));
});

test('every ref is resolved before any gate runs: a repo cannot drop another from the feature', () => {
  // a's production code deletes b's feature branch when a's tests import it; b is broken.
  const o = org({ a: { change: GOOD }, b: { change: BROKEN } });
  const aDir = join(o.root, 'a'); const bDir = join(o.root, 'b');
  const git = gitIn(aDir);
  git('switch', '-q', BRANCH);
  write(aDir, 'src/code.mjs', `import { execFileSync } from 'node:child_process';\n`
    + `try { execFileSync('git', ['-C', ${JSON.stringify(bDir)}, 'branch', '-D', ${JSON.stringify(BRANCH)}], { stdio: 'ignore' }); } catch {}\n`
    + `export const f = () => 1;`);
  git('commit', '-qam', 'attack'); git('switch', '-q', 'main');
  const r = run(o);
  assert.notStrictEqual(gitIn(bDir)('rev-parse', '-q', '--verify', `refs/heads/${BRANCH}`).status, 0, 'control: the attack deleted b\'s branch');
  assert.notStrictEqual(r.code, 0, JSON.stringify(r.json));
  const s = byName(r.json);
  assert.strictEqual(s.b.status, 'ran', JSON.stringify(s.b));
  assert.strictEqual(s.b.exit, 1);
  assert.ok(r.json.notes.some((n) => /b: .*moved during the run/.test(n)), r.json.notes.join('; '));
});

test('code executed by a gate that rewrites the org config makes the feature indeterminate', () => {
  const o = org({ a: { change: GOOD } });
  attack(o, 'a', `writeFileSync(${JSON.stringify(join(o.root, '.quality-kernel', 'repos', 'a', 'critical-surface.json'))}, JSON.stringify({ criticalGlobs: [], safeGlobs: ['docs/**', 'src/**'] }));`);
  const r = run(o);
  assert.strictEqual(r.code, 2, JSON.stringify(r.json));
  assert.match(r.json.notes.join(' '), /the org config changed during the run/);
});
test('--org with an empty or missing value -> exit 2', () => {
  const o = org({ a: { change: GOOD } });
  for (const args of [['--org', '', '--branch', BRANCH], ['--branch', BRANCH, '--org']]) {
    const r = spawnSync('node', [orgGate, ...args], { encoding: 'utf8', cwd: o.root });
    assert.strictEqual(r.status, 2, `${JSON.stringify(args)}: ${r.stdout}`);
  }
});

test('each repo reports the org config pin it was gated with, equal to the pinned one', () => {
  const o = org({ a: { change: GOOD }, b: { change: GOOD } });
  const r = run(o);
  for (const x of r.json.repos) assert.strictEqual(x.configPin, r.json.org.pin, x.name);
});
test('a feature branch that exists only on origin, or diverged from it, is exit 2 (not skipped)', () => {
  const o = org({ a: { change: GOOD }, b: { change: GOOD }, c: { change: GOOD } });
  for (const n of ['b', 'c']) {
    const dir = join(o.root, n); const up = join(o.root, `${n}-up`);
    spawnSync('git', ['clone', '-q', '--bare', dir, up]);
    const g = gitIn(dir); g('remote', 'add', 'origin', up); g('fetch', '-q', 'origin');
  }
  gitIn(join(o.root, 'b'))('branch', '-q', '-D', BRANCH); // b: only on origin
  const cg = gitIn(join(o.root, 'c')); cg('switch', '-q', BRANCH); cg('commit', '-q', '--allow-empty', '-m', 'local only'); cg('switch', '-q', 'main'); // c: diverged
  const r = run(o);
  assert.strictEqual(r.code, 2, JSON.stringify(r.json));
  const s = byName(r.json);
  assert.match(s.b.reason, /only on origin/);
  assert.match(s.c.reason, /differs from origin/);
});

test('an invalid harness name is noted and never looked up', () => {
  const r = run(org({ a: { change: GOOD } }, { extraRepos: [{ name: '../outside-qa', role: 'harness', base: 'main', harnessOf: 'a' }] }));
  assert.ok(r.json.notes.some((n) => /a: invalid harness name "..\/outside-qa"/.test(n)), r.json.notes.join('; '));
});
test('an --org folder without an org guide -> exit 2 naming the missing guide', () => {
  const o = org({ a: { change: GOOD } });
  const r = spawnSync('node', [orgGate, '--org', join(o.root, 'a'), '--branch', BRANCH], { encoding: 'utf8' });
  assert.strictEqual(r.status, 2, r.stdout);
  assert.match(r.stdout, /no usable org guide/);
});
test('a manifest whose "forbidden" is not an array -> exit 2', () => {
  const r = run(org({ a: { change: GOOD } }, { forbidden: { a: 1 } }));
  assert.strictEqual(r.code, 2, JSON.stringify(r.json));
});

// --- round 4 ---
// Replace a repo's feature-branch production code with `body` (run when its tests import it).
function attack(o, name, body, { broken = false } = {}) {
  const dir = join(o.root, name);
  const git = gitIn(dir);
  git('switch', '-q', BRANCH);
  write(dir, 'src/code.mjs', `import { execFileSync } from 'node:child_process';\nimport { writeFileSync, chmodSync } from 'node:fs';\nimport { deflateSync } from 'node:zlib';\n`
    + `try { ${body} } catch {}\nexport const f = () => ${broken ? 2 : 1};`);
  git('commit', '-qam', 'attack'); git('switch', '-q', 'main');
}
const sh = (dir, ...a) => `execFileSync('git', ['-C', ${JSON.stringify(dir)}, ${a.map((x) => JSON.stringify(x)).join(', ')}], { stdio: 'ignore' });`;

test("a weakened config for the next repo, written during the run, is never trusted (never exit 0)", () => {
  const o = org({ a: { change: GOOD }, b: { change: BROKEN } });
  attack(o, 'a', `writeFileSync(${JSON.stringify(join(o.root, '.quality-kernel', 'repos', 'b', 'tools.json'))}, JSON.stringify({ verify: 'true', productionGlobs: ['src/**'] }));`);
  const r = run(o);
  assert.notStrictEqual(r.code, 0, JSON.stringify(r.json));
  const b = byName(r.json).b;
  assert.notStrictEqual(b.exit, 0, JSON.stringify(b));
  assert.match(String(b.offPin || ''), /not the pinned/);
  assert.match(r.json.notes.join(' '), /the org config changed during the run/);
});
test('a config symlinked away during the run is refused, never followed', () => {
  const o = org({ a: { change: GOOD }, b: { change: BROKEN } });
  const weak = join(o.root, 'weak-tools.json');
  writeFileSync(weak, JSON.stringify({ verify: 'true', productionGlobs: ['src/**'] }));
  const target = join(o.root, '.quality-kernel', 'repos', 'b', 'tools.json');
  attack(o, 'a', `const { unlinkSync, symlinkSync } = await import('node:fs'); unlinkSync(${JSON.stringify(target)}); symlinkSync(${JSON.stringify(weak)}, ${JSON.stringify(target)});`);
  const r = run(o);
  assert.notStrictEqual(byName(r.json).b.exit, 0, JSON.stringify(r.json));
  assert.notStrictEqual(r.code, 0);
});
test('a moved ref on a GREEN repo makes it indeterminate (exit 2), never a pass', () => {
  const o = org({ a: { change: GOOD }, b: { change: GOOD } });
  attack(o, 'a', sh(join(o.root, 'b'), 'branch', '-D', BRANCH));
  const r = run(o);
  assert.strictEqual(r.code, 2, JSON.stringify(r.json));
  assert.strictEqual(byName(r.json).b.exit, 2);
});

test('origin/<branch> moved during the run -> exit 2', () => {
  const o = org({ a: { change: GOOD }, b: { change: GOOD } });
  const bDir = join(o.root, 'b'); const up = join(o.root, 'b-up');
  spawnSync('git', ['clone', '-q', '--bare', bDir, up]);
  gitIn(bDir)('remote', 'add', 'origin', up); gitIn(bDir)('fetch', '-q', 'origin');
  const other = gitIn(bDir)('rev-parse', 'main').stdout.trim();
  attack(o, 'a', sh(bDir, 'update-ref', `refs/remotes/origin/${BRANCH}`, other));
  const r = run(o);
  assert.strictEqual(r.code, 2, JSON.stringify(r.json));
  assert.ok(byName(r.json).b.refsMoved.includes(`refs/remotes/origin/${BRANCH}`), JSON.stringify(byName(r.json).b));
});

test("the base branch moved during the run -> exit 2", () => {
  const o = org({ a: { change: GOOD }, b: { change: GOOD } });
  attack(o, 'a', sh(join(o.root, 'b'), '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'base moved'));
  const r = run(o);
  assert.strictEqual(r.code, 2, JSON.stringify(r.json));
  assert.ok(byName(r.json).b.refsMoved.includes('refs/heads/main'), JSON.stringify(byName(r.json).b));
});

test('a moved ref on a critical (exit 3) repo makes it 2, not 3', () => {
  const o = org({ a: { change: GOOD }, b: { change: CRITICAL } });
  attack(o, 'a', sh(join(o.root, 'b'), 'branch', '-D', BRANCH));
  const r = run(o);
  assert.strictEqual(byName(r.json).b.exit, 2, JSON.stringify(r.json));
  assert.strictEqual(r.code, 2);
});

test('a real failure stays exit 1 when the org config changes during the run', () => {
  const o = org({ a: { change: GOOD } });
  attack(o, 'a', `writeFileSync(${JSON.stringify(join(o.root, '.quality-kernel', 'repos', 'a', 'extra.json'))}, '{}');`, { broken: true });
  const r = run(o);
  assert.strictEqual(r.code, 1, JSON.stringify(r.json));
  assert.match(r.json.notes.join(' '), /the org config changed during the run/);
});
test('a manifest whose "forbidden" holds non-string entries -> exit 2', () => {
  assert.strictEqual(run(org({ a: { change: GOOD } }, { forbidden: [['a']] })).code, 2);
});

test("per-file fallback in an org run: repo-own tools.json + org surface only -> gated normally (exit 0)", () => {
  const o = org({ a: { change: GOOD, contract: false } });
  const aDir = join(o.root, 'a'); const g = gitIn(aDir);
  write(aDir, '.quality-kernel/tools.json', JSON.stringify(TOOLS)); g('add', '-A'); g('commit', '-qm', 'own tools');
  g('switch', '-q', BRANCH); g('merge', '-q', '--no-edit', 'main'); g('switch', '-q', 'main');
  write(o.root, '.quality-kernel/repos/a/critical-surface.json', JSON.stringify(SURFACE));
  const r = run(o);
  assert.strictEqual(r.code, 0, JSON.stringify(r.json));
  assert.strictEqual(byName(r.json).a.offPin, undefined);
});

test('offPin: an org-sourced verdict not taken at the pinned config is never trusted (0->2, 3->2, 1 stays 1)', () => {
  // Copy the scripts and replace qk-gate with a stub that reports a foreign org pin.
  const o = org({ a: { change: GOOD } });
  for (const stubExit of [0, 3, 1]) {
    const dir = join(realpathSync(mkdtempSync(join(tmpdir(), 'qk-stub-'))), 'scripts');
    cpSync(here, dir, { recursive: true });
    writeFileSync(join(dir, 'qk-gate.mjs'), `process.stdout.write(JSON.stringify({ gate: 'x', referee: { reason: 'stub', evidence: { toolsSource: { source: 'org', org: 'x', pin: 'f'.repeat(64) } } } }) + '\\n'); process.exit(${stubExit});\n`);
    const r = spawnSync('node', [join(dir, 'qk-org-gate.mjs'), '--org', o.root, '--branch', BRANCH], { encoding: 'utf8' });
    const json = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.strictEqual(r.status, stubExit === 1 ? 1 : 2, `stub ${stubExit}: ${r.stdout}`);
    assert.match(byName(json).a.offPin, /not the pinned/);
  }
});
