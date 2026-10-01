#!/usr/bin/env node
// /org-init (deterministic part) — integration signals of ONE repo, read from its
// committed base branch with `git grep` / `git ls-tree` on the base commit (never the worktree;
// .env* and key files are never searched). Each signal carries `at: "path:line"` so the
// integration-mapper agent can cite it, and org-guide can check every cited line exists.
//   inbound     routes the repo serves: Django path()/re_path() (include() lines too, raw — prefixes
//               are composed by the agent), serverless `path:`, Next.js pages/api + app/api,
//               Express app/router.METHOD
//   outbound    HTTP calls with a literal or template path: axios/fetch/requests/httpx and
//               `<client>.get|post|put|patch|delete('/...')`
//   serviceEnv  env / settings NAMES that point at another service (*_URL, *_HOST, *_API*, ...)
//   contracts   CONTRACT*.md, OpenAPI / Swagger specs (vendored UI bundles excluded)
// Nothing is executed. Env VALUES are never read (only names). Each signal carries its committed
// source line, cut to 240 characters and redacted: quoted values next to key/token/secret/password/
// auth names, Bearer tokens, known token formats and long high-entropy quoted literals are replaced
// by <redacted>. That is best effort — the agent may Read the file anyway — so the signal files are
// written to a scratch dir only, never into any repo.
//
// Usage: org-integrations.mjs --repo <dir> [--base <branch>]
// Report only: nothing here is enforced.

import { basename } from 'node:path';
import { git } from './safe-git.mjs';
import { isEntrypoint } from './entrypoint.mjs';
import { profile, redact, isSensitive } from './org-profile.mjs';

const MAX_PER_KIND = 1500;
const MAX_TEXT = 240;
const SKIP_DIRS = ['node_modules', 'vendor', 'dist', 'build', 'static', 'static2', 'staticfiles', 'coverage', '.next', 'site-packages', '.venv', 'venv', '__pycache__'];
const EXCLUDES = SKIP_DIRS.map((d) => `:(exclude,glob)**/${d}/**`).concat([':(exclude,glob)**/*.min.js', ':(exclude,glob)**/*.bundle.js', ':(exclude,glob)**/*.map']);
const CODE = ['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'py'].map((e) => `:(glob)**/*.${e}`);
const TEST_PATH = /(^|\/)(tests?|__tests__|e2e|cypress|playwright|fixtures?|mocks?|__mocks__)\/|\.(test|spec)\.[a-z]+$|(^|\/)(test_[^/]*|tests?(_[^/]*)?|[^/]*_tests?)\.py$/i;

// One `git grep -n` on the base commit; returns [{ path, line, text }].
function grep(dir, sha, pattern, pathspecs) {
  // -z: path, line number and text are NUL-separated, so a path containing ":<n>:" cannot shift the
  // parse (and slip a sensitive basename past isSensitive).
  const r = git(dir, ['grep', '-n', '-z', '-I', '-E', '-e', pattern, sha, '--', ...pathspecs, ...EXCLUDES], { maxBuffer: 64 * 1024 * 1024 });
  if (r.status === 1) return [];
  if (r.status !== 0) throw new Error(`git grep failed in ${dir}: ${(r.stderr || '').trim()}`);
  const out = [];
  const prefix = `${sha}:`;
  for (const raw of r.stdout.split('\n')) {
    if (!raw.startsWith(prefix)) continue;
    const m = /^([^\0]+)\0(\d+)\0(.*)$/.exec(raw.slice(prefix.length));
    if (!m || isSensitive(m[1])) continue;
    if (/^\s*(#|\/\/|\/\*|\*|<!--)/.test(m[3])) continue; // a commented-out route or call is not live
    out.push({ path: m[1], line: Number(m[2]), text: redactLine(m[3].trim()).slice(0, MAX_TEXT) });
  }
  return out;
}
const at = (h) => `${h.path}:${h.line}`;
// Stronger than org-profile redact (which only knows NAME=value): what a source line can carry.
const SECRETISH = String.raw`(?:[A-Za-z0-9_-]*(?:key|token|secret|passw(?:or)?d|pwd|auth(?:orization)?|credential|api[-_]?key|session|cookie)[A-Za-z0-9_-]*)`;
const QUOTED_AFTER_SECRET_NAME = new RegExp(String.raw`(['"\`]?${SECRETISH}['"\`]?\s*[:=]\s*)(['"\`])([^'"\`]{4,})\2`, 'gi');
const BEARER = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/g;
// A quoted literal of >= 20 token characters with letters AND digits and no path separator.
const HIGH_ENTROPY = /(['"`])(?=[A-Za-z0-9+_=-]*[0-9])(?=[A-Za-z0-9+_=-]*[A-Za-z])[A-Za-z0-9+_=-]{20,}\1/g;
const VALUE_REDACTIONS = (t) => t
  .replace(QUOTED_AFTER_SECRET_NAME, (m, pre, q) => `${pre}${q}<redacted>${q}`)
  .replace(BEARER, '$1 <redacted>')
  .replace(HIGH_ENTROPY, '$1<redacted>$1');
// Free text (an agent's note): a quoted secret value, a Bearer token or a high-entropy literal.
export const hasValueSecret = (text) => { const t = String(text).slice(0, 400); return VALUE_REDACTIONS(t) !== t; };
export const redactLine = (line) => VALUE_REDACTIONS(redact(line.slice(0, 400)));
const firstQuoted = (s) => { const m = /[`'"]([^`'"]*)[`'"]/.exec(s); return m ? m[1] : null; };
const cap = (list) => list.slice(0, MAX_PER_KIND);

export function extract({ dir, base } = {}) {
  const p = profile({ dir, base }); // same guards: top-level work tree, base resolution, committed tree
  const { sha } = p;
  const files = git(dir, ['ls-tree', '-r', '-z', '--name-only', '--full-tree', '--end-of-options', sha]).stdout.split('\0').filter(Boolean);
  const inbound = [];
  for (const h of grep(dir, sha, String.raw`(^|[^a-z_])(re_)?path\(|include\(`, [':(glob)**/*urls.py'])) {
    inbound.push({ kind: /include\(/.test(h.text) && !/(re_)?path\(/.test(h.text) ? 'django-include' : 'django', route: firstQuoted(h.text), at: at(h), text: h.text, test: TEST_PATH.test(h.path) });
  }
  // `path:` means an HTTP route only in a Serverless Framework repo (elsewhere it is e.g. a React Router route).
  const isServerless = p.stack.frameworks.includes('serverless');
  for (const h of isServerless ? grep(dir, sha, String.raw`(^|[^a-z_])path:[[:space:]]*[\`'"]`, [':(glob)**/*.ts', ':(glob)**/*.js', ':(glob)**/serverless.yml', ':(glob)**/serverless.yaml']) : []) {
    inbound.push({ kind: 'serverless', route: firstQuoted(h.text.slice(h.text.indexOf('path:'))), at: at(h), text: h.text, test: TEST_PATH.test(h.path) });
  }
  for (const h of grep(dir, sha, String.raw`(^|[^a-zA-Z_])(app|router)\.(get|post|put|patch|delete|all|use)\([[:space:]]*[\`'"]/`, CODE)) {
    inbound.push({ kind: 'express', route: firstQuoted(h.text), at: at(h), text: h.text, test: TEST_PATH.test(h.path) });
  }
  for (const f of files) {
    const m = /^(?:src\/)?pages\/api\/(.+)\.(?:js|jsx|ts|tsx)$/.exec(f) || /^(?:src\/)?app\/api\/(.+)\/route\.(?:js|ts)$/.exec(f);
    if (m && !isSensitive(f)) inbound.push({ kind: 'next-api', route: `/api/${m[1].replace(/(^|\/)index$/, '')}`, at: `${f}:1`, text: f, test: false });
  }
  const outbound = [];
  for (const h of grep(dir, sha, String.raw`(axios(\.[a-z]+)?|fetch|requests\.[a-z]+|httpx\.[a-z]+|\.(get|post|put|patch|delete|request))\([[:space:]]*(f?[\`'"]|[A-Za-z_][A-Za-z0-9_.]*[[:space:]]*\+)`, CODE)) {
    if (TEST_PATH.test(h.path)) continue;
    // Python: only real HTTP clients (a bare `.get(` is a dict lookup). JS: the first argument must
    // look like a URL or path (`/x`, `http…`, `${BASE}/x`) or be built by concatenation.
    if (h.path.endsWith('.py') && !/\b(requests|httpx|session|client)\.(get|post|put|patch|delete|request)\(/.test(h.text)) continue;
    const target = firstQuoted(h.text);
    const looksLikePath = target !== null && /^(\/|https?:|\$\{|\{)/.test(target);
    if (!looksLikePath && !/\(\s*[A-Za-z_][A-Za-z0-9_.]*\s*\+/.test(h.text) && !/\(\s*f['"]/.test(h.text)) continue;
    outbound.push({ kind: 'http', target, at: at(h), text: h.text });
  }
  // URLs composed from a service base and a path, built before the call (`url = f'{settings.AWS_API_URL}/x'`,
  // `${BASE_URL}/x`, `API_URL + '/x'`): the call site then only passes a variable.
  const seen = new Set([...outbound, ...inbound.filter((i) => i.kind !== 'next-api')].map((o) => o.at)); // next-api cites line 1 as a file marker
  for (const h of grep(dir, sha, String.raw`\{[A-Za-z_.]*(URL|URI|HOST|BASE|API|ENDPOINT)[A-Za-z0-9_]*\}/[A-Za-z_{$]|(URL|URI|BASE|ENDPOINT)[A-Za-z0-9_]*[)]?[[:space:]]*\+[[:space:]]*[\`'"]/`, CODE)) {
    if (TEST_PATH.test(h.path) || seen.has(at(h))) continue;
    const m = /\{([A-Za-z_.]*(?:URL|URI|HOST|BASE|API|ENDPOINT)[A-Za-z0-9_]*)\}(\/[^`'"\s]*)/.exec(h.text) || /((?:[A-Za-z_.]*)(?:URL|URI|BASE|ENDPOINT)[A-Za-z0-9_]*)\)?\s*\+\s*[`'"](\/[^`'"]*)/.exec(h.text);
    outbound.push({ kind: 'url', base: m ? m[1] : null, target: m ? m[2] : null, at: at(h), text: h.text });
  }
  const serviceEnv = [];
  const ENV = /(?:process\.env\.|process\.env\[['"]|os\.environ(?:\.get)?[[(]\s*['"]|os\.getenv\(\s*['"]|settings\.)([A-Z][A-Z0-9_]*(?:URL|URI|HOST|HOSTNAME|API|API_[A-Z0-9_]*|DOMAIN|ENDPOINT|BASE)[A-Z0-9_]*)/g;
  for (const h of grep(dir, sha, String.raw`(process\.env|os\.environ|os\.getenv|settings\.)`, CODE)) {
    if (TEST_PATH.test(h.path)) continue;
    for (const m of h.text.matchAll(ENV)) serviceEnv.push({ name: m[1], at: at(h) });
  }
  const contracts = files.filter((f) => !SKIP_DIRS.some((d) => f.split('/').includes(d)) && !isSensitive(f)
    && (/(^|\/)CONTRACT[^/]*\.md$/i.test(f) || /(^|\/)(openapi|swagger)[^/]*\.(ya?ml|json)$/i.test(f)));
  return {
    name: basename(dir), base: p.base, sha,
    inbound: cap(inbound), outbound: cap(outbound), serviceEnv: cap(serviceEnv), contracts: contracts.slice(0, 200),
    truncated: [inbound, outbound, serviceEnv].some((l) => l.length > MAX_PER_KIND),
  };
}

if (isEntrypoint(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n) => { const i = args.indexOf(n); return i === -1 ? undefined : args[i + 1]; };
  try { process.stdout.write(JSON.stringify(extract({ dir: opt('--repo'), base: opt('--base') }), null, 2) + '\n'); }
  catch (e) { process.stderr.write(`${e.message}\n`); process.exit(2); }
}
