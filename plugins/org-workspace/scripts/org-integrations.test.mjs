import './hermetic-git.mjs';
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extract } from './org-integrations.mjs';

// Phase 2 (deterministic part) of /org-init: integration signals of ONE repo from its
// committed base, each with path:line — never the worktree, never .env/key files, nothing executed.
const here = dirname(fileURLToPath(import.meta.url));
const gitIn = (dir) => (...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
function write(dir, p, c) { const d = join(dir, p); mkdirSync(dirname(d), { recursive: true }); writeFileSync(d, c); }
function repo(files) {
  const dir = join(realpathSync(mkdtempSync(join(tmpdir(), 'qk-int-'))), 'r');
  mkdirSync(dir);
  const git = gitIn(dir);
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  for (const [p, c] of Object.entries(files)) write(dir, p, c);
  git('add', '-A'); git('commit', '-qm', 'init');
  return { dir, git };
}
const pkg = (o) => JSON.stringify(o);
const by = (list, k, v) => list.filter((x) => x[k] === v);

test('Django: path()/re_path() routes and include() lines, with path:line; test files are flagged', () => {
  const { dir } = repo({
    'manage.py': '', 'requirements.txt': 'django\n',
    'events/urls.py': "from django.urls import path, include\nurlpatterns = [\n    path('get_event_from_frontend/<sub>/', views.X.as_view()),\n    re_path(r'^old/$', views.Y),\n    path('api/', include('api.urls')),\n]\n",
    'backend/test_urls.py': "urlpatterns = [path('only-in-tests/', v)]\n",
  });
  const r = extract({ dir });
  const routes = by(r.inbound, 'kind', 'django').map((x) => [x.route, x.at, x.test]).sort((a, b) => a[1].localeCompare(b[1]));
  assert.deepStrictEqual(routes, [['only-in-tests/', 'backend/test_urls.py:1', true], ['get_event_from_frontend/<sub>/', 'events/urls.py:3', false], ['^old/$', 'events/urls.py:4', false], ['api/', 'events/urls.py:5', false]]);
});

test('serverless: `path:` is a route only in a Serverless Framework repo', () => {
  const sls = repo({ 'package.json': pkg({ devDependencies: { serverless: '3' } }), 'serverless.ts': '', 'app/handlers/stats.ts': "events: [{ http: {\n  method: 'get',\n  path: `${AWS_API_VERSION}/email-stats/{schema}/{id}`,\n} }]\n" });
  assert.deepStrictEqual(extract({ dir: sls.dir }).inbound.map((x) => [x.kind, x.route, x.at]), [['serverless', '${AWS_API_VERSION}/email-stats/{schema}/{id}', 'app/handlers/stats.ts:3']]);
  const spa = repo({ 'package.json': pkg({ dependencies: { react: '18' } }), 'src/routes.js': "export default [{ path: '/landing', component: L }];\n" });
  assert.deepStrictEqual(extract({ dir: spa.dir }).inbound, [], 'a React Router `path:` is not an inbound API route');
});

test('Next.js pages/api and app/api routes, and Express routes', () => {
  const { dir } = repo({
    'package.json': pkg({ dependencies: { next: '14', express: '4' } }),
    'pages/api/aws/s3.ts': 'export default h;', 'pages/api/landing/index.js': 'x', 'src/app/api/health/route.ts': 'x',
    'server.js': "app.get('/status', h);\nrouter.post(`/hooks/sendgrid`, h);\nobj.get(key);\n",
  });
  const r = extract({ dir });
  assert.deepStrictEqual(by(r.inbound, 'kind', 'next-api').map((x) => [x.route, x.at]).sort(), [['/api/aws/s3', 'pages/api/aws/s3.ts:1'], ['/api/health', 'src/app/api/health/route.ts:1'], ['/api/landing', 'pages/api/landing/index.js:1']]);
  assert.deepStrictEqual(by(r.inbound, 'kind', 'express').map((x) => [x.route, x.at]), [['/status', 'server.js:1'], ['/hooks/sendgrid', 'server.js:2']]);
});

test('outbound: HTTP calls with a path or URL; dict .get() and calls outside a path are ignored; tests skipped', () => {
  const { dir } = repo({
    'src/api/eventAPI.js': "export const a = () => expoHallAPI().get('/spaces/');\nexport const b = () => axios.post(`${BASE}/register/`, body);\nconst c = cfg.get('timeout');\nconst d = map.get(key);\nfetch('https://api.example.com/v1/x');\n",
    'svc/client.py': "import requests\nresp = requests.get(f'{settings.AWS_API_URL}/email-stats/{s}/{i}')\nx = data.get('field')\nrequests.post(url, json=b)\n",
    'src/api/eventAPI.test.js': "axios.get('/only-in-tests/');\n",
  });
  const http = by(extract({ dir }).outbound, 'kind', 'http').map((x) => [x.target, x.at]);
  assert.deepStrictEqual(http, [['/spaces/', 'src/api/eventAPI.js:1'], ['${BASE}/register/', 'src/api/eventAPI.js:2'], ['https://api.example.com/v1/x', 'src/api/eventAPI.js:5'], ['{settings.AWS_API_URL}/email-stats/{s}/{i}', 'svc/client.py:2']]);
});

test('outbound: URLs composed from a service base before the call (f-string, template, concatenation)', () => {
  const { dir } = repo({
    'helpers/pull.py': "url = f'{settings.AWS_API_URL}/analytics/gettilesclicksbyuser'\nresponse = requests.get(url)\n",
    'pages/api/analytics.ts': "const u = `${AWS_MBVS_API_URL}/analytics/x?e=${e}`;\nconst v = API_URL + '/users/';\n",
  });
  const urls = by(extract({ dir }).outbound, 'kind', 'url').map((x) => [x.base, x.target, x.at]);
  assert.deepStrictEqual(urls, [['settings.AWS_API_URL', '/analytics/gettilesclicksbyuser', 'helpers/pull.py:1'], ['AWS_MBVS_API_URL', '/analytics/x?e=${e}', 'pages/api/analytics.ts:1'], ['API_URL', '/users/', 'pages/api/analytics.ts:2']]);
});

test('serviceEnv: names (never values) of env/settings pointing at another service; contracts listed', () => {
  const { dir } = repo({
    'src/config.js': "export const api = process.env.REACT_APP_AWS_API_URL;\nconst k = process.env.REACT_APP_STRIPE_KEY;\n",
    'backend/settings.py': "AWS_API_URL = os.environ.get('AWS_API_URL')\nDEBUG = os.getenv('DEBUG')\nx = settings.LANDING_CDN_HOSTS\n",
    'specs/landing/CONTRACT.md': '# c', 'docs/openapi.yaml': 'openapi: 3', 'static2/rest_framework_swagger/swagger-ui.json': '{}',
  });
  const r = extract({ dir });
  assert.deepStrictEqual(r.serviceEnv.map((x) => [x.name, x.at]), [['AWS_API_URL', 'backend/settings.py:1'], ['LANDING_CDN_HOSTS', 'backend/settings.py:3'], ['REACT_APP_AWS_API_URL', 'src/config.js:1']].sort((a, b) => a[1].localeCompare(b[1])));
  assert.deepStrictEqual(r.contracts.sort(), ['docs/openapi.yaml', 'specs/landing/CONTRACT.md']);
});

test('reads the committed base only: worktree edits, .env files and node_modules never appear', () => {
  const { dir } = repo({
    'src/a.js': "axios.get('/committed/');\n", '.env.production': 'API_URL=https://secret.example.com\n',
    'node_modules/dep/index.js': "axios.get('/from-node-modules/');\n", 'config/.env.dev': "fetch('/env-file/')\n",
  });
  writeFileSync(join(dir, 'src/a.js'), "axios.get('/worktree-only/');\n");
  const r = extract({ dir });
  assert.deepStrictEqual(r.outbound.map((x) => x.target), ['/committed/']);
  assert.ok(!JSON.stringify(r).includes('secret.example.com'));
});

test('secret-looking values on a cited line are redacted', () => {
  const tok = 'ghp_' + 'a'.repeat(30);
  const { dir } = repo({ 'src/a.js': `axios.get('/x/', { headers: { Authorization: '${tok}' } });\n` });
  const line = extract({ dir }).outbound[0].text;
  assert.ok(!line.includes(tok), line);
  assert.match(line, /<redacted>/);
});

test('CLI prints the signals JSON; a missing repo is exit 2', () => {
  const { dir } = repo({ 'src/a.js': "axios.get('/x/');\n" });
  const ok = spawnSync('node', [join(here, 'org-integrations.mjs'), '--repo', dir], { encoding: 'utf8' });
  assert.strictEqual(ok.status, 0, ok.stderr);
  assert.strictEqual(JSON.parse(ok.stdout).outbound[0].at, 'src/a.js:1');
  const bad = spawnSync('node', [join(here, 'org-integrations.mjs'), '--repo', join(dir, 'nope')], { encoding: 'utf8' });
  assert.strictEqual(bad.status, 2);
});

test('commented-out routes and calls are not signals (Python #, JS // and block comments)', () => {
  const { dir } = repo({
    'manage.py': '', 'users/urls.py': "urlpatterns = [\n    # path('old-login/', v),\n    path('login/', v),\n]\n",
    'src/a.js': "// axios.get('/dead/');\n/* fetch('/dead2/') */\n * axios.post('/dead3/')\naxios.get('/live/');\n",
  });
  const r = extract({ dir });
  assert.deepStrictEqual(r.inbound.map((x) => x.route), ['login/']);
  assert.deepStrictEqual(r.outbound.map((x) => x.target), ['/live/']);
});

// QA round-1 HIGH: the extractor's own isSensitive filter (not just the pathspec) must hold.
test('a sensitive-named file with a code extension is never a signal (e.g. credentials_urls.py)', () => {
  const { dir } = repo({ 'manage.py': '', 'events/credentials_urls.py': "urlpatterns = [path('leak/', v)]\n", 'events/urls.py': "urlpatterns = [path('ok/', v)]\n" });
  assert.deepStrictEqual(extract({ dir }).inbound.map((x) => x.at), ['events/urls.py:1']);
});

// Critic round-1 #4: a path containing ":<n>:" must not shift the parse past isSensitive.
test('a path containing ":1:" is parsed whole, so its sensitive basename is still dropped', () => {
  const { dir } = repo({ 'x:1:/credentials.js': "axios.get('/leak/');\n", 'ok:2:/a.js': "axios.get('/ok/');\n" });
  assert.deepStrictEqual(extract({ dir }).outbound.map((x) => [x.target, x.at]), [['/ok/', 'ok:2:/a.js:1']]);
});

// Critic round-1 #2: the shared redact only knew NAME=value; source lines carry more.
test('cited lines: quoted values next to key/token/secret names, Bearer tokens and high-entropy literals are redacted', () => {
  const lines = {
    "fetch('/a/', { headers: { 'x-api-key': 'Zq8vT2mKpL9xR4wN7bY3cF6hJ1' } });": 'Zq8vT2mKpL9xR4wN7bY3cF6hJ1',
    "axios.get('/b/', { headers: { Authorization: 'Bearer abcdefghijklmnop' } });": 'abcdefghijklmnop',
    "axios.post('/c/', { password: 'hunter2hunter2' });": 'hunter2hunter2',
    "axios.get('/d/' + 'AbCdEfGhIjKlMnOpQrSt1234');": 'AbCdEfGhIjKlMnOpQrSt1234',
  };
  const { dir } = repo({ 'src/a.js': Object.keys(lines).join('\n') + '\n' });
  const out = extract({ dir }).outbound.map((x) => x.text).join('\n');
  for (const secret of Object.values(lines)) assert.ok(!out.includes(secret), `${secret} leaked: ${out}`);
  assert.match(out, /axios\.get\('\/b\/'/, 'paths are kept');
});
