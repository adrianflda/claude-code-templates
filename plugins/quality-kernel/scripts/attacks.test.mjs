// Red-team regressions (Constitution P11: "red-team the gate itself"). Each test is an attack the
// independent panel used to FOOL an earlier gate (validation-panel.{v1,v2}.md). The current gate
// must keep every one defeated forever: a broken change must yield exit 1 (fail) or 2 (indeterminate,
// fail-closed), never 0. Provenance noted per test (gate-breaker A/N/Q-numbers).
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const referee = join(here, 'referee.mjs');
const gate = join(here, 'qk-gate.mjs');

// Build a git repo: baseFiles -> commit (base); change (string write / null=delete / {symlink}) ->
// commit (head). `tools` is the committed .quality-kernel/tools.json.
function mk(tools, baseFiles, change) {
  const tmp = mkdtempSync(join(tmpdir(), 'qk-attack-'));
  const git = (...a) => spawnSync('git', ['-C', tmp, ...a], { encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  const write = (p, c) => { const d = join(tmp, p); mkdirSync(dirname(d), { recursive: true }); writeFileSync(d, c); };
  write('.quality-kernel/tools.json', JSON.stringify(tools));
  write('.quality-kernel/critical-surface.json', JSON.stringify({ criticalGlobs: ['**/auth/**'], safeGlobs: ['**/*.md'] }));
  for (const [p, c] of Object.entries(baseFiles)) write(p, c);
  git('add', '-A'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD').stdout.trim();
  for (const [p, c] of Object.entries(change)) {
    if (c === null) rmSync(join(tmp, p), { force: true });
    else if (typeof c === 'object' && c.symlink) { const d = join(tmp, p); mkdirSync(dirname(d), { recursive: true }); spawnSync('ln', ['-s', c.symlink, d]); }
    else write(p, c);
  }
  git('add', '-A'); git('commit', '-qm', 'change');
  return { tmp, base, head: git('rev-parse', 'HEAD').stdout.trim() };
}
const run = (tmp, base, head) => spawnSync('node', [referee, '--repo', tmp, '--base', base, ...(head ? ['--head', head] : [])], { encoding: 'utf8' });
const runGate = (tmp, base, head) => spawnSync('node', [gate, '--repo', tmp, '--base', base, '--head', head], { encoding: 'utf8' });
const json = (r) => JSON.parse((r.stdout || '').trim().split('\n').filter(Boolean).pop());

const OK = 'export const f = () => 1;';
const BROKEN = 'export const f = () => 999;';
const GUARD = "import { test } from 'node:test'; import a from 'node:assert'; import { f } from '../src/code.mjs'; test('g', () => a.strictEqual(f(), 1));";
const NEUTER = "import { test } from 'node:test'; import a from 'node:assert'; test('g', () => a.ok(true));";
const TOOLS = { verify: 'node --test', productionGlobs: ['src/**'] };
const BASE = { 'src/code.mjs': OK, 'tests/guard.test.mjs': GUARD };

test('sanity — a genuine green production change passes (exit 0)', () => {
  const { tmp, base, head } = mk(TOOLS, BASE, { 'src/code.mjs': 'export const f = () => 1; export const g = () => 2;' });
  try { const r = run(tmp, base, head); assert.strictEqual(r.status, 0); assert.strictEqual(json(r).pass, true); }
  finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('ATTACK 1 — touching the gate config (.quality-kernel/**) in the change is indeterminate, never a pass', () => {
  const { tmp, base, head } = mk(TOOLS, BASE, { 'src/code.mjs': BROKEN, '.quality-kernel/tools.json': JSON.stringify({ verify: 'true', productionGlobs: ['src/**'] }) });
  try { const r = run(tmp, base, head); assert.strictEqual(r.status, 2); assert.match(json(r).reason, /productionGlobs/); } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('ATTACK B (Option B) — neutering the test IN PLACE is a test change -> routed critical (exit 3, human review), never a silent pass', () => {
  // The referee overlays the modified test so a legit update can verify; the DEFENSE is that a test
  // edit is forced to human review (exit 3), where the neutered diff is visible. A silent exit-0 is
  // the failure we forbid.
  const { tmp, base, head } = mk(TOOLS, BASE, { 'src/code.mjs': BROKEN, 'tests/guard.test.mjs': NEUTER });
  try { const r = runGate(tmp, base, head); assert.strictEqual(r.status, 3); assert.strictEqual(json(r).gate, 'blocked-needs-breaker'); assert.match(json(r).route.reason, /test file\(s\) modified/); }
  finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('ATTACK A1 (helper neuter under tests/) — a test-support change is routed critical (exit 3), never a silent pass', () => {
  const guard = "import { test } from 'node:test'; import a from 'node:assert'; import { check } from './helper.mjs'; test('g', () => a.ok(check()));";
  const { tmp, base, head } = mk(TOOLS,
    { 'src/code.mjs': OK, 'tests/guard.test.mjs': guard, 'tests/helper.mjs': "import { f } from '../src/code.mjs'; export const check = () => f() === 1;" },
    { 'src/code.mjs': BROKEN, 'tests/helper.mjs': 'export const check = () => true;' });
  try { assert.strictEqual(runGate(tmp, base, head).status, 3); } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('ATTACK A4 (runner neuter under tests/) — routed critical (exit 3), never a silent pass', () => {
  const { tmp, base, head } = mk({ verify: 'node tests/run.mjs', productionGlobs: ['src/**'] },
    { 'src/code.mjs': OK, 'tests/run.mjs': "import { f } from '../src/code.mjs'; if (f() !== 1) process.exit(1);" },
    { 'src/code.mjs': BROKEN, 'tests/run.mjs': 'process.exit(0);' });
  try { assert.strictEqual(runGate(tmp, base, head).status, 3); } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('ATTACK A3 (golden re-goldening under tests/) — routed critical (exit 3), never a silent pass', () => {
  const guard = "import { test } from 'node:test'; import a from 'node:assert'; import { f } from '../src/code.mjs'; import fs from 'node:fs'; test('g', () => a.strictEqual(String(f()), JSON.parse(fs.readFileSync(new URL('./expected.json', import.meta.url))).v));";
  const { tmp, base, head } = mk(TOOLS,
    { 'src/code.mjs': OK, 'tests/guard.test.mjs': guard, 'tests/expected.json': JSON.stringify({ v: '1' }) },
    { 'src/code.mjs': BROKEN, 'tests/expected.json': JSON.stringify({ v: '999' }) });
  try { assert.strictEqual(runGate(tmp, base, head).status, 3); } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('SANITY (Option B) — breaking covered code WITHOUT touching its test is still mechanically blocked (exit 1)', () => {
  const { tmp, base, head } = mk(TOOLS, BASE, { 'src/code.mjs': BROKEN });
  try { assert.strictEqual(run(tmp, base, head).status, 1); } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('USABILITY (Option B) — a legit behavior change with its test updated verifies green, then routes to review (exit 3)', () => {
  const g2 = "import { test } from 'node:test'; import a from 'node:assert'; import { f } from '../src/code.mjs'; test('g', () => a.strictEqual(f(), 2));";
  const { tmp, base, head } = mk(TOOLS, BASE, { 'src/code.mjs': 'export const f = () => 2;', 'tests/guard.test.mjs': g2 });
  try { const r = runGate(tmp, base, head); assert.strictEqual(r.status, 3); assert.strictEqual(json(r).refereePass, true); }
  finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('ATTACK #2 (symlink) — a committed symlink in head is indeterminate (exit 2)', () => {
  const { tmp, base, head } = mk(TOOLS, BASE, { 'src/code.mjs': BROKEN, 'src/evil.mjs': { symlink: '/etc/hosts' } });
  try { const r = run(tmp, base, head); assert.strictEqual(r.status, 2); assert.strictEqual(json(r).indeterminate, true); }
  finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('ATTACK #8 (base has no contract) — indeterminate, never a worktree fallback', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'qk-attack-'));
  const git = (...a) => spawnSync('git', ['-C', tmp, ...a], { encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  mkdirSync(join(tmp, 'src'), { recursive: true });
  writeFileSync(join(tmp, 'src', 'code.mjs'), OK); writeFileSync(join(tmp, 'README.md'), 'x');
  git('add', '-A'); git('commit', '-qm', 'base'); const base = git('rev-parse', 'HEAD').stdout.trim();
  writeFileSync(join(tmp, 'src', 'code.mjs'), BROKEN);
  git('add', '-A'); git('commit', '-qm', 'change'); const head = git('rev-parse', 'HEAD').stdout.trim();
  mkdirSync(join(tmp, '.quality-kernel'), { recursive: true });
  writeFileSync(join(tmp, '.quality-kernel', 'tools.json'), JSON.stringify({ verify: 'true', productionGlobs: ['src/**'] })); // untracked
  try { assert.strictEqual(run(tmp, base, head).status, 2); } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('ATTACK #8b — missing productionGlobs at base is indeterminate', () => {
  const { tmp, base, head } = mk({ verify: 'node --test tests/guard.test.mjs' }, BASE, { 'src/code.mjs': BROKEN });
  try { assert.strictEqual(run(tmp, base, head).status, 2); } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('ATTACK #6 (worktree divergence) — verifies the committed head; a worktree revert cannot hide it', () => {
  const { tmp, base, head } = mk(TOOLS, BASE, { 'src/code.mjs': BROKEN });
  try {
    spawnSync('git', ['-C', tmp, 'checkout', base, '--', 'src/code.mjs'], { encoding: 'utf8' });
    assert.strictEqual(run(tmp, base, head).status, 1);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('ATTACK — no --base fails closed (indeterminate)', () => {
  const { tmp } = mk(TOOLS, BASE, { 'src/code.mjs': BROKEN });
  try { assert.strictEqual(spawnSync('node', [referee, '--repo', tmp], { encoding: 'utf8' }).status, 2); }
  finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('ATTACK A/Q4b (undeclared change) — a broken file OUTSIDE productionGlobs is indeterminate, not a pass', () => {
  // bin/cli.mjs is real runtime code the operator forgot to declare; the gate must refuse, not guess.
  const { tmp, base, head } = mk(TOOLS, { ...BASE, 'bin/cli.mjs': 'export const cli = () => 1;' }, { 'bin/cli.mjs': 'export const cli = () => 2;' });
  try { const r = run(tmp, base, head); assert.strictEqual(r.status, 2); assert.match(json(r).reason, /not covered by productionGlobs/); }
  finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('ATTACK A/Q10b (production named like harness) — a prod path matching a test pattern is indeterminate', () => {
  const { tmp, base, head } = mk(TOOLS, { ...BASE, 'src/ab_test.mjs': OK }, { 'src/ab_test.mjs': BROKEN });
  try { const r = run(tmp, base, head); assert.strictEqual(r.status, 2); assert.match(json(r).reason, /ambiguous/); }
  finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('HEAD-AS-IS (N5b) — a new production file whose new test fails is caught (exit 1)', () => {
  const feat = "import { test } from 'node:test'; import a from 'node:assert'; import { feat } from '../src/feat.mjs'; test('feat', () => a.strictEqual(feat(), 1));";
  const { tmp, base, head } = mk(TOOLS, BASE, { 'src/feat.mjs': 'export const feat = () => 999;', 'tests/feat.test.mjs': feat });
  try { const r = run(tmp, base, head); assert.strictEqual(r.status, 1); assert.strictEqual(json(r).evidence.headExit, 1); }
  finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('ATTACK B/Q11-12 (harness mutation) — a verify/setup step that rewrites its own test is indeterminate', () => {
  const rootGuard = "import { test } from 'node:test'; import a from 'node:assert'; import { f } from './src/code.mjs'; test('g', () => a.strictEqual(f(), 1));";
  const { tmp, base, head } = mk(
    { verify: 'node --test guard.test.mjs', productionGlobs: ['src/**'], verifySetup: 'node src/build.mjs' },
    { 'src/code.mjs': OK, 'guard.test.mjs': rootGuard, 'src/build.mjs': '// no-op build' },
    { 'src/code.mjs': BROKEN, 'src/build.mjs': "import fs from 'node:fs'; fs.writeFileSync('guard.test.mjs', \"import {test} from 'node:test'; test('x',()=>{});\");" });
  try { const r = run(tmp, base, head); assert.strictEqual(r.status, 2); assert.match(json(r).reason, /mutated an immutable harness/); }
  finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('ATTACK N7/Q7 (export-ignore) — stripping ANY committed file from the archive is indeterminate', () => {
  const { tmp, base, head } = mk(TOOLS,
    { 'src/code.mjs': OK, 'tests/guard.test.mjs': GUARD, '.gitattributes': 'tests/ export-ignore\n' },
    { 'src/code.mjs': BROKEN });
  try { assert.strictEqual(run(tmp, base, head).status, 2); } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('ATTACK X1 (deletion) — removing runtime code OUTSIDE productionGlobs is indeterminate', () => {
  const { tmp, base, head } = mk(TOOLS, { ...BASE, 'bin/cli.mjs': 'export const cli = () => 1;' }, { 'bin/cli.mjs': null });
  try { const r = run(tmp, base, head); assert.strictEqual(r.status, 2); assert.match(json(r).reason, /removed but is not covered/); }
  finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('ATTACK X2 (rename-to-prod) — the renamed-away old path must be covered too', () => {
  const { tmp, base, head } = mk(TOOLS, { ...BASE, 'bin/cli.mjs': 'export const cli = () => 1;' },
    { 'bin/cli.mjs': null, 'src/cli.mjs': 'export const cli = () => 999;' });
  try { assert.strictEqual(run(tmp, base, head).status, 2); } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('ATTACK X3 (safeGlobs-is-code) — an executable path is never "inert" (own strict inert list)', () => {
  const { tmp, base, head } = mk(TOOLS, { ...BASE, 'scripts/dev/util.mjs': 'export const u = () => 1;' }, { 'scripts/dev/util.mjs': 'export const u = () => 999;' });
  try { const r = run(tmp, base, head); assert.strictEqual(r.status, 2); assert.match(json(r).reason, /not covered by productionGlobs/); }
  finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('ATTACK X4 (write-then-restore) — a setup step that rewrites a harness file with identical bytes is caught by ctime', () => {
  const rootGuard = "import { test } from 'node:test'; import a from 'node:assert'; import { f } from './src/code.mjs'; test('g', () => a.strictEqual(f(), 1));";
  const touch = "import fs from 'node:fs'; const p='guard.test.mjs'; fs.writeFileSync(p, fs.readFileSync(p));"; // same bytes, new ctime
  const { tmp, base, head } = mk({ verify: 'node --test guard.test.mjs', productionGlobs: ['src/**'], verifySetup: 'node src/touch.mjs' },
    { 'src/code.mjs': OK, 'guard.test.mjs': rootGuard, 'src/touch.mjs': '// no-op' },
    { 'src/code.mjs': BROKEN, 'src/touch.mjs': touch });
  try { const r = run(tmp, base, head); assert.strictEqual(r.status, 2); assert.match(json(r).reason, /mutated an immutable harness/); }
  finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('ATTACK X5 (new file) — a setup step that creates a file in the tree is indeterminate', () => {
  const prep = "import fs from 'node:fs'; fs.writeFileSync('.npmrc', 'script-shell=./sh');";
  const { tmp, base, head } = mk({ verify: 'node --test tests/guard.test.mjs', productionGlobs: ['src/**'], verifySetup: 'node src/prep.mjs' },
    { 'src/code.mjs': OK, 'tests/guard.test.mjs': GUARD, 'src/prep.mjs': '// no-op' },
    { 'src/code.mjs': BROKEN, 'src/prep.mjs': prep });
  try { const r = run(tmp, base, head); assert.strictEqual(r.status, 2); assert.match(json(r).reason, /created a file in the verification tree/); }
  finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('ATTACK Y2 (build plants a module the test imports) — a file created in build/ during verify is caught', () => {
  const guard = "import { test } from 'node:test'; import a from 'node:assert'; import { check } from '../build/check.mjs'; test('g', () => a.ok(check()));";
  const good = "import fs from 'node:fs'; fs.mkdirSync('build',{recursive:true}); fs.writeFileSync('build/check.mjs', 'import { f } from \"../src/code.mjs\"; export const check = () => f() === 1;');";
  const bad = "import fs from 'node:fs'; fs.mkdirSync('build',{recursive:true}); fs.writeFileSync('build/check.mjs', 'export const check = () => true;');";
  const { tmp, base, head } = mk(
    { verify: 'node scripts/build.mjs && node --test tests/guard.test.mjs', productionGlobs: ['src/**', 'scripts/**'] },
    { 'src/code.mjs': OK, 'tests/guard.test.mjs': guard, 'scripts/build.mjs': good },
    { 'src/code.mjs': BROKEN, 'scripts/build.mjs': bad });
  try { const r = run(tmp, base, head); assert.strictEqual(r.status, 2); assert.match(json(r).reason, /created a file in the verification tree/); }
  finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('CONTROL — a declared build output (outputGlobs) is allowed; an honest build passes (exit 0)', () => {
  const guard = "import { test } from 'node:test'; import a from 'node:assert'; import { check } from '../build/check.mjs'; test('g', () => a.ok(check()));";
  const build = "import fs from 'node:fs'; fs.mkdirSync('build',{recursive:true}); fs.writeFileSync('build/check.mjs', 'import { f } from \"../src/code.mjs\"; export const check = () => f() === 1;');";
  const { tmp, base, head } = mk(
    { verify: 'node scripts/build.mjs && node --test tests/guard.test.mjs', productionGlobs: ['src/**', 'scripts/**'], outputGlobs: ['build/**'] },
    { 'src/code.mjs': OK, 'tests/guard.test.mjs': guard, 'scripts/build.mjs': build },
    { 'src/code.mjs': 'export const f = () => 1; export const g = () => 2;' });
  try { assert.strictEqual(run(tmp, base, head).status, 0); } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('ATTACK Z5 (symlink smuggling) — a symlink created during the run is caught (exit 2)', () => {
  const guard = "import { test } from 'node:test'; import a from 'node:assert'; import { check } from '../build/check.mjs'; test('g', () => a.ok(check()));";
  const bad = "import fs from 'node:fs'; fs.mkdirSync('node_modules/.x',{recursive:true}); fs.writeFileSync('node_modules/.x/check.mjs','export const check=()=>true;'); fs.mkdirSync('build',{recursive:true}); fs.symlinkSync('../node_modules/.x/check.mjs','build/check.mjs');";
  const good = "import fs from 'node:fs'; fs.mkdirSync('build',{recursive:true}); fs.writeFileSync('build/check.mjs','import { f } from \"../src/code.mjs\"; export const check=()=>f()===1;');";
  const { tmp, base, head } = mk(
    { verify: 'node scripts/build.mjs && node --test tests/guard.test.mjs', productionGlobs: ['src/**', 'scripts/**'] },
    { 'src/code.mjs': OK, 'tests/guard.test.mjs': guard, 'scripts/build.mjs': good },
    { 'src/code.mjs': BROKEN, 'scripts/build.mjs': bad });
  try { const r = run(tmp, base, head); assert.strictEqual(r.status, 2); assert.match(json(r).reason, /symlink/); }
  finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('ATTACK Z9 (degenerate outputGlobs) — outputGlobs "**" is rejected (would disable the created-file check)', () => {
  const { tmp, base, head } = mk({ verify: 'node --test tests/guard.test.mjs', productionGlobs: ['src/**'], outputGlobs: ['**'] }, BASE, { 'src/code.mjs': BROKEN });
  try { const r = run(tmp, base, head); assert.strictEqual(r.status, 2); assert.match(json(r).reason, /outputGlobs entry/); }
  finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('ATTACK W3 (runtime asset) — a changed .txt/asset outside productionGlobs is not "inert" -> indeterminate', () => {
  const { tmp, base, head } = mk(TOOLS, { ...BASE, 'templates/greeting.txt': 'hello' }, { 'templates/greeting.txt': 'BROKEN' });
  try { const r = run(tmp, base, head); assert.strictEqual(r.status, 2); assert.match(json(r).reason, /not covered by productionGlobs/); }
  finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('ATTACK W4 (runtime config) — a changed app.config.json is not "harness" -> indeterminate', () => {
  const { tmp, base, head } = mk(TOOLS, { ...BASE, 'config/app.config.json': '{"limit":1}' }, { 'config/app.config.json': '{"limit":999}' });
  try { const r = run(tmp, base, head); assert.strictEqual(r.status, 2); assert.match(json(r).reason, /not covered by productionGlobs/); }
  finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('CONTROL W4 — declaring config/** in productionGlobs makes it verifiable: a broken config with a neutered test still fails', () => {
  const guard = "import { test } from 'node:test'; import a from 'node:assert'; import { limit } from '../src/code.mjs'; test('g', () => a.strictEqual(limit(), 1));";
  const code = "import fs from 'node:fs'; export const limit = () => JSON.parse(fs.readFileSync(new URL('../config/app.config.json', import.meta.url))).limit;";
  const { tmp, base, head } = mk({ verify: 'node --test tests/guard.test.mjs', productionGlobs: ['src/**', 'config/**'] },
    { 'src/code.mjs': code, 'tests/guard.test.mjs': guard, 'config/app.config.json': '{"limit":1}' },
    { 'config/app.config.json': '{"limit":999}' });
  try { assert.strictEqual(run(tmp, base, head).status, 1, 'overlaid config (999) fails the immutable base test'); }
  finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('ATTACK W5 (package.json manifest) — changing a production field (exports) is indeterminate', () => {
  const { tmp, base, head } = mk(TOOLS,
    { ...BASE, 'package.json': JSON.stringify({ name: 'p', exports: { '.': './src/code.mjs' } }) },
    { 'package.json': JSON.stringify({ name: 'p', exports: { '.': './src/evil.mjs' } }) });
  try { const r = run(tmp, base, head); assert.strictEqual(r.status, 2); assert.match(json(r).reason, /runtime resolution|manifest/); }
  finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('ATTACK W6 (case collision) — paths differing only in case are indeterminate (platform-independent)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'qk-attack-'));
  const git = (...a) => spawnSync('git', ['-C', tmp, ...a], { encoding: 'utf8' });
  const gitIn = (input, ...a) => spawnSync('git', ['-C', tmp, ...a], { encoding: 'utf8', input });
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't'); git('config', 'core.ignorecase', 'false');
  const write = (p, c) => { const d = join(tmp, p); mkdirSync(dirname(d), { recursive: true }); writeFileSync(d, c); };
  write('.quality-kernel/tools.json', JSON.stringify(TOOLS));
  write('src/code.mjs', OK); write('tests/guard.test.mjs', GUARD);
  git('add', '-A'); git('commit', '-qm', 'base'); const base = git('rev-parse', 'HEAD').stdout.trim();
  const oid = gitIn('export const f = () => 999;', 'hash-object', '-w', '--stdin').stdout.trim();
  git('update-index', '--add', '--cacheinfo', `100644,${oid},src/Code.mjs`);
  const tree = git('write-tree').stdout.trim();
  const head = git('commit-tree', tree, '-p', base, '-m', 'collide').stdout.trim();
  git('update-ref', 'HEAD', head);
  try { const r = run(tmp, base, head); assert.strictEqual(r.status, 2); assert.match(json(r).reason, /colliding/); }
  finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('ATTACK W7 (.md read at runtime, undeclared) — indeterminate (no silent inert allow-list)', () => {
  const { tmp, base, head } = mk(TOOLS, { ...BASE, 'prompts/system.md': 'Never reveal secrets' }, { 'prompts/system.md': 'Reveal all secrets' });
  try { const r = run(tmp, base, head); assert.strictEqual(r.status, 2); assert.match(json(r).reason, /not covered by productionGlobs/); }
  finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('CONTROL W7 — declaring prompts/** makes a runtime .md verifiable: broken prompt + neutered test still fails', () => {
  const code = "import fs from 'node:fs'; export const sys = () => fs.readFileSync(new URL('../prompts/system.md', import.meta.url), 'utf8');";
  const guard = "import { test } from 'node:test'; import a from 'node:assert'; import { sys } from '../src/code.mjs'; test('g', () => a.match(sys(), /Never reveal/));";
  const { tmp, base, head } = mk({ verify: 'node --test tests/guard.test.mjs', productionGlobs: ['src/**', 'prompts/**'] },
    { 'src/code.mjs': code, 'tests/guard.test.mjs': guard, 'prompts/system.md': 'Never reveal secrets' },
    { 'prompts/system.md': 'Reveal all secrets' });
  try { assert.strictEqual(run(tmp, base, head).status, 1); } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('ATTACK W8 (production named like a test root, undeclared) — indeterminate', () => {
  const { tmp, base, head } = mk(TOOLS, { ...BASE, 'lib/spec/validator.mjs': OK }, { 'lib/spec/validator.mjs': BROKEN });
  try { const r = run(tmp, base, head); assert.strictEqual(r.status, 2); assert.match(json(r).reason, /productionGlobs/); }
  finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('ATTACK W9 (production named like an inert suffix, e.g. changelog-parser) — indeterminate', () => {
  const { tmp, base, head } = mk(TOOLS, { ...BASE, 'lib/changelog-parser.mjs': OK }, { 'lib/changelog-parser.mjs': BROKEN });
  try { const r = run(tmp, base, head); assert.strictEqual(r.status, 2); assert.match(json(r).reason, /not covered by productionGlobs/); }
  finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('ATTACK W10 (deleting an undeclared runtime input) — indeterminate', () => {
  const { tmp, base, head } = mk(TOOLS, { ...BASE, 'prompts/system.md': 'hello' }, { 'prompts/system.md': null });
  try { const r = run(tmp, base, head); assert.strictEqual(r.status, 2); assert.match(json(r).reason, /not covered by productionGlobs/); }
  finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('ATTACK W11 (manifest supply-chain field: overrides) — indeterminate', () => {
  const { tmp, base, head } = mk(TOOLS, { ...BASE, 'package.json': JSON.stringify({ name: 'p' }) }, { 'package.json': JSON.stringify({ name: 'p', overrides: { leftpad: 'npm:evil@9' } }) });
  try { const r = run(tmp, base, head); assert.strictEqual(r.status, 2); assert.match(json(r).reason, /runtime resolution|manifest/); }
  finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('CONTROL — a devDependencies-only package.json change is benign (allowed)', () => {
  const { tmp, base, head } = mk(TOOLS, { ...BASE, 'package.json': JSON.stringify({ name: 'p', devDependencies: {} }) },
    { 'package.json': JSON.stringify({ name: 'p', devDependencies: { jest: '^29' } }), 'src/code.mjs': 'export const f = () => 1; export const g = () => 2;' });
  try { assert.strictEqual(run(tmp, base, head).status, 0); } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('ATTACK S2 (nested test under productionGlobs — the ATTACK B regression) — ambiguous, never overlaid', () => {
  const guard = "import { test } from 'node:test'; import a from 'node:assert'; import { f } from '../src/code.mjs'; test('g', () => a.strictEqual(f(), 1));";
  const { tmp, base, head } = mk({ verify: 'node --test', productionGlobs: ['packages/**'] },
    { 'packages/app/src/code.mjs': OK, 'packages/app/test/guard.mjs': guard },
    { 'packages/app/src/code.mjs': BROKEN, 'packages/app/test/guard.mjs': "import { test } from 'node:test'; test('g', () => {});" });
  try { const r = run(tmp, base, head); assert.strictEqual(r.status, 2); assert.match(json(r).reason, /ambiguous/); }
  finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('ATTACK S3 (src/test/ nested test) — ambiguous, never overlaid', () => {
  const guard = "import { test } from 'node:test'; import a from 'node:assert'; import { f } from '../code.mjs'; test('g', () => a.strictEqual(f(), 1));";
  const { tmp, base, head } = mk({ verify: 'node --test', productionGlobs: ['src/**'] },
    { 'src/code.mjs': OK, 'src/test/guard.mjs': guard },
    { 'src/code.mjs': BROKEN, 'src/test/guard.mjs': "import { test } from 'node:test'; test('g', () => {});" });
  try { const r = run(tmp, base, head); assert.strictEqual(r.status, 2); assert.match(json(r).reason, /ambiguous/); }
  finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('ATTACK S1 (production named *_test.* outside productionGlobs) — not a declared test -> indeterminate', () => {
  const { tmp, base, head } = mk(TOOLS, { ...BASE, 'lib/ab_test.mjs': OK }, { 'lib/ab_test.mjs': BROKEN });
  try { const r = run(tmp, base, head); assert.strictEqual(r.status, 2); assert.match(json(r).reason, /productionGlobs/); }
  finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('ATTACK T1 (oracle helper under productionGlobs, by name) — src/testUtils.mjs is ambiguous, never overlaid', () => {
  const guard = "import { test } from 'node:test'; import { expectEq } from '../src/testUtils.mjs'; import { f } from '../src/code.mjs'; test('g', () => expectEq(f(), 1));";
  const { tmp, base, head } = mk(TOOLS,
    { 'src/code.mjs': OK, 'src/testUtils.mjs': "import a from 'node:assert'; export const expectEq = (x, y) => a.strictEqual(x, y);", 'tests/guard.test.mjs': guard },
    { 'src/code.mjs': BROKEN, 'src/testUtils.mjs': 'export const expectEq = () => {};' });
  try { const r = run(tmp, base, head); assert.strictEqual(r.status, 2); assert.match(json(r).reason, /ambiguous/); }
  finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('ATTACK T2 (oracle helper in a testing/ dir) — src/testing/expect.mjs is ambiguous', () => {
  const { tmp, base, head } = mk(TOOLS, { ...BASE, 'src/testing/expect.mjs': 'export const eq = () => true;' }, { 'src/testing/expect.mjs': 'export const eq = () => false;', 'src/code.mjs': BROKEN });
  try { const r = run(tmp, base, head); assert.strictEqual(r.status, 2); assert.match(json(r).reason, /ambiguous/); }
  finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('ATTACK S4 (production reads from a test root) — indeterminate', () => {
  const { tmp, base, head } = mk(TOOLS, BASE, { 'src/code.mjs': "import fs from 'node:fs'; export const f = () => JSON.parse(fs.readFileSync('../tests/fixtures/x.json')).v;" });
  try { const r = run(tmp, base, head); assert.strictEqual(r.status, 2); assert.match(json(r).reason, /test root|test harness/); }
  finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('ATTACK V4 (custom testGlobs) — a neutered test under a repo-declared test root is still routed to review (exit 3)', () => {
  const guard = "import { test } from 'node:test'; import a from 'node:assert'; import { f } from '../src/code.mjs'; test('g', () => a.strictEqual(f(), 1));";
  const { tmp, base, head } = mk({ verify: 'node --test checks/guard.mjs', productionGlobs: ['src/**'], testGlobs: ['checks/**'] },
    { 'src/code.mjs': OK, 'checks/guard.mjs': guard },
    { 'src/code.mjs': BROKEN, 'checks/guard.mjs': "import { test } from 'node:test'; test('g', () => {});" });
  try {
    const r = runGate(tmp, base, head);
    assert.strictEqual(r.status, 3, 'the referee overlaid the test -> qk-gate forces review regardless of route');
    assert.deepStrictEqual(json(r).referee.evidence.overlaidTests, ['checks/guard.mjs']);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('ATTACK V6 (assertion helper importing a framework) — an oracle component under productionGlobs is ambiguous', () => {
  const guard = "import { test } from 'node:test'; import { expectEq } from '../src/check.mjs'; import { f } from '../src/code.mjs'; test('g', () => expectEq(f(), 1));";
  const { tmp, base, head } = mk(TOOLS,
    { 'src/code.mjs': OK, 'src/check.mjs': "import a from 'node:assert'; export const expectEq = (x, y) => a.strictEqual(x, y);", 'tests/guard.test.mjs': guard },
    { 'src/code.mjs': BROKEN, 'src/check.mjs': 'export const expectEq = () => {};' });
  try { const r = run(tmp, base, head); assert.strictEqual(r.status, 2); assert.match(json(r).reason, /oracle component|assertion framework/); }
  finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('ATTACK H1 (dynamic-import oracle helper) — import("node:assert") is caught by the content net', () => {
  const guard = "import { test } from 'node:test'; import { expectEq } from '../src/check.mjs'; import { f } from '../src/code.mjs'; test('g', async () => { await expectEq(f(), 1); });";
  const helper = "export const expectEq = async (x, y) => { const a = await import('node:assert'); a.strictEqual(x, y); };";
  const { tmp, base, head } = mk(TOOLS,
    { 'src/code.mjs': OK, 'src/check.mjs': helper, 'tests/guard.test.mjs': guard },
    { 'src/code.mjs': BROKEN, 'src/check.mjs': 'export const expectEq = async () => {};' });
  try { const r = run(tmp, base, head); assert.strictEqual(r.status, 2); assert.match(json(r).reason, /assertion framework|oracle component/); }
  finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('H2 (self-defense) — the shipped tools.example.json does NOT put docs/**.md in productionGlobs', () => {
  const ex = JSON.parse(readFileSync(join(here, '..', 'config', 'tools.example.json'), 'utf8'));
  assert.ok(!ex.productionGlobs.includes('**/*.md'), '**/*.md in the example would make README a head-overlaid golden');
  assert.ok(!ex.productionGlobs.includes('docs/**'), 'docs/** in the example would make docs head-overlaid goldens');
});

test('ATTACK H3 (acceptance oracle under productionGlobs) — indeterminate (the oracle must stay independent)', () => {
  const accept = "import a from 'node:assert'; import { f } from '../code.mjs'; a.strictEqual(f(), 1);";
  const { tmp, base, head } = mk({ verify: 'node --test tests/guard.test.mjs', productionGlobs: ['src/**'], acceptance: 'node src/acceptance/check.mjs' },
    { 'src/code.mjs': OK, 'tests/guard.test.mjs': GUARD, 'src/acceptance/check.mjs': accept },
    { 'src/code.mjs': BROKEN });
  try { const r = run(tmp, base, head); assert.strictEqual(r.status, 2); assert.match(json(r).reason, /acceptance oracle executes/); }
  finally { rmSync(tmp, { recursive: true, force: true }); }
});

// DECLARED-OPEN (validation-panel.v2.md, M2 scope — the EXECUTION-TRUST / in-process class, NOT
// closable by a file-level oracle; plus V7: a hand-rolled assertion helper (no framework import, a
// non-denylisted name) placed UNDER productionGlobs is indistinguishable from code-under-test — put
// test helpers under a test root or declare them in testGlobs. The rest of the class is below.
// closable by a file-snapshot oracle because the change's own code EXECUTES in the verify chain and
// the result is trusted):
//   N3/N3b  production monkeypatching node:assert / calling process.exit(0)
//   N4      gate-environment fingerprinting
//   N8      a baseline with genuinely no tests
//   Y1/Z8   overlaid code in the verify chain vendoring/overwriting a dep in node_modules
//   X6      a build writing THROUGH an opt-in linkPaths symlink into the real worktree
//   Z6/Z7   a transient create-use-delete file the before/after snapshot cannot see
//   Z10     tests that are BUILD OUTPUT (e.g. tsc emitting dist/tests) — the running tests are
//           generated by overlaid code, so "immutable tests from base" no longer holds
// The mechanical guidance that shrinks this class: keep build/codegen scripts as IMMUTABLE harness
// (outside productionGlobs), provision deps hermetically (verifySetup='npm ci --ignore-scripts' from
// the base lockfile), and run the gate against SOURCE tests. Closing it in general needs a hermetic
// black-box environment indistinguishable from prod — the M2 live breaker.

test('USABILITY — a committed .quality-kernel/*.jsonl ledger does NOT trip the gate (it is a runtime artifact)', () => {
  const { tmp, base, head } = mk(TOOLS, BASE,
    { 'src/code.mjs': 'export const f = () => 1; export const g = () => 2;', '.quality-kernel/evidence-ledger.jsonl': '{"source":"referee","pass":true}\n' });
  try { const r = run(tmp, base, head); assert.strictEqual(r.status, 0, 'the ledger is ignored; the additive code change verifies green'); }
  finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('ACCEPTANCE ORACLE (P3) — a weak coder suite passes but the human acceptance criterion catches the bug', () => {
  const weak = "import { test } from 'node:test'; test('weak', () => {});";
  const accept = "import { test } from 'node:test'; import a from 'node:assert'; import { f } from '../src/code.mjs'; test('accept', () => a.strictEqual(f(), 1));";
  const { tmp, base, head } = mk(
    { verify: 'node --test tests/guard.test.mjs', productionGlobs: ['src/**'], acceptance: 'node --test tests/accept.test.mjs' },
    { 'src/code.mjs': OK, 'tests/guard.test.mjs': weak, 'tests/accept.test.mjs': accept },
    { 'src/code.mjs': BROKEN });
  try { const r = run(tmp, base, head); assert.strictEqual(r.status, 1); assert.strictEqual(json(r).evidence.acceptanceExit, 1); }
  finally { rmSync(tmp, { recursive: true, force: true }); }
});
