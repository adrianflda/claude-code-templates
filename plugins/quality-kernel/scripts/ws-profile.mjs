#!/usr/bin/env node
// /init-workspace phase 1 (deterministic part) — facts about ONE repo, read from its committed base
// branch (ls-tree + hash-verified blobs), never from the worktree. The contents of .env files and
// key material are never read; their committed paths are reported so a human can act on them.
// Judgment (role, verify command, globs, critical surface) is the repo-profiler agent's job; this
// script gives it verifiable facts to start from.
//
// Usage: ws-profile.mjs --repo <dir> [--base <branch>]
// Prints the profile JSON. Spec: docs/agentic-harness/spec-init-workspace.v1.md §4 phases 1/1a.

import { existsSync, realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { git, readVerifiedBlob } from './safe-git.mjs';
import { isEntrypoint } from './entrypoint.mjs';

const BASE_PREFERENCE = ['development', 'dev', 'develop', 'staging', 'main', 'master'];
// Files whose contents are never read; their committed paths are reported for a human to act on.
const SENSITIVE_BASENAME = [
  /^\.env(\..*)?$/i, /^\.envrc$/i, /\.(pem|key|p12|pfx|p8|keystore|jks|tfvars)$/i, /credentials/i, /accesskeys/i,
  /recovery-codes/i, /^id_(rsa|dsa|ecdsa|ed25519)/i, /^secrets?\.(json|ya?ml|env|txt|toml)$/i, /service-account.*\.json$/i,
  /project_key.*\.json$/i, /adminsdk.*\.json$/i, /^\.npmrc$/i, /^\.pgpass$/i, /^\.netrc$/i, /^kubeconfig/i,
];
const isSensitive = (p) => /(^|\/)\.aws\//.test(p) || SENSITIVE_BASENAME.some((re) => re.test(p.split('/').pop()));
// Redact secret-looking values in command strings copied into the profile (e.g. npm test scripts).
const SECRET_TOKENS = [/\bAKIA[0-9A-Z]{16}\b/g, /\bASIA[0-9A-Z]{16}\b/g, /\bgh[pousr]_[A-Za-z0-9]{20,}/g, /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bsk[-_](live|test)?[-_]?[A-Za-z0-9]{16,}/g, /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g];
export const redact = (v) => SECRET_TOKENS.reduce((t, re) => t.replace(re, '<redacted>'),
  v.replace(/\b([A-Z0-9_]*(TOKEN|SECRET|PASSWORD|PASSWD|PASS|KEY|AUTH|CREDENTIAL)[A-Z0-9_]*)=("[^"]*"|'[^']*'|\S+)/gi, '$1=<redacted>')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@"']+@/gi, '$1<redacted>@')
    .replace(/(--?(password|passwd|pass|token|secret|api-?key))(=|\s+)("[^"]*"|'[^']*'|\S+)/gi, '$1$3<redacted>'));
const TEST_CONVENTIONS = [
  ['*.test.*', /\.test\.[a-z]+$/i], ['*.spec.*', /\.spec\.[a-z]+$/i], ['test_*.py', /(^|\/)test_[^/]*\.py$/i],
  ['*_test.*', /_test\.[a-z]+$/i], ['tests.py', /(^|\/)tests\.py$/], ['tests/**', /(^|\/)tests?\//], ['__tests__/**', /(^|\/)__tests__\//],
];
const CI = /^(\.github\/workflows\/[^/]+\.ya?ml|\.travis\.yml|\.gitlab-ci\.yml|buildspec[^/]*\.ya?ml|appspec\.ya?ml|\.circleci\/config\.yml|Jenkinsfile)$/;
const COMPOSE = /^docker-compose[^/]*\.ya?ml$|^compose[^/]*\.ya?ml$/;
const DOCKERFILE = /(^|\/)Dockerfile[^/]*$/;
const NPM_FRAMEWORKS = ['react', 'react-scripts', 'next', 'express', 'jest', 'vitest', 'mocha', 'cypress', 'serverless', 'typescript'];

const hasRef = (dir, ref) => git(dir, ['rev-parse', '--verify', '-q', '--end-of-options', `${ref}^{commit}`]).status === 0;

function resolveBase(dir, base) {
  const candidates = base ? [base] : BASE_PREFERENCE;
  for (const b of candidates) {
    for (const ref of [`refs/remotes/origin/${b}`, `refs/heads/${b}`]) if (hasRef(dir, ref)) return { base: b, ref };
  }
  if (base) throw new Error(`base branch "${base}" not found locally or on origin`);
  const head = git(dir, ['symbolic-ref', '-q', '--short', 'HEAD']);
  if (head.status === 0) return { base: head.stdout.trim(), ref: `refs/heads/${head.stdout.trim()}` };
  throw new Error('no base branch found');
}

export function profile({ dir, base } = {}) {
  if (!dir || !existsSync(dir)) throw new Error(`repo not found: ${dir}`);
  const top = git(dir, ['rev-parse', '--show-toplevel']);
  if (top.status !== 0 || realpathSync(top.stdout.trim()) !== realpathSync(dir)) throw new Error(`${dir} is not the top level of a git work tree (it would profile ${top.status === 0 ? top.stdout.trim() : 'nothing'})`);
  const { base: b, ref } = resolveBase(dir, base);
  const sha = git(dir, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).stdout.trim();
  const ls = git(dir, ['ls-tree', '-r', '-z', '--name-only', '--full-tree', '--end-of-options', sha]);
  if (ls.status !== 0) throw new Error(`cannot list the tree of ${ref}: ${(ls.stderr || '').trim()}`);
  const files = ls.stdout.split('\0').filter(Boolean);
  const has = (p) => files.includes(p);
  // Hash-verified read of a non-sensitive committed file; throws on integrity errors.
  const read = (p) => {
    if (isSensitive(p)) throw new Error(`refusing to read sensitive file ${p}`);
    const r = readVerifiedBlob(dir, sha, p);
    if (r.error) throw new Error(r.error);
    return r.absent ? null : r.text;
  };
  const json = (p) => { const t = read(p); if (t === null) return null; try { return JSON.parse(t); } catch (e) { throw new Error(`${p} at ${b} is not valid JSON: ${e.message}`); } };

  const frameworks = new Set();
  const manifests = files.filter((p) => /(^|\/)(package\.json|pyproject\.toml|requirements[^/]*\.txt|setup\.py|setup\.cfg|Pipfile|go\.mod|Cargo\.toml)$/.test(p) && !p.includes('node_modules/'));
  const npm = {};
  const pj = has('package.json') ? json('package.json') : null;
  if (pj) {
    for (const [k, v] of Object.entries(pj.scripts || {})) if (/test/i.test(k) && typeof v === 'string') npm[k] = redact(v);
    const deps = { ...(pj.dependencies || {}), ...(pj.devDependencies || {}) };
    for (const f of NPM_FRAMEWORKS) if (deps[f]) frameworks.add(f);
    if (deps['@playwright/test'] || deps.playwright) frameworks.add('playwright');
  }
  if (files.some((p) => /^serverless\.(ts|ya?ml|js)$/.test(p))) frameworks.add('serverless');
  if (files.some((p) => /^next\.config\.[a-z]+$/.test(p))) frameworks.add('next');
  if (files.some((p) => /^playwright\.config\.[a-z]+$/.test(p))) frameworks.add('playwright');
  const reqText = files.filter((p) => /^requirements[^/]*\.txt$|^pyproject\.toml$|^setup\.cfg$|^Pipfile$/.test(p) && !isSensitive(p)).map((p) => read(p) || '').join('\n');
  const managePy = has('manage.py');
  if (managePy || /^\s*django\b/im.test(reqText)) frameworks.add('django');
  if (/djangorestframework/i.test(reqText)) frameworks.add('djangorestframework');
  if (/\bpytest\b/i.test(reqText)) frameworks.add('pytest');

  const makeTargets = has('Makefile')
    ? [...new Set((read('Makefile') || '').split('\n').map((l) => /^([A-Za-z0-9][A-Za-z0-9_.-]*):(?!=)/.exec(l)).filter(Boolean).map((m) => m[1]))]
    : [];
  const testTargets = makeTargets.filter((t) => /test/i.test(t));

  const testFileList = files.filter((p) => !p.includes('node_modules/') && TEST_CONVENTIONS.some(([, re]) => re.test(p)));
  const conventions = TEST_CONVENTIONS.filter(([, re]) => testFileList.some((p) => re.test(p))).map(([n]) => n);
  const compose = files.filter((p) => COMPOSE.test(p));
  const dockerfiles = files.filter((p) => DOCKERFILE.test(p));
  const languages = {};
  for (const p of files) { const m = /\.([a-z0-9]+)$/i.exec(p); if (m && ['js', 'jsx', 'ts', 'tsx', 'mjs', 'py', 'go', 'rb', 'java'].includes(m[1])) languages[m[1]] = (languages[m[1]] || 0) + 1; }

  // Local test environment hint (the agent confirms; phase 3 re-execution is the oracle).
  const evidence = [];
  let hint;
  const hasTests = testFileList.length > 0 || Object.keys(npm).length > 0 || testTargets.length > 0;
  const localCompose = compose.filter((p) => /test|local/i.test(p));
  if (!hasTests) { hint = 'no-tests'; evidence.push('no test files and no test script / make target'); }
  else if (localCompose.length && (testTargets.length || Object.values(npm).some((v) => /docker/.test(v)))) {
    hint = 'docker-existing';
    evidence.push(`compose: ${localCompose.join(', ')}`);
    if (testTargets.length) evidence.push(`make targets: ${testTargets.join(', ')}`);
  } else if (frameworks.has('django')) {
    hint = 'needs-local-env';
    evidence.push(`django project (${managePy ? 'manage.py' : 'requirements'}): its tests need a database and there is no local/test compose file`);
  } else {
    hint = 'native';
    evidence.push(Object.keys(npm).length ? `npm scripts: ${Object.keys(npm).join(', ')}` : `test files: ${conventions.join(', ')}`);
  }

  return {
    name: basename(dir), base: b, baseRef: ref, sha, files: files.length,
    stack: { languages, frameworks: [...frameworks].sort() },
    manifests,
    testScripts: { npm, make: testTargets, python: { manage: managePy } },
    testFiles: { count: testFileList.length, conventions, samples: testFileList.slice(0, 5) },
    ci: files.filter((p) => CI.test(p)).sort(),
    docker: { compose, dockerfiles },
    localEnv: { hint, evidence },
    sensitiveFilesCommitted: files.filter(isSensitive).sort(),
  };
}

if (isEntrypoint(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n) => { const i = args.indexOf(n); return i === -1 ? undefined : args[i + 1]; };
  try { process.stdout.write(JSON.stringify(profile({ dir: opt('--repo'), base: opt('--base') }), null, 2) + '\n'); }
  catch (e) { process.stderr.write(`${e.message}\n`); process.exit(2); }
}
