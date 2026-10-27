import './hermetic-git.mjs';
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, realpathSync, symlinkSync, unlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGuide, applyGuide, validateGuide, readGuideForbidden, spliceBlock, summarizeEdges, stampGuide, BEGIN, END, BLOCK_BUDGET } from './org-guide.mjs';
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
});

// OG-6: the marker text points the reader at /org-learn, not at hand-editing the block.
test('OG-6: the BEGIN marker tells the reader to use /org-learn, not to hand-edit the block', () => {
  assert.match(BEGIN, /\/org-learn/);
  assert.doesNotMatch(BEGIN, /or by hand/i);
});

// OG-11 / F15: an END sitting immediately before a BEGIN (no separating content) is an ordering
// error, not a silent two-BEGIN result.
test('OG-11: an END immediately before a BEGIN throws instead of producing two BEGIN markers', () => {
  assert.throws(() => spliceBlock(END + BEGIN + 'x', BEGIN + 'y' + END), /end marker before the begin marker/);
  const root = org({ claude: END + BEGIN + 'tail' });
  assert.throws(() => build(root), /end marker before the begin marker/);
  assert.strictEqual(claudeOf(root), END + BEGIN + 'tail');
});

test('a symlinked CLAUDE.md is refused', () => {
  const root = org({ claude: null });
  const elsewhere = join(realpathSync(mkdtempSync(join(tmpdir(), 'org-guide-x-'))), 'target.md');
  writeFileSync(elsewhere, 'x');
  symlinkSync(elsewhere, join(root, 'CLAUDE.md'));
  assert.throws(() => build(root), /symlink/);
});

// Panel MEDIUM (review e2c3801d): `existsSync(p) && lstatSync(p).isSymbolicLink()` follows the link
// to decide existence first — a DANGLING symlink (target does not exist) reports existsSync() false,
// so the check is skipped and writeFileSync follows the link, creating a file outside the org folder.
test('a DANGLING symlinked CLAUDE.md is refused, not silently followed (writes nowhere)', () => {
  const root = org({ claude: null });
  const nowhere = join(realpathSync(mkdtempSync(join(tmpdir(), 'org-guide-dangle-'))), 'does-not-exist.md');
  symlinkSync(nowhere, join(root, 'CLAUDE.md'));
  assert.throws(() => build(root), /symlink/);
  assert.strictEqual(existsSync(nowhere), false, 'the dangling target must not have been created');
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

// Panel HIGH (review e2c3801d): readGuideFileRaw's bare `catch { return null; }` treated EVERY lstat
// error as "not written yet" (ENOENT), including ENOTDIR/EACCES/EIO/ELOOP — fails OPEN (OG-2 requires
// fail-closed on anything but a genuine absence).
test('OG-2: readGuideForbidden fails closed on a real stat error, not just absence (ENOTDIR)', () => {
  const root = org();
  writeFileSync(join(root, '.claude'), 'a plain file, not a directory'); // makes '.claude/org-workspace' ENOTDIR
  assert.throws(() => readGuideForbidden(root), /ENOTDIR|not a directory|cannot stat/);
});

test('OG-2: readGuideForbidden fails closed on EACCES (a directory it cannot stat into)', (t) => {
  if (process.getuid && process.getuid() === 0) { t.skip('running as root: chmod 000 does not deny root'); return; }
  const root = org();
  mkdirSync(join(root, '.claude'));
  chmodSync(join(root, '.claude'), 0o000);
  try {
    assert.throws(() => readGuideForbidden(root), /EACCES|permission|cannot stat/);
  } finally { chmodSync(join(root, '.claude'), 0o755); }
});

// Panel LOW (review e2c3801d, two citations): a `forbidden` entry that fails isRepoName was silently
// dropped (`.filter(isRepoName)`) instead of failing closed — a hand-edited or stricter-rule-rejected
// name shrinks the deny set with no signal, and discover then opens a repo meant to be forbidden.
test('OG-2: readGuideForbidden throws on an invalid forbidden entry instead of silently dropping it', () => {
  const root = org();
  write(root, '.claude/org-workspace/guide.json', JSON.stringify({ org: 't', repos: [], forbidden: ['ok-name', '../etc'] }));
  assert.throws(() => readGuideForbidden(root), /invalid repo name|forbidden/);
  write(root, '.claude/org-workspace/guide.json', JSON.stringify({ org: 't', repos: [], forbidden: ['ok-name', 7] }));
  assert.throws(() => readGuideForbidden(root), /invalid repo name|forbidden/);
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
  ['INV-OG-17: a syntactically invalid repo name (path traversal)', { ...EDGE, to: '../x' }, /invalid repo name/],
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

test('apply also writes the machine copy .claude/org-workspace/guide.json (what quality-kernel reads)', () => {
  const root = org();
  run(root);
  const written = JSON.parse(readFileSync(join(root, '.claude', 'org-workspace', 'guide.json'), 'utf8'));
  assert.deepStrictEqual(written, { ...GUIDE, version: 1 });
});

// OG-7: the tool stamps "version": 1 into every guide.json it writes, whether or not the proposal
// given to it (the --guide input) supplied one.
test('OG-7: guide.json always gets "version": 1, even when the input guide had none', () => {
  const root = org();
  const { org: _o, ...guideWithoutVersion } = GUIDE; // sanity: GUIDE itself has no "version" key
  assert.strictEqual('version' in guideWithoutVersion, false);
  const b = build(root);
  applyGuide(b, { org: root, stamp: 's7' });
  const written = JSON.parse(readFileSync(join(root, '.claude', 'org-workspace', 'guide.json'), 'utf8'));
  assert.strictEqual(written.version, 1);
});

// OG-15/F18: a repo named in the guide that cannot be profiled is recorded among the build's
// problems (name + the real error), not silently dropped with no explanation.
test('OG-15: a repo that cannot be profiled is recorded, not silently dropped', () => {
  const root = org();
  const guideWithGhost = { ...GUIDE, repos: [...GUIDE.repos, { name: 'ghost', role: 'app', base: 'main' }] };
  const b = build(root, { edges: [EDGE], unmatched: [] }, guideWithGhost);
  assert.strictEqual(b.profilingProblems.length, 1);
  assert.strictEqual(b.profilingProblems[0].repo, 'ghost');
  assert.match(b.profilingProblems[0].error, /not found|repo not found/);
});

// INV-OG-19: an existing repo whose declared base branch does not exist is reported by name AND the
// real branch, not only the ghost-repo "not found" case above.
test('INV-OG-19: a repo with a non-existent declared base branch is reported by name and branch', () => {
  const root = org();
  const guide = { ...GUIDE, repos: GUIDE.repos.map((r) => (r.name === 'web' ? { ...r, base: 'no-such-branch' } : r)) };
  const b = build(root, { edges: [], unmatched: [] }, guide);
  assert.strictEqual(b.profilingProblems.length, 1);
  assert.strictEqual(b.profilingProblems[0].repo, 'web');
  assert.match(b.profilingProblems[0].error, /no-such-branch/);
});

// A guide update without a new map (the usual /org-learn case) keeps the last map's summary.
test('re-applying without --integrations keeps the who-calls-whom summary of the last map', () => {
  const root = org();
  run(root, { edges: [EDGE] });
  run(root, null, { ...GUIDE, threads: [{ text: 'a new thread', source: 's' }] });
  const s = claudeOf(root);
  assert.match(s, /- `web` → `api`: 1/);
  assert.match(s, /a new thread/);
});

// OG-1/OG-19(h)/INV-OG-26 (scope cut 2026-10-27): the block is GENERATED output; every apply
// overwrites whatever is currently between the markers, including a hand edit — no refusal, no
// detection, no renderHash.
test('OG-1/OG-19(h): a hand edit inside the markers is overwritten by the next apply, not refused', () => {
  const root = org();
  run(root);
  const before = claudeOf(root);
  const i = before.indexOf(BEGIN); const j = before.indexOf(END) + END.length;
  const handEdited = before.slice(0, i) + before.slice(i, j).replace('Acme', 'HAND-EDITED-ACME') + before.slice(j);
  assert.notStrictEqual(handEdited, before, 'sanity: the hand edit actually changed the block');
  writeFileSync(join(root, 'CLAUDE.md'), handEdited);
  const b2 = build(root); // same guide.json content as the first apply
  applyGuide(b2, { org: root, stamp: 's2' }); // must NOT throw
  const after = claudeOf(root);
  assert.doesNotMatch(after, /HAND-EDITED-ACME/, 'the hand edit is gone');
  assert.strictEqual(after, before, 'the block is back to exactly the fresh render (byte-identical to the first apply)');
});

test('OG-6/INV-OG-21: the marker says the block is generated/overwritten and names /org-learn', () => {
  assert.match(BEGIN, /\/org-learn/);
  assert.match(BEGIN, /generated|overwritten|OVERWRITTEN/);
});

// OG-10/F3/INV-OG-6: a bare, unquoted AWS-access-key-shaped token in an integration map's
// unmatched[].reason is refused end-to-end through buildGuide — not just at the hasSecret-unit level.
// OG-19(b)/F11: `unmatched[].evidence` is checked exactly like an edge's evidence — malformed,
// missing, or past a file's end all throw and write nothing.
for (const [name, evidence, re] of [
  ['malformed (no line number)', 'src/api/eventAPI.js', /must be "path:line"/],
  ['missing', undefined, /must be "path:line"/],
  ['past the end of the file', 'src/api/eventAPI.js:999', /has \d+ line\(s\)/],
]) {
  test(`OG-19(b): unmatched[].evidence ${name} throws; nothing written`, () => {
    const root = org();
    const bad = { edges: [], unmatched: [{ ...UNMATCHED, evidence }] };
    assert.throws(() => build(root, bad), re);
    assert.strictEqual(existsSync(join(root, 'SYSTEM-MAP.md')), false);
    assert.strictEqual(claudeOf(root), HAND);
  });
}

test('OG-10/INV-OG-6: a bare AKIA-shaped token in unmatched[].reason is refused; SYSTEM-MAP.md unwritten', () => {
  const root = org();
  const bad = { edges: [], unmatched: [{ ...UNMATCHED, reason: 'uses key AKIAABCDEFGHIJKLMNOP for auth' }] };
  assert.throws(() => build(root, bad), /secret-looking value/);
  assert.strictEqual(existsSync(join(root, 'SYSTEM-MAP.md')), false);
});

// INV-OG-24 (representative subset): every pattern OG-10 lists is refused in BOTH the guide path and
// the map path, not only the AKIA shape.
const SECRET_SAMPLES = [
  'ghp_' + 'a'.repeat(36),
  'sk-live-' + 'a'.repeat(24),
  'xoxb-' + '1'.repeat(10),
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  'Bearer ' + 'a'.repeat(20),
  'https://user:pass@host/x',
];
for (const secret of SECRET_SAMPLES) {
  test(`INV-OG-24: "${secret.slice(0, 12)}..." is refused in the guide path (truth[].note)`, () => {
    const root = org();
    assert.match(validateGuide({ ...GUIDE, truth: [{ topic: 'Keys', where: 'x', note: secret }] }).join('\n'), /secret-looking value/);
  });
  test(`INV-OG-24: "${secret.slice(0, 12)}..." is refused in the map path (edge.note)`, () => {
    const root = org();
    assert.throws(() => build(root, { edges: [{ ...EDGE, note: secret }] }), /secret-looking value/);
  });
}

// OG-4/F19/F20: the who-calls-whom summary lives in guide.json's own "summary" field; map-summary.json
// is a one-time legacy migration, never read again afterward.
test('OG-4: a legacy map-summary.json is folded into guide.json once, then never read again', () => {
  const root = org();
  run(root, null, { ...GUIDE }); // first apply: no integrations, no legacy file -> no summary yet
  assert.strictEqual(JSON.parse(readFileSync(join(root, '.claude', 'org-workspace', 'guide.json'), 'utf8')).summary, undefined);
  write(root, '.claude/org-workspace/map-summary.json', JSON.stringify([{ from: 'web', to: 'api', n: 3 }]));
  run(root, null, { ...GUIDE, threads: [{ text: 'folded in', source: 's' }] });
  const g1 = JSON.parse(readFileSync(join(root, '.claude', 'org-workspace', 'guide.json'), 'utf8'));
  assert.deepStrictEqual(g1.summary, [{ from: 'web', to: 'api', n: 3 }]);
  assert.match(claudeOf(root), /- `web` → `api`: 3/);
  // Now change the legacy file; it must NEVER be read again (guide.json.summary is authoritative).
  write(root, '.claude/org-workspace/map-summary.json', JSON.stringify([{ from: 'web', to: 'api', n: 999 }]));
  run(root, null, { ...GUIDE, threads: [] });
  const g2 = JSON.parse(readFileSync(join(root, '.claude', 'org-workspace', 'guide.json'), 'utf8'));
  assert.deepStrictEqual(g2.summary, [{ from: 'web', to: 'api', n: 3 }], 'the stale legacy file is ignored once guide.json has its own summary');
});

test('OG-4/OG-19(g): a symlinked legacy map-summary.json makes the apply refuse, nothing written', () => {
  const root = org();
  run(root, null, { ...GUIDE });
  const outside = join(realpathSync(mkdtempSync(join(tmpdir(), 'org-guide-legacy-'))), 'target.json');
  writeFileSync(outside, JSON.stringify([{ from: 'a', to: 'b', n: 1 }]));
  symlinkSync(outside, join(root, '.claude', 'org-workspace', 'map-summary.json'));
  const before = claudeOf(root);
  assert.throws(() => build(root, null, { ...GUIDE, threads: [{ text: 'x', source: 's' }] }), /symlink/);
  assert.strictEqual(claudeOf(root), before);
});

// Shared scaffolding for the three "a carried-summary problem only warns" tests below: build()+
// applyGuide() still succeed, capturing stderr to assert the expected warning fired and that no
// "Who calls whom" section was rendered this run.
function buildAndApplyExpectingOnlyAWarning(root, { guide = GUIDE, stamp, warningPattern }) {
  const original = process.stderr.write;
  const lines = [];
  process.stderr.write = (s) => { lines.push(s); return true; };
  let b;
  try { b = build(root, null, guide); } finally { process.stderr.write = original; }
  applyGuide(b, { org: root, stamp });
  assert.ok(lines.some((l) => warningPattern.test(l)), `expected a warning matching ${warningPattern}, got: ${JSON.stringify(lines)}`);
  assert.doesNotMatch(claudeOf(root), /Who calls whom/);
}

test('OG-4/OG-19(c)(g): a shape-invalid legacy map-summary.json only warns; no crash, no section', () => {
  const root = org();
  run(root, null, { ...GUIDE });
  write(root, '.claude/org-workspace/map-summary.json', JSON.stringify({ not: 'an array' }));
  buildAndApplyExpectingOnlyAWarning(root, { guide: { ...GUIDE, threads: [{ text: 'still works', source: 's' }] }, stamp: 's-inv', warningPattern: /not shaped as/ });
});

test('OG-4/OG-19(c)(g): an unparseable legacy map-summary.json only warns; no crash, no section', () => {
  const root = org();
  run(root, null, { ...GUIDE });
  write(root, '.claude/org-workspace/map-summary.json', 'not json{');
  buildAndApplyExpectingOnlyAWarning(root, { guide: { ...GUIDE, threads: [{ text: 'still works', source: 's' }] }, stamp: 's-inv3', warningPattern: /could not be parsed/ });
});

test('OG-4/OG-19(c): a malformed "summary" field already on guide.json only warns; no crash, no section', () => {
  const root = org();
  run(root, null, { ...GUIDE });
  const g = JSON.parse(readFileSync(join(root, '.claude', 'org-workspace', 'guide.json'), 'utf8'));
  writeFileSync(join(root, '.claude', 'org-workspace', 'guide.json'), JSON.stringify({ ...g, summary: [{ from: 'web' }] }));
  buildAndApplyExpectingOnlyAWarning(root, { stamp: 's-inv2', warningPattern: /not shaped as/ });
});

// OG-19(a)/F5/F7/F10: symlinked write targets, including the SYSTEM-MAP.md case (only a real write
// target when --integrations is supplied — a guide-only apply never touches it).
test('OG-19(a): a symlinked guide.json makes applyGuide throw; CLAUDE.md is unchanged', () => {
  const root = org();
  run(root);
  const before = claudeOf(root);
  const outside = join(realpathSync(mkdtempSync(join(tmpdir(), 'org-guide-sym-'))), 'g.json');
  writeFileSync(outside, 'old');
  const guidePath = join(root, '.claude', 'org-workspace', 'guide.json');
  unlinkSync(guidePath);
  symlinkSync(outside, guidePath);
  // A symlinked guide.json is refused the moment anything tries to read or write through it — here
  // that happens during build's OG-4 carry-forward read, even before applyGuide's own precondition
  // check would run; either way, nothing is ever written (OG-12).
  assert.throws(() => { const b = build(root, null, { ...GUIDE, threads: [{ text: 'new', source: 's' }] }); applyGuide(b, { org: root, stamp: 's-sym' }); }, /symlink/);
  assert.strictEqual(claudeOf(root), before, 'CLAUDE.md must remain byte-identical — OG-12');
  assert.strictEqual(readFileSync(outside, 'utf8'), 'old', 'the symlink target is untouched');
});

test('OG-12: applyGuide refuses a guide.json that becomes a symlink only after build() already ran (its own precondition, not just buildGuide\'s)', () => {
  const root = org();
  const before = claudeOf(root); // F5/F7: CLAUDE.md must stay byte-identical — it must never be
  // written before guide.json's own precondition is checked.
  const b = build(root); // first ever build: guide.json does not exist yet, so build()'s own read is a no-op
  const outside = join(realpathSync(mkdtempSync(join(tmpdir(), 'org-guide-sym4-'))), 'g.json');
  writeFileSync(outside, 'old');
  const guidePath = join(root, '.claude', 'org-workspace', 'guide.json');
  mkdirSync(dirname(guidePath), { recursive: true });
  symlinkSync(outside, guidePath);
  assert.throws(() => applyGuide(b, { org: root, stamp: 's-sym4' }), /symlink/);
  assert.strictEqual(readFileSync(outside, 'utf8'), 'old', 'the symlink target is untouched');
  assert.strictEqual(claudeOf(root), before, 'CLAUDE.md must remain byte-identical (F5/F7)');
  assert.strictEqual(existsSync(join(root, '.claude', 'org-workspace', 'backups')), false, 'no backup file was created either — nothing was written at all');
});

test('a DANGLING symlinked guide.json is refused by applyGuide, not silently followed', () => {
  const root = org();
  const before = claudeOf(root);
  const b = build(root);
  const nowhere = join(realpathSync(mkdtempSync(join(tmpdir(), 'org-guide-dangle2-'))), 'does-not-exist.json');
  const guidePath = join(root, '.claude', 'org-workspace', 'guide.json');
  mkdirSync(dirname(guidePath), { recursive: true });
  symlinkSync(nowhere, guidePath);
  assert.throws(() => applyGuide(b, { org: root, stamp: 's-dangle2' }), /symlink/);
  assert.strictEqual(existsSync(nowhere), false, 'the dangling target must not have been created');
  assert.strictEqual(claudeOf(root), before);
});

test('OG-19(a): a symlinked SYSTEM-MAP.md (a real target this run) makes applyGuide throw, CLAUDE.md unchanged', () => {
  const root = org();
  run(root, { edges: [EDGE] });
  const before = claudeOf(root);
  const outside = join(realpathSync(mkdtempSync(join(tmpdir(), 'org-guide-sym2-'))), 'map.md');
  writeFileSync(outside, 'old map');
  unlinkSync(join(root, 'SYSTEM-MAP.md'));
  symlinkSync(outside, join(root, 'SYSTEM-MAP.md'));
  const b = build(root, { edges: [EDGE] });
  assert.throws(() => applyGuide(b, { org: root, stamp: 's-sym3' }), /symlink/);
  assert.strictEqual(claudeOf(root), before);
  assert.strictEqual(readFileSync(outside, 'utf8'), 'old map');
});

test('a DANGLING symlinked SYSTEM-MAP.md is refused, not silently followed', () => {
  const root = org();
  run(root, { edges: [EDGE] });
  const before = claudeOf(root);
  const nowhere = join(realpathSync(mkdtempSync(join(tmpdir(), 'org-guide-dangle3-'))), 'does-not-exist.md');
  unlinkSync(join(root, 'SYSTEM-MAP.md'));
  symlinkSync(nowhere, join(root, 'SYSTEM-MAP.md'));
  const b = build(root, { edges: [EDGE] });
  assert.throws(() => applyGuide(b, { org: root, stamp: 's-dangle3' }), /symlink/);
  assert.strictEqual(existsSync(nowhere), false, 'the dangling target must not have been created');
  assert.strictEqual(claudeOf(root), before);
});

// OG-20/INV-OG-12: a disposable, read-only copy of the real Matchbox guide.json's bytes resolves the
// same repos/forbidden set before and after a no-"--integrations" apply — the real org folder itself
// is only ever opened once, read-only, by the `cp`-equivalent below; no real mbvs-* repo directories
// are checked out, and none are needed (no --integrations means buildGuide's profile() branch never
// runs). Machine-specific: skipped when the real file is not present (matches QA step 7's own wording).
test('OG-20/INV-OG-12: real Matchbox guide.json bytes resolve the same repos/forbidden before and after an apply', async (t) => {
  const REAL = '/Users/adrian/Projects/Matchbox/.claude/org-workspace/guide.json';
  if (!existsSync(REAL)) { t.skip('real guide.json not present on this machine'); return; }
  const { readOrgManifest } = await import('../../quality-kernel/scripts/org.mjs');
  const realBytesBefore = readFileSync(REAL);
  const fix = realpathSync(mkdtempSync(join(tmpdir(), 'inv12-')));
  mkdirSync(join(fix, '.claude', 'org-workspace'), { recursive: true });
  const fixGuidePath = join(fix, '.claude', 'org-workspace', 'guide.json');
  writeFileSync(fixGuidePath, realBytesBefore); // read-only copy; REAL is never opened for writing
  const before = readOrgManifest(fix);
  const beforeSet = { repos: Object.keys(before.repos).sort(), forbidden: [...before.forbidden].sort() };
  const r = spawnSync('node', [cli, '--org', fix, '--guide', fixGuidePath, '--date', '2026-10-26', '--apply'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const after = readOrgManifest(fix);
  const afterSet = { repos: Object.keys(after.repos).sort(), forbidden: [...after.forbidden].sort() };
  assert.deepStrictEqual(afterSet, beforeSet, 'readOrgManifest must resolve the same repos/forbidden before and after the schema-version apply');
  assert.deepStrictEqual(readFileSync(REAL), realBytesBefore, 'the real Matchbox guide.json must never be modified by this verification');
});

// --- buildGuide's step seams (summarizeEdges, stampGuide) ---

test('summarizeEdges counts edges per caller/provider pair, in order of first appearance', () => {
  const edges = [
    { from: 'web', to: 'api' }, { from: 'admin', to: 'api' }, { from: 'web', to: 'api' },
    { from: 'web', to: 'aws' }, { from: 'admin', to: 'api' }, { from: 'web', to: 'api' },
  ];
  assert.deepStrictEqual(summarizeEdges(edges), [
    { from: 'web', to: 'api', n: 3 }, { from: 'admin', to: 'api', n: 2 }, { from: 'web', to: 'aws', n: 1 },
  ]);
  assert.deepStrictEqual(summarizeEdges([]), []);
});

test('summarizeEdges keeps pairs whose names share a prefix apart (a-b -> c is not a -> b-c)', () => {
  assert.deepStrictEqual(summarizeEdges([{ from: 'a-b', to: 'c' }, { from: 'a', to: 'b-c' }]), [
    { from: 'a-b', to: 'c', n: 1 }, { from: 'a', to: 'b-c', n: 1 },
  ]);
});

test('stampGuide always writes version 1 and replaces any proposed summary with the computed pairs', () => {
  const proposal = { org: 'Acme', repos: [], version: 1, summary: [{ from: 'stale', to: 'x', n: 9 }] };
  const pairs = [{ from: 'web', to: 'api', n: 2 }];
  assert.deepStrictEqual(stampGuide(proposal, pairs), { org: 'Acme', repos: [], version: 1, summary: pairs });
  assert.deepStrictEqual(stampGuide({ org: 'Acme' }, []), { org: 'Acme', version: 1, summary: [] });
  assert.strictEqual(proposal.summary[0].from, 'stale', 'the proposal object itself is not mutated');
});

test('stampGuide omits summary entirely when there is nothing to record (pairs === null)', () => {
  const stamped = stampGuide({ org: 'Acme', summary: [{ from: 'stale', to: 'x', n: 9 }] }, null);
  assert.deepStrictEqual(stamped, { org: 'Acme', version: 1 });
  assert.ok(!Object.hasOwn(stamped, 'summary'));
});
