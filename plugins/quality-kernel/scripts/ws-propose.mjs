#!/usr/bin/env node
// /init-workspace phase 4 — validate the repo-profiler agents' JSON DETERMINISTICALLY and write the
// proposal to a new branch `init/<date>[-n]` of the workspace repo, through a temporary worktree
// created from main. main and the workspace's own worktree are never touched; the human reviews and
// merges. The agents' output is untrusted data: every field is validated, every string is scanned
// for secrets, a gated `verify` must be backed by the deterministic profile facts, and every write is
// contained in the worktree.
//
// Usage: ws-propose.mjs --org <dir> --results <file.json> [--inventory <inventory.json>]
//        [--date YYYY-MM-DD] [--org-name Org] [--forbid a,b]
// Each repo is RE-PROFILED here (ws-profile on <org>/<name> at the result's base): the gated verify is
// built from those facts (ws-command) and the committed sensitive files come from them — nothing in
// the orchestrator's files is trusted for either.
// Spec: docs/agentic-harness/spec-init-workspace.v1.md §4 phase 4.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { git, readVerifiedBlob } from './safe-git.mjs';
import { isRepoName, readWorkspaceManifest } from './workspace.mjs';
import { isEntrypoint } from './entrypoint.mjs';
import { buildVerify } from './ws-command.mjs';
import { profile as profileRepo } from './ws-profile.mjs';

const ROLES = ['app', 'harness', 'library', 'docs', 'other'];
const STATES = ['native', 'docker-existing', 'needs-local-env', 'no-tests'];
const GATED_STATES = ['native', 'docker-existing'];
const DEGENERATE = new Set(['**', '**/*', '**/**', '*']);
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*[~^:?*[\\\s@{])[A-Za-z0-9._/-]+(?<![./])$/;
const LOCAL_ENV_FILE = /^(docker-compose[A-Za-z0-9._-]*\.ya?ml|Dockerfile[A-Za-z0-9._-]*|README\.md)$/;
// The gate's glob engine (route.mjs globToRegExp) supports only **, * and ?: braces, negation and
// character classes would be matched literally and silently cover nothing.
const UNSUPPORTED_GLOB = /[{}[\]!]/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const SECRET = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}/, /\bgithub_pat_[A-Za-z0-9_]{20,}/, /\b(AKIA|ASIA)[0-9A-Z]{16}\b/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/, /\bsk[-_](live|test)?[-_]?[A-Za-z0-9]{16,}/, /\brk_live_[A-Za-z0-9]{16,}/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /aws_secret_access_key["']?\s*[=:]\s*["']?[A-Za-z0-9/+]{40}/i,
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/, /\b[rp]k_(live|test)_[A-Za-z0-9]{16,}/, /\bAIza[0-9A-Za-z_-]{35}/,
  /\bnpm_[A-Za-z0-9]{36}\b/, /hooks\.slack\.com\/services\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/[A-Za-z0-9]+/, /\bMII[A-Za-z0-9+/]{60,}/,
];
// A literal that is, AS A WHOLE, an obvious local test value or a variable reference is not a secret
// (a real password that merely CONTAINS "test" or "local" is still one).
const BENIGN = /^(\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|<[^>]*>|postgres|postgresql|mysql|root|admin|test|tests|testing|test-dummy|dummy|ci|changeme|example|password|secret|local|localhost|redacted|none|null|true|false|dev|development)$/i;
const PASSWORD_LITERAL = /(password|passwd|pwd|secret|api[_-]?key|access[_-]?key|token)["']?\s*[=:]\s*["']?([^\s"'$,}]+)/gi;
const URL_USERINFO = /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:([^/\s@]+)@/gi;

function secretIn(text) {
  if (SECRET.some((re) => re.test(text))) return true;
  for (const m of text.matchAll(PASSWORD_LITERAL)) if (m[2].length >= 6 && !BENIGN.test(m[2])) return true;
  for (const m of text.matchAll(URL_USERINFO)) if (!BENIGN.test(m[1])) return true;
  return false;
}
function stringLeaves(v, out = []) {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => stringLeaves(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); stringLeaves(x, out); }
  return out;
}
const isStrArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
const badGlob = (g) => !g.trim() || DEGENERATE.has(g.trim()) || g.startsWith('/') || g.startsWith('./') || g.split('/').includes('..');

// Returns a list of problems (empty = valid).
export function validate(results, { knownApps = [], forbidden = [], profiles = {} } = {}) {
  // profiles: name -> { facts } | { error } — derived by propose itself, never taken from the caller's files
  const errs = [];
  if (!Array.isArray(results) || !results.length) return ['results must be a non-empty array'];
  const names = new Set();
  const apps = new Set([...knownApps, ...results.filter((r) => r && r.role === 'app').map((r) => r.name)]);
  results.forEach((r, i) => {
    const at = r && typeof r.name === 'string' ? r.name : `#${i}`;
    const e = (m) => errs.push(`${at}: ${m}`);
    if (!r || typeof r !== 'object') return errs.push(`#${i}: entry must be an object`);
    if (!isRepoName(r.name)) e('invalid repo name');
    else if (names.has(r.name)) e('duplicate repo name'); else names.add(r.name);
    if (forbidden.includes(r.name)) e('is forbidden in this workspace — it must not be proposed');
    if (!ROLES.includes(r.role)) e(`role must be one of ${ROLES.join('/')}`);
    if (r.harnessOf !== null && r.harnessOf !== undefined) {
      if (r.role !== 'harness') e('harnessOf is only valid for role "harness"');
      else if (!apps.has(r.harnessOf)) e(`harnessOf "${r.harnessOf}" is not an app of this workspace`);
    }
    if (typeof r.base !== 'string' || !BRANCH.test(r.base) || r.base.endsWith('.lock')) e('base must be a plain branch name');
    const state = r.localEnv && r.localEnv.state;
    if (!STATES.includes(state)) e(`localEnv.state must be one of ${STATES.join('/')}`);
    for (const f of ['productionGlobs', 'testGlobs', 'criticalGlobs', 'safeGlobs']) {
      if (!isStrArray(r[f])) e(`${f} must be an array of strings`);
      else if (r[f].some(badGlob)) e(`${f} has an empty, degenerate, absolute, "./" or ".." glob`);
      else if (r[f].some((g) => UNSUPPORTED_GLOB.test(g))) e(`${f} uses unsupported glob syntax ({a,b}, [..], !) — the gate supports only **, * and ?; list each pattern separately`);
    }
    if (!isStrArray(r.linkPaths) || r.linkPaths.some((p) => !p || p.startsWith('/') || p.split('/').includes('..'))) e('linkPaths must be non-empty relative paths inside the repo');
    const gated = r.role === 'app' && GATED_STATES.includes(state);
    if (gated) {
      const pr = Object.prototype.hasOwnProperty.call(profiles, r.name) ? profiles[r.name] : null;
      if (!pr || pr.error) e(`cannot profile the repo to build verify from its facts: ${pr ? pr.error : 'repo not profiled'}`);
      else { const b = buildVerify(r.verify, pr.facts); if (b.error) e(`verify: ${b.error}`); }
      if (isStrArray(r.productionGlobs) && !r.productionGlobs.length) e('productionGlobs must not be empty for a gated app');
    } else if (r.verify !== null && r.verify !== undefined) e('verify must be null unless the repo is a gated app (native / docker-existing)');
    if (state === 'needs-local-env') {
      const p = r.localEnv.proposal;
      if (!p || typeof p !== 'object' || typeof p.verify !== 'string' || !p.files || typeof p.files !== 'object') e('needs-local-env requires localEnv.proposal { verify, files }');
      else if (CONTROL.test(p.verify)) e('localEnv.proposal.verify must be a single line (it is documentation for a human, never executed by these tools)');
      else for (const [name, content] of Object.entries(p.files)) {
        if (!LOCAL_ENV_FILE.test(name)) e(`local-env file "${name}" is not allowed (docker-compose*.yml, Dockerfile*, README.md only)`);
        if (typeof content !== 'string') e(`local-env file "${name}" must be text`);
      }
    }
    if (!Array.isArray(r.evidence) || r.evidence.some((x) => !x || typeof x.claim !== 'string' || typeof x.at !== 'string')) e('evidence must be an array of { claim, at }');
    else if (r.role === 'app' && !r.evidence.length) e('evidence must not be empty for an app (file:line facts)');
    if (r.notes !== undefined && !isStrArray(r.notes)) e('notes must be an array of strings');
    const texts = [...(Array.isArray(r.evidence) ? r.evidence.flatMap((x) => (x ? [x.claim, x.at] : [])) : []), ...(isStrArray(r.notes) ? r.notes : [])];
    if (texts.some((t) => typeof t === 'string' && CONTROL.test(t))) e('evidence / notes must not contain control characters or newlines');
    if (stringLeaves(r).some(secretIn)) e('contains a secret-looking value — never put credentials in the workspace');
  });
  return errs;
}

// INIT-REPORT.md, rendered from structured data (init-report.json) — ws-verify re-renders it with
// the labels, never regex-edits it.
// Every string rendered into the report: single line, no backticks (they would break the code spans).
const tick = (s) => String(s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/`/g, "'");
export function renderReport(data) {
  const { date, branch, results, sensitive = {}, skipped = [], gated = [], verification = null } = data;
  const labels = new Map((verification ? verification.results : []).map((x) => [x.name, x.label]));
  const row = (r) => {
    const state = r.localEnv.state;
    const isGated = gated.includes(r.name);
    const cfg = r.role !== 'app' ? '—' : isGated ? 'tools.json + critical-surface.json'
      : state === 'needs-local-env' ? 'critical-surface.json; local-env proposal (unverified)' : 'critical-surface.json only';
    const label = r.role !== 'app' ? 'n/a' : labels.get(r.name) || (isGated ? 'pending' : 'n/a');
    return `| ${tick(r.name)} | ${r.role}${r.harnessOf ? ` of ${tick(r.harnessOf)}` : ''} | ${tick(r.base)} | ${state} | ${cfg} | ${label} |`;
  };
  const L = [
    `# Workspace init proposal — ${date}`, '',
    `Branch \`${branch}\` — NOT merged. Review it, then merge into \`main\` locally. The workspace is the`,
    'trust root of every gate: nothing here is trusted until a human merges it.', '',
    '## Repos', '', '| Repo | Role | Base | Local env | Gate config | Verification |', '|---|---|---|---|---|---|',
    ...results.map(row), '', '## Evidence', '',
  ];
  for (const r of results) {
    L.push(`### ${tick(r.name)}`, '');
    for (const ev of r.evidence) L.push(`- ${tick(ev.claim)} — \`${tick(ev.at)}\``);
    for (const n of r.notes || []) L.push(`- note: ${tick(n)}`);
    if (r.localEnv.state === 'needs-local-env') L.push(`- local env proposal: \`repos/${r.name}/local-env/\` — test command: \`${tick(r.localEnv.proposal.verify)}\``);
    L.push('');
  }
  const sens = Object.entries(sensitive).filter(([, v]) => Array.isArray(v) && v.length);
  if (sens.length) {
    L.push('## Committed sensitive files (names only — contents were never read)', '');
    for (const [n, files] of sens) L.push(`- ${tick(n)}: ${files.map((f) => `\`${tick(f)}\``).join(', ')}`);
    L.push('');
  }
  if (skipped.length) {
    L.push('## Not selected / skipped', '');
    for (const s of skipped) L.push(`- ${tick(s.name)} — ${tick(s.reason)}`);
    L.push('');
  }
  if (verification) {
    L.push(`## Verification (re-executed, proposal ${verification.proposalSha.slice(0, 12)}, config tree ${verification.configTree.slice(0, 12)})`, '');
    for (const x of verification.results) L.push(`- **${tick(x.name)}**: ${x.label}${x.baseSha ? ` at ${tick(x.base)} ${x.baseSha.slice(0, 12)}` : ''} — ${tick(x.reason)}`);
    L.push('');
  }
  return L.join('\n');
}

const commitArgs = (author) => (author ? ['-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`] : []);
const isOwnRepo = (dir) => { const t = git(dir, ['rev-parse', '--show-toplevel']); return t.status === 0 && realpathSync(t.stdout.trim()) === realpathSync(dir); };
const hasRef = (dir, ref) => git(dir, ['rev-parse', '--verify', '-q', '--end-of-options', ref]).status === 0;
const KNOWN_TOOLS_KEYS = new Set(['$comment', 'verify', 'verifySpec', 'productionGlobs', 'testGlobs', 'linkPaths', 'localEnv']);

export function propose({ org, date, results, author, orgName = null, forbidden = [], skipped = [] } = {}) {
  if (!org || !existsSync(org)) throw new Error(`org folder not found: ${org}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('date must be YYYY-MM-DD');
  for (const f of forbidden) if (!isRepoName(f)) throw new Error(`invalid forbidden name: ${f}`);
  const ws = join(org, 'workspace');
  let existing = null;
  let existingRaw = null;
  if (existsSync(ws)) {
    if (!isOwnRepo(ws)) throw new Error(`${ws} exists but is not a git repository of its own — refusing to write (it would land in a parent repo)`);
    existing = readWorkspaceManifest(ws, 'main');
    const raw = readVerifiedBlob(ws, 'main', 'workspace.json');
    if (raw.error) throw new Error(`workspace integrity: ${raw.error}`);
    if (!raw.absent) {
      if (!existing) throw new Error('workspace/workspace.json on main is unusable (not version 1, or a malformed repos/forbidden list) — fix it first; the deny list cannot be trusted');
      existingRaw = JSON.parse(raw.text);
    }
  }
  const allForbidden = [...new Set([...(existing ? existing.forbidden : []), ...forbidden])];
  // Re-profile every repo here (never trust the caller's profile files).
  const profiles = {};
  const sensitive = {};
  for (const r of Array.isArray(results) ? results : []) {
    if (!r || !isRepoName(r.name) || allForbidden.includes(r.name) || typeof r.base !== 'string') continue;
    try {
      const p = profileRepo({ dir: join(org, r.name), base: r.base });
      profiles[r.name] = { facts: p };
      sensitive[r.name] = p.sensitiveFilesCommitted;
    } catch (err) { profiles[r.name] = { error: err.message }; }
  }
  const problems = validate(results, { knownApps: existing ? Object.keys(existing.repos).filter((n) => !allForbidden.includes(n)) : [], forbidden: allForbidden, profiles });
  // Skipped entries come from the inventory: plain names, single-line, secret-free reasons only.
  const safeSkipped = (Array.isArray(skipped) ? skipped : []).filter((x) => x && isRepoName(x.name) && typeof x.reason === 'string')
    .map((x) => ({ name: x.name, reason: secretIn(x.reason) ? '(reason withheld: secret-looking text)' : x.reason.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 300) }));
  if (problems.length) throw new Error(`invalid profiler output:\n- ${problems.join('\n- ')}`);

  let created = false;
  if (!existsSync(ws)) {
    mkdirSync(ws); created = true;
    git(ws, ['init', '-q', '-b', 'main']);
    writeFileSync(join(ws, 'README.md'), '# workspace\n\nThe control repo of this org folder (see quality-kernel workspace mode).\n');
    git(ws, ['add', 'README.md']);
    const c = git(ws, [...commitArgs(author), 'commit', '-q', '-m', '🎉 chore: create the workspace control repo']);
    if (c.status !== 0) {
      rmSync(ws, { recursive: true, force: true });
      throw new Error(`cannot commit in the new workspace repo — no git identity (pass an author or set user.name/user.email): ${(c.stderr || '').trim()}`);
    }
  }

  let branch = `init/${date}`;
  for (let n = 2; hasRef(ws, `refs/heads/${branch}`) || hasRef(ws, `refs/remotes/origin/${branch}`); n++) branch = `init/${date}-${n}`;

  const tmp = mkdtempSync(join(tmpdir(), 'qk-init-'));
  const wt = join(tmp, 'wt');
  const add = git(ws, ['worktree', 'add', '-q', '-b', branch, wt, 'refs/heads/main']);
  if (add.status !== 0) { rmSync(tmp, { recursive: true, force: true }); if (created) rmSync(ws, { recursive: true, force: true }); throw new Error(`cannot create the proposal branch: ${(add.stderr || '').trim()}`); }
  const wtReal = realpathSync(wt);
  let ok = false;
  try {
    const put = (p, c) => {
      const d = resolve(wtReal, p);
      if (!d.startsWith(wtReal + '/')) throw new Error(`refusing to write outside the proposal worktree: ${p}`);
      mkdirSync(dirname(d), { recursive: true }); writeFileSync(d, c);
    };
    const repos = Object.fromEntries(Object.entries(existing ? existing.repos : {}).filter(([n]) => !allForbidden.includes(n)));
    const droppedForbidden = existing ? Object.keys(existing.repos).filter((n) => allForbidden.includes(n)) : [];
    const gated = [];
    for (const r of results) {
      if (r.role !== 'app') continue;
      const harness = results.find((h) => h.role === 'harness' && h.harnessOf === r.name);
      repos[r.name] = { role: 'app', base: r.base, ...(harness ? { harness: harness.name } : repos[r.name] && repos[r.name].harness ? { harness: repos[r.name].harness } : {}) };
      put(`repos/${r.name}/critical-surface.json`, JSON.stringify({ $comment: `Proposed by /init-workspace ${date}. Review before merging.`, criticalGlobs: r.criticalGlobs, safeGlobs: r.safeGlobs }, null, 2) + '\n');
      if (GATED_STATES.includes(r.localEnv.state)) {
        gated.push(r.name);
        const prev = readVerifiedBlob(ws, 'main', `repos/${r.name}/tools.json`);
        let extra = {};
        if (prev.text) { try { extra = Object.fromEntries(Object.entries(JSON.parse(prev.text)).filter(([k]) => !KNOWN_TOOLS_KEYS.has(k))); } catch { /* an unreadable previous file keeps nothing */ } }
        const command = buildVerify(r.verify, profiles[r.name].facts).command;
        put(`repos/${r.name}/tools.json`, JSON.stringify({ $comment: `Proposed by /init-workspace ${date}. Review before merging.`, verify: command, verifySpec: r.verify, productionGlobs: r.productionGlobs, testGlobs: r.testGlobs, linkPaths: r.linkPaths, localEnv: r.localEnv.state, ...extra }, null, 2) + '\n');
      }
      if (r.localEnv.state === 'needs-local-env') for (const [name, content] of Object.entries(r.localEnv.proposal.files)) put(`repos/${r.name}/local-env/${name}`, content);
    }
    const manifest = { ...(existingRaw && existingRaw.$comment ? { $comment: existingRaw.$comment } : {}), version: 1, org: existing ? existing.org ?? orgName : orgName, repos, forbidden: allForbidden };
    put('workspace.json', JSON.stringify(manifest, null, 2) + '\n');
    const data = { date, branch, results, sensitive, skipped: [...safeSkipped, ...droppedForbidden.map((n) => ({ name: n, reason: 'removed from repos: forbidden' }))], gated, verification: null };
    put('init-report.json', JSON.stringify(data, null, 2) + '\n');
    put('INIT-REPORT.md', renderReport(data));
    git(wt, ['add', '-A']);
    const c = git(wt, [...commitArgs(author), 'commit', '-q', '-m', `✨ feat: workspace proposal from /init-workspace (${date})`]);
    if (c.status !== 0) throw new Error(`cannot commit the proposal: ${(c.stderr || '').trim()}`);
    ok = true;
    return { workspace: ws, branch, sha: git(wt, ['rev-parse', 'HEAD']).stdout.trim(), created, gated };
  } finally {
    git(ws, ['worktree', 'remove', '--force', wt]);
    git(ws, ['worktree', 'prune']);
    rmSync(tmp, { recursive: true, force: true });
    if (!ok) {
      git(ws, ['branch', '-D', branch]);
      if (created) rmSync(ws, { recursive: true, force: true });
    }
  }
}

if (isEntrypoint(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n) => { const i = args.indexOf(n); return i === -1 ? undefined : args[i + 1]; };
  try {
    const results = JSON.parse(readFileSync(opt('--results'), 'utf8'));
    const inv = opt('--inventory') ? JSON.parse(readFileSync(opt('--inventory'), 'utf8')) : null;
    const skipped = inv ? inv.candidates.filter((c) => c.listed !== false && !c.suggested).map((c) => ({ name: c.name, reason: `${c.kind || (c.forbidden ? 'forbidden' : 'excluded')}${c.reasons && c.reasons.length ? ` — ${c.reasons.join('; ')}` : ''}` })) : [];
    const forbidden = [...(opt('--forbid') ? opt('--forbid').split(',') : []), ...(inv && Array.isArray(inv.forbidden) ? inv.forbidden : [])];
    // sensitiveFilesCommitted in results.json is ignored: propose re-profiles each repo itself.
    const r = propose({ org: opt('--org'), date: opt('--date') || new Date().toISOString().slice(0, 10), results: results.map(({ sensitiveFilesCommitted, ...x }) => x), orgName: opt('--org-name') || null, forbidden: [...new Set(forbidden)], skipped });
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  } catch (e) { process.stderr.write(`${e.message}\n`); process.exit(2); }
}
