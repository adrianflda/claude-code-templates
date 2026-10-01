import './hermetic-git.mjs';
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGuide, applyGuide, validateGuide, readGuideForbidden, BEGIN, END, BLOCK_BUDGET } from './org-guide.mjs';
import { discover } from './org-discover.mjs';

// The org guide lives in a managed block of <org>/CLAUDE.md (the file Claude Code already loads);
// the full integration map in <org>/SYSTEM-MAP.md. Hand-written text outside the block is never
// touched, the block has a size budget, and nothing is written without --apply.
const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, 'org-guide.mjs');
const gitIn = (dir) => (...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
function write(dir, p, c) { const d = join(dir, p); mkdirSync(dirname(d), { recursive: true }); writeFileSync(d, c); }
const HAND = '# Org rules (hand-written)\n\n- Use the -qa-local copies only.\n';
function org({ claude = HAND } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'org-guide-')));
  const mk = (name, files) => {
    const dir = join(root, name); mkdirSync(dir);
    const g = gitIn(dir);
    g('init', '-q', '-b', 'development'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
    for (const [p, c] of Object.entries(files)) write(dir, p, c);
    g('add', '-A'); g('commit', '-qm', 'init');
  };
  mk('web', { 'package.json': '{}', 'src/api/eventAPI.js': "import axios from 'axios';\nexport const spaces = () => axios.get('/spaces/');\nexport const ghost = () => axios.get('/nowhere/');\n", '.env.production': 'API_URL=x\n' });
  mk('api', { 'package.json': '{}', 'spaces/urls.py': "from django.urls import path\nurlpatterns = [\n    path('spaces/', views.Spaces.as_view()),\n]\n", 'blank.py': 'x = 1\n\ny = 2\n', 'empty/__init__.py': '' });
  if (claude !== null) writeFileSync(join(root, 'CLAUDE.md'), claude);
  return root;
}
const GUIDE = {
  org: 'Acme',
  repos: [{ name: 'web', role: 'app', base: 'development', note: 'the attendee app' }, { name: 'api', role: 'app', base: 'development' }],
  forbidden: ['web-qa'],
  truth: [{ topic: 'Product decisions', where: 'acme-wiki epics decisions.md', note: 'wiki + issues first' }],
  conventions: [{ rule: 'one branch name per feature in every repo', source: 'team rule 2026-07' }],
  threads: [{ text: 'web calls a missing /nowhere/ route', source: 'SYSTEM-MAP 2026-10-01' }],
};
const EDGE = { from: 'web', to: 'api', kind: 'http', endpoint: 'GET /spaces/', evidence: { from: 'src/api/eventAPI.js:2', to: 'spaces/urls.py:3' }, confidence: 'high', guardable: 'route-exists' };
const UNMATCHED = { from: 'web', endpoint: 'GET /nowhere/', evidence: 'src/api/eventAPI.js:3', reason: 'no route serves it in the selected repos' };
const DATE = '2026-10-01';
const build = (root, integrations = null, guide = GUIDE) => buildGuide({ org: root, guide, integrations, date: DATE });
const run = (root, integrations = null, guide = GUIDE) => { const b = build(root, integrations, guide); applyGuide(b, { org: root, stamp: 's1' }); return b; };
const claudeOf = (root) => readFileSync(join(root, 'CLAUDE.md'), 'utf8');

// --- the CLAUDE.md block ---
test('apply: the block is appended after the hand-written text, which stays byte-identical; a backup is kept', () => {
  const root = org();
  run(root);
  const s = claudeOf(root);
  assert.ok(s.startsWith(HAND), 'hand-written text untouched');
  assert.ok(s.includes(BEGIN) && s.trimEnd().endsWith(END));
  assert.match(s, /\| `web` \| app \| `development` \| the attendee app \|/);
  assert.match(s, /- Forbidden \(never open, run or write\): `web-qa`/);
  assert.match(s, /- \*\*Product decisions\*\* → acme-wiki epics decisions\.md — wiki \+ issues first/);
  assert.strictEqual(readFileSync(join(root, '.claude', 'org-workspace', 'backups', 'CLAUDE.md.s1'), 'utf8'), HAND);
});

test('re-apply replaces only the block (idempotent), text before and after it is kept', () => {
  const root = org();
  run(root);
  writeFileSync(join(root, 'CLAUDE.md'), claudeOf(root) + '\n## Added later by hand\n');
  run(root, null, { ...GUIDE, threads: [] });
  const s = claudeOf(root);
  assert.ok(s.startsWith(HAND));
  assert.ok(s.endsWith('\n## Added later by hand\n'));
  assert.strictEqual(s.split(BEGIN).length - 1, 1);
  assert.doesNotMatch(s, /missing \/nowhere\//);
});

test('no CLAUDE.md yet: it is created with only the block', () => {
  const root = org({ claude: null });
  run(root);
  assert.ok(claudeOf(root).startsWith(BEGIN));
});

test('dry run (CLI without --apply) prints the diff and the size, and writes nothing', () => {
  const root = org();
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'org-guide-cli-')));
  writeFileSync(join(tmp, 'guide.json'), JSON.stringify(GUIDE));
  const r = spawnSync('node', [cli, '--org', root, '--guide', join(tmp, 'guide.json'), '--date', DATE], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /^\+## Org guide — Acme/m);
  assert.match(r.stdout, new RegExp(`block: \\d+ / ${BLOCK_BUDGET} bytes\\. Nothing written`));
  assert.strictEqual(claudeOf(root), HAND);
  assert.strictEqual(existsSync(join(root, '.claude')), false);
  const a = spawnSync('node', [cli, '--org', root, '--guide', join(tmp, 'guide.json'), '--date', DATE, '--apply'], { encoding: 'utf8' });
  assert.strictEqual(a.status, 0, a.stderr);
  assert.ok(claudeOf(root).includes(BEGIN));
});

test('budget: a guide over the block budget is refused, nothing written', () => {
  const root = org();
  const big = { ...GUIDE, truth: Array.from({ length: 30 }, (_, i) => ({ topic: `Topic ${i}`, where: 'x'.repeat(150), note: 'y'.repeat(60) })) };
  assert.throws(() => build(root, null, big), /budget is 4096/);
  assert.strictEqual(claudeOf(root), HAND);
});

test('unbalanced or repeated markers and a symlinked CLAUDE.md are refused', () => {
  for (const bad of [`${BEGIN}\nno end\n`, `${END}\n${BEGIN}\n`, `${BEGIN}\n${END}\n${BEGIN}\n${END}\n`]) {
    assert.throws(() => build(org({ claude: bad })), /marker/, bad);
  }
  const root = org({ claude: null });
  const elsewhere = join(realpathSync(mkdtempSync(join(tmpdir(), 'org-guide-x-'))), 'target.md');
  writeFileSync(elsewhere, 'x');
  symlinkSync(elsewhere, join(root, 'CLAUDE.md'));
  assert.throws(() => build(root), /symlink/);
});

test('guide validation: shape, names, single-line secret-free text, no markers, bounded threads', () => {
  for (const [g, re] of [
    [{ ...GUIDE, extra: 1 }, /unknown key "extra"/],
    [{ ...GUIDE, repos: [{ name: '../x', role: 'app', base: 'm' }] }, /invalid repo name/],
    [{ ...GUIDE, repos: [{ name: 'web', role: 'service', base: 'm' }] }, /role must be/],
    [{ ...GUIDE, repos: [...GUIDE.repos, { name: 'web', role: 'app', base: 'm' }] }, /duplicate repo/],
    [{ ...GUIDE, forbidden: ['web'] }, /also listed in repos/],
    [{ ...GUIDE, truth: [{ topic: 'a\nb', where: 'x' }] }, /single-line/],
    [{ ...GUIDE, truth: [{ topic: 'Keys', where: "api_key: 'Zq8vT2mKpL9xR4wN7bY3cF6hJ1'" }] }, /secret-looking/],
    [{ ...GUIDE, conventions: [{ rule: 'see <!-- org-workspace:end -->', source: 's' }] }, /markers/],
    [{ ...GUIDE, threads: Array.from({ length: 13 }, (_, i) => ({ text: `t${i}`, source: 's' })) }, /at most 12/],
  ]) assert.match(validateGuide(g).join('\n'), re);
  assert.deepStrictEqual(validateGuide(GUIDE), []);
});

test('rendered text cannot inject HTML or break the tables', () => {
  const root = org();
  run(root, null, { ...GUIDE, truth: [{ topic: 'A | B', where: '<img src=https://evil/px.gif>' }] });
  const s = claudeOf(root);
  assert.ok(!s.includes('<img'));
  assert.match(s, /A \\\| B/);
});

test('the forbidden list written by the guide is what discover reads back (and never opens)', () => {
  const root = org();
  mkdirSync(join(root, 'web-qa'));
  run(root);
  assert.deepStrictEqual(readGuideForbidden(root), ['web-qa']);
  const c = discover({ org: root }).candidates.find((x) => x.name === 'web-qa');
  assert.strictEqual(c.forbidden, true); assert.strictEqual(c.opened, false);
});

// --- the integration map (SYSTEM-MAP.md + the summary in the block) ---
test('with a valid map: SYSTEM-MAP.md is written and the block carries a pointer + one line per pair', () => {
  const root = org();
  run(root, { edges: [EDGE], unmatched: [UNMATCHED] });
  const s = claudeOf(root);
  assert.match(s, /### Who calls whom \(full map with file:line citations: `SYSTEM-MAP\.md` — read only the section you need\)/);
  assert.match(s, /- `web` → `api`: 1/);
  const md = readFileSync(join(root, 'SYSTEM-MAP.md'), 'utf8');
  assert.match(md, /\| http \| `GET \/spaces\/` \| high \| route-exists \| ✓ `src\/api\/eventAPI\.js:2` \| ✓ `spaces\/urls\.py:3` \|/);
  assert.match(md, /1 of 1 connections are ✓ on both sides/);
  assert.match(md, /\| web \| `GET \/nowhere\/` \| `src\/api\/eventAPI\.js:3` \|/);
});

for (const [name, edge, re] of [
  ['a line past the end of the file', { ...EDGE, evidence: { ...EDGE.evidence, to: 'spaces/urls.py:40' } }, /has 4 line\(s\)/],
  ['a file that does not exist', { ...EDGE, evidence: { ...EDGE.evidence, from: 'src/api/madeUp.js:1' } }, /not a committed, readable file of web/],
  ['the provider line cited in the caller repo', { ...EDGE, evidence: { ...EDGE.evidence, to: 'src/api/eventAPI.js:2' } }, /not a committed, readable file of api/],
  ['a .env file, even committed', { ...EDGE, evidence: { ...EDGE.evidence, from: '.env.production:1' } }, /not a committed, readable file/],
  ['a blank line', { ...EDGE, evidence: { ...EDGE.evidence, to: 'blank.py:2' } }, /that line is blank/],
  ['a line of an empty file', { ...EDGE, evidence: { ...EDGE.evidence, to: 'empty/__init__.py:1' } }, /has 0 line\(s\)/],
  ['a path with ..', { ...EDGE, evidence: { ...EDGE.evidence, from: '../api/spaces/urls.py:3' } }, /must be "path:line"/],
  ['a repo the guide does not list', { ...EDGE, to: 'billing' }, /"billing" is not a selected repo/],
  ['a self edge', { ...EDGE, to: 'web', evidence: { from: 'src/api/eventAPI.js:2', to: 'src/api/eventAPI.js:2' } }, /two different repos/],
  ['an unknown kind', { ...EDGE, kind: 'magic' }, /kind must be one of/],
  ['an unknown key', { ...EDGE, trusted: true }, /unknown key "trusted"/],
  ['a quoted secret in a note', { ...EDGE, note: "sends x-api-key 'Zq8vT2mKpL9xR4wN7bY3cF6hJ1'" }, /secret-looking/],
]) {
  test(`map refused, nothing written: ${name}`, () => {
    const root = org();
    assert.throws(() => build(root, { edges: [edge], unmatched: [] }), re);
    assert.strictEqual(claudeOf(root), HAND);
    assert.strictEqual(existsSync(join(root, 'SYSTEM-MAP.md')), false);
  });
}

test('map: duplicates refused; an unrelated but existing line is labelled ~ (exists), not ✓', () => {
  assert.throws(() => build(org(), { edges: [EDGE, { ...EDGE }] }), /duplicate edge/);
  const root = org();
  run(root, { edges: [{ ...EDGE, evidence: { from: 'package.json:1', to: 'spaces/urls.py:1' } }] });
  assert.match(readFileSync(join(root, 'SYSTEM-MAP.md'), 'utf8'), /\| ~ `package\.json:1` \| ~ `spaces\/urls\.py:1` \|/);
});

test('map: line numbers in free text are stripped; the real citations are kept', () => {
  const root = org();
  run(root, { edges: [{ ...EDGE, note: 'body read at views.py:497' }], unmatched: [{ ...UNMATCHED, reason: 'see urls.py:12' }] });
  const md = readFileSync(join(root, 'SYSTEM-MAP.md'), 'utf8');
  assert.match(md, /body read at views\.py$/m);
  assert.doesNotMatch(md, /views\.py:497|urls\.py:12/);
  assert.match(md, /`src\/api\/eventAPI\.js:2`/);
});

test('an existing SYSTEM-MAP.md is backed up before it is replaced', () => {
  const root = org();
  writeFileSync(join(root, 'SYSTEM-MAP.md'), 'old map\n');
  run(root, { edges: [EDGE] });
  const backups = readdirSync(join(root, '.claude', 'org-workspace', 'backups'));
  assert.ok(backups.includes('SYSTEM-MAP.md.s1'), backups.join(','));
});
