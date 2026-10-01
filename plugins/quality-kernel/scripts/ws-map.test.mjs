import './hermetic-git.mjs';
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { propose } from './ws-propose.mjs';
import { renderSystemMap, normalize } from './ws-map.mjs';

// M2: the integration map the mapper agent proposes is validated against the COMMITTED code of
// both repos (every cited path:line must exist) and rendered from data into SYSTEM-MAP.md.
const gitIn = (dir) => (...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
function write(dir, p, c) { const d = join(dir, p); mkdirSync(dirname(d), { recursive: true }); writeFileSync(d, c); }
const AUTHOR = { name: 't', email: 't@t' };
function org() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'qk-map-')));
  const mk = (name, files) => {
    const dir = join(root, name); mkdirSync(dir);
    const g = gitIn(dir);
    g('init', '-q', '-b', 'development'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
    for (const [p, c] of Object.entries(files)) write(dir, p, c);
    g('add', '-A'); g('commit', '-qm', 'init');
  };
  mk('web', { 'package.json': JSON.stringify({ scripts: { test: 'jest' } }), 'a.test.js': 'x', 'src/api/eventAPI.js': "import axios from 'axios';\nexport const spaces = () => axios.get('/spaces/');\nexport const ghost = () => axios.get('/nowhere/');\n", '.env.production': 'API_URL=x\n' });
  mk('api', { 'package.json': JSON.stringify({ scripts: { test: 'jest' } }), 'a.test.js': 'x', 'spaces/urls.py': "from django.urls import path\nurlpatterns = [\n    path('spaces/', views.Spaces.as_view()),\n]\n" });
  return root;
}
const result = (name) => ({
  name, role: 'app', harnessOf: null, base: 'development', verify: { runner: 'npm-script', script: 'test' },
  productionGlobs: ['src/**'], testGlobs: ['**/*.test.js'], linkPaths: [], criticalGlobs: [], safeGlobs: [],
  localEnv: { state: 'native', proposal: null }, evidence: [{ claim: 'x', at: 'package.json:1' }], notes: [],
});
const EDGE = { from: 'web', to: 'api', kind: 'http', endpoint: 'GET /spaces/', evidence: { from: 'src/api/eventAPI.js:2', to: 'spaces/urls.py:3' }, confidence: 'high', guardable: 'route-exists' };
const UNMATCHED = { from: 'web', endpoint: 'GET /nowhere/', evidence: 'src/api/eventAPI.js:3', reason: 'no route serves it in the selected repos' };
const run = (root, integrations) => propose({ org: root, date: '2026-10-01', results: [result('web'), result('api')], author: AUTHOR, integrations });
const show = (root, rev, path) => { const r = gitIn(join(root, 'workspace'))('show', `${rev}:${path}`); return r.status === 0 ? r.stdout : null; };

test('a valid map is written as integrations.json + SYSTEM-MAP.md on the proposal branch', () => {
  const root = org();
  const r = run(root, { edges: [EDGE], unmatched: [UNMATCHED] });
  const data = JSON.parse(show(root, r.branch, 'integrations.json'));
  assert.deepStrictEqual(data.edges, [{ ...EDGE, check: { from: 'matches', to: 'matches' } }]);
  assert.deepStrictEqual(data.unmatched, [UNMATCHED]);
  assert.match(data.repos.web.sha, /^[0-9a-f]{40}$/);
  const md = show(root, r.branch, 'SYSTEM-MAP.md');
  assert.match(md, /r1\["web"\] -->\|"http 1"\| r0\["api"\]/);
  assert.match(md, /1 of 1 connections are ✓ on both sides/);
  assert.match(md, /\| web \| api \| 1 \(http 1\) \| 1 \|/);
  assert.match(md, /\| http \| `GET \/spaces\/` \| high \| route-exists \| ✓ `src\/api\/eventAPI\.js:2` \| ✓ `spaces\/urls\.py:3` \|/);
  assert.match(md, /\| web \| `GET \/nowhere\/` \| `src\/api\/eventAPI\.js:3` \| no route serves it in the selected repos \|/);
  assert.strictEqual(show(root, 'main', 'SYSTEM-MAP.md'), null, 'main untouched');
});

test('without integrations nothing about the map is written (M1 behaviour unchanged)', () => {
  const root = org();
  const r = run(root, null);
  assert.strictEqual(show(root, r.branch, 'integrations.json'), null);
  assert.strictEqual(show(root, r.branch, 'SYSTEM-MAP.md'), null);
});

// The anti-hallucination rule: a citation must point at a real committed line of the right repo.
for (const [name, edge, re] of [
  ['a line past the end of the file', { ...EDGE, evidence: { ...EDGE.evidence, to: 'spaces/urls.py:40' } }, /has 4 line\(s\)/],
  ['a file that does not exist', { ...EDGE, evidence: { ...EDGE.evidence, from: 'src/api/madeUp.js:1' } }, /not a committed, readable file of web/],
  ['the provider line cited in the caller repo', { ...EDGE, evidence: { ...EDGE.evidence, to: 'src/api/eventAPI.js:2' } }, /not a committed, readable file of api/],
  ['a .env file, even committed', { ...EDGE, evidence: { ...EDGE.evidence, from: '.env.production:1' } }, /not a committed, readable file/],
  ['a path with ..', { ...EDGE, evidence: { ...EDGE.evidence, from: '../api/spaces/urls.py:3' } }, /must be "path:line"/],
  ['line 0 / no line', { ...EDGE, evidence: { ...EDGE.evidence, from: 'src/api/eventAPI.js:0' } }, /must be "path:line"/],
  ['an unselected repo', { ...EDGE, to: 'billing' }, /"billing" is not a selected repo/],
  ['a self edge', { ...EDGE, to: 'web', evidence: { from: 'src/api/eventAPI.js:2', to: 'src/api/eventAPI.js:2' } }, /two different repos/],
  ['an unknown kind', { ...EDGE, kind: 'magic' }, /kind must be one of/],
  ['an unknown confidence', { ...EDGE, confidence: 'certain' }, /confidence must be one of/],
  ['an unsupported guardable seam type', { ...EDGE, guardable: 'schema' }, /guardable must be/],
  ['an unknown key', { ...EDGE, trusted: true }, /unknown key "trusted"/],
  ['a multi-line endpoint', { ...EDGE, endpoint: 'GET /a\n## injected' }, /single-line string/],
  ['a secret in a note', { ...EDGE, note: `token ${'ghp_' + 'a'.repeat(30)}` }, /secret-looking/],
]) {
  test(`refused, nothing written: ${name}`, () => {
    const root = org();
    assert.throws(() => run(root, { edges: [edge], unmatched: [] }), re);
    assert.strictEqual(existsSync(join(root, 'workspace')), false);
  });
}

test('refused: a worktree-only edit cannot back a citation (the committed base is what counts)', () => {
  const root = org();
  writeFileSync(join(root, 'api', 'spaces', 'urls.py'), 'x\n'.repeat(50));
  assert.doesNotThrow(() => run(root, { edges: [EDGE], unmatched: [] }));
  const root2 = org();
  writeFileSync(join(root2, 'api', 'spaces', 'urls.py'), 'x\n'.repeat(50));
  assert.throws(() => run(root2, { edges: [{ ...EDGE, evidence: { ...EDGE.evidence, to: 'spaces/urls.py:40' } }], unmatched: [] }), /has 4 line\(s\)/);
});

test('refused: malformed integrations objects', () => {
  for (const [bad, re] of [[[], /must be an object/], [{ edges: {} }, /must be arrays/], [{ edges: [], extra: 1 }, /unknown key/], [{ edges: [], unmatched: [{ ...UNMATCHED, evidence: 'src/api/eventAPI.js:99' }] }, /has 3 line\(s\)/]]) {
    assert.throws(() => run(org(), bad), re);
  }
});

test('rendering is deterministic and escapes table/code-span breakers', () => {
  const repos = { web: { base: 'development', sha: 'a'.repeat(40) }, api: { base: 'development', sha: 'b'.repeat(40) } };
  const e2 = { ...EDGE, endpoint: 'POST /x|y `z`', guardable: null };
  const a = renderSystemMap({ date: 'd', branch: 'init/d', repos, ...normalize({ edges: [EDGE, e2], unmatched: [UNMATCHED] }) });
  const b = renderSystemMap({ date: 'd', branch: 'init/d', repos, ...normalize({ edges: [e2, EDGE], unmatched: [UNMATCHED] }) });
  assert.strictEqual(a, b);
  assert.match(a, /`POST \/x\\\|y 'z'`/);
  assert.match(renderSystemMap({ date: 'd', branch: 'b', repos, edges: [], unmatched: [] }), /No connection between the selected repos was found/);
});

// Round-1 critic #1: a line that exists is not the right line. Blank and empty-file lines are
// refused; an in-range but unrelated line is accepted and labelled `exists` (~), never `matches` (✓).
function org2(extraApi = {}) {
  const root = org();
  const dir = join(root, 'api');
  for (const [p, c] of Object.entries(extraApi)) write(dir, p, c);
  gitIn(dir)('add', '-A'); gitIn(dir)('commit', '-qm', 'more');
  return root;
}
test('a blank cited line and a line of an empty file are refused', () => {
  const root = org2({ 'blank.py': 'x = 1\n\ny = 2\n', 'empty/__init__.py': '' });
  assert.throws(() => run(root, { edges: [{ ...EDGE, evidence: { ...EDGE.evidence, to: 'blank.py:2' } }] }), /that line is blank/);
  assert.throws(() => run(org2({ 'empty/__init__.py': '' }), { edges: [{ ...EDGE, evidence: { ...EDGE.evidence, to: 'empty/__init__.py:1' } }] }), /has 0 line\(s\)/);
});

test('an unrelated but existing line is accepted as `exists` (~), and the report says so', () => {
  const root = org();
  const r = run(root, { edges: [{ ...EDGE, evidence: { from: 'package.json:1', to: 'spaces/urls.py:1' } }] });
  const data = JSON.parse(show(root, r.branch, 'integrations.json'));
  assert.deepStrictEqual(data.edges[0].check, { from: 'exists', to: 'exists' });
  const md = show(root, r.branch, 'SYSTEM-MAP.md');
  assert.match(md, /\| ~ `package\.json:1` \| ~ `spaces\/urls\.py:1` \|/);
  assert.match(md, /0 of 1 connections are ✓ on both sides/);
});

test('the last line of a file without a trailing newline can be cited', () => {
  const root = org2({ 'nonl.py': "x = 1\npath('spaces/', v)" });
  assert.doesNotThrow(() => run(root, { edges: [{ ...EDGE, evidence: { ...EDGE.evidence, to: 'nonl.py:2' } }] }));
  assert.throws(() => run(org2({ 'nonl.py': "x = 1\npath('spaces/', v)" }), { edges: [{ ...EDGE, evidence: { ...EDGE.evidence, to: 'nonl.py:3' } }] }), /has 2 line\(s\)/);
});

test('a directory or a submodule cannot be cited', () => {
  assert.throws(() => run(org(), { edges: [{ ...EDGE, evidence: { ...EDGE.evidence, to: 'spaces:1' } }] }), /not a committed, readable file/);
  const root = org();
  const api = join(root, 'api');
  gitIn(api)('update-index', '--add', '--cacheinfo', `160000,${gitIn(api)('rev-parse', 'HEAD').stdout.trim()},vendor-sub`);
  gitIn(api)('commit', '-qm', 'submodule');
  assert.throws(() => run(root, { edges: [{ ...EDGE, evidence: { ...EDGE.evidence, to: 'vendor-sub:1' } }] }), /not a committed, readable file/);
});

// Round-1 critic #2/#3/#5: secrets the shared scan missed, path:line text that looks checked, HTML.
test('free text: quoted secret values, path:line references and bidi controls are refused', () => {
  for (const [note, re] of [
    ["sends x-api-key 'Zq8vT2mKpL9xR4wN7bY3cF6hJ1'", /secret-looking/],
    ["SECRET_KEY = 'django-insecure-9xk2mpq7'", /secret-looking/],
    ['reads ‮lmth.x', /single-line string/],
  ]) assert.throws(() => run(org(), { edges: [{ ...EDGE, note }] }), re, note);
});

test('free text keeps file names but loses line numbers, so nothing unchecked looks like a citation', () => {
  const root = org();
  const r = run(root, { edges: [{ ...EDGE, note: 'body read at views.py:497 and emailScheduleFire.ts:30-37' }], unmatched: [{ ...UNMATCHED, reason: 'see urls.py:12' }] });
  const data = JSON.parse(show(root, r.branch, 'integrations.json'));
  assert.strictEqual(data.edges[0].note, 'body read at views.py and emailScheduleFire.ts');
  assert.strictEqual(data.unmatched[0].reason, 'see urls.py');
  assert.strictEqual(data.edges[0].evidence.from, EDGE.evidence.from, 'real citations are untouched');
});

test('free text is rendered as plain text: no links, images or HTML; code spans stay literal', () => {
  const root = org();
  const r = run(root, { edges: [{ ...EDGE, endpoint: 'GET /spaces/<int:pk>/', note: 'see [the contract](https://evil.example) <img src=https://evil/px.gif>' }] });
  const md = show(root, r.branch, 'SYSTEM-MAP.md');
  assert.ok(!md.includes('<img'), md);
  assert.doesNotMatch(md, /[^\\]\]\(https:\/\/evil/, 'the link is escaped, not rendered');
  assert.match(md, /\\\[the contract\\\]\(https:\/\/evil\.example\)/);
  assert.match(md, /&lt;img src=https:\/\/evil\/px\.gif&gt;/);
  assert.match(md, /`GET \/spaces\/<int:pk>\/`/, 'code spans keep < > literal');
});

test('duplicate edges are refused; every kind and guardable value is accepted', () => {
  assert.throws(() => run(org(), { edges: [EDGE, { ...EDGE }] }), /duplicate edge/);
  const edges = ['http', 'ws', 'webhook', 'queue', 'shared-db', 'doc'].map((kind, i) => ({ ...EDGE, kind, endpoint: `GET /spaces/${i}/`, guardable: i % 2 ? 'fields' : null }));
  const root = org();
  const r = run(root, { edges });
  assert.strictEqual(JSON.parse(show(root, r.branch, 'integrations.json')).edges.length, 6);
});

test('mermaid ids never collide (a-b and a_b are different repos)', () => {
  const repos = { 'a-b': { base: 'm', sha: 'a'.repeat(40) }, a_b: { base: 'm', sha: 'b'.repeat(40) } };
  const md = renderSystemMap({ date: 'd', branch: 'b', repos, ...normalize({ edges: [{ ...EDGE, from: 'a-b', to: 'a_b' }], unmatched: [] }) });
  assert.match(md, /r0\["a-b"\] -->\|"http 1"\| r1\["a_b"\]/);
});

test('CLI: --integrations is read and validated (a bad citation exits 2, nothing written)', async () => {
  const { fileURLToPath } = await import('node:url');
  const cli = join(dirname(fileURLToPath(import.meta.url)), 'ws-propose.mjs');
  const root = org();
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'qk-map-cli-')));
  writeFileSync(join(tmp, 'results.json'), JSON.stringify([result('web'), result('api')]));
  writeFileSync(join(tmp, 'bad.json'), JSON.stringify({ edges: [{ ...EDGE, evidence: { ...EDGE.evidence, to: 'spaces/urls.py:99' } }] }));
  writeFileSync(join(tmp, 'good.json'), JSON.stringify({ edges: [EDGE] }));
  const bad = spawnSync('node', [cli, '--org', root, '--date', '2026-10-01', '--results', join(tmp, 'results.json'), '--integrations', join(tmp, 'bad.json')], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  assert.strictEqual(bad.status, 2, bad.stdout);
  assert.match(bad.stderr, /has 4 line\(s\)/);
  assert.strictEqual(existsSync(join(root, 'workspace')), false);
  const good = spawnSync('node', [cli, '--org', root, '--date', '2026-10-01', '--results', join(tmp, 'results.json'), '--integrations', join(tmp, 'good.json')], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  assert.strictEqual(good.status, 0, good.stderr);
  assert.ok(show(root, JSON.parse(good.stdout).branch, 'SYSTEM-MAP.md'));
});
