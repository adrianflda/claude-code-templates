#!/usr/bin/env node
// /org-init phase 0 — discover the repos of an org folder and classify them.
//
// Reads git METADATA only (is it a work tree, remote, branches, top-level entry names of HEAD);
// never file contents. Plain files at the org root (credentials, keys, notes) are not listed, and
// hidden dirs are skipped. With an explicit repo list, every other dir is reported by name only and
// never opened.
//
// Forbidden repos come from --forbid and from the org guide block in <org>/CLAUDE.md; they are
// listed by name and never opened.
//
// Usage: org-discover.mjs --org <dir> [--repos a,b] [--exclude x,y] [--forbid q,r]
// Prints the inventory JSON.

import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { git } from './safe-git.mjs';
import { isRepoName, readGuideForbidden } from './org-guide.mjs';
import { isMain } from './entrypoint.mjs';

const BASE_CANDIDATES = ['development', 'dev', 'develop', 'staging', 'main', 'master'];
const HARNESS_NAME = /-qa(-local)?$/i;
const HARNESS_FILE = /^(playwright|cypress)\.config\.[a-z]+$/i;
const COPY_NAME = /\(copy\)/i;

// Remove anything credential-like from a remote URL: userinfo, query and fragment of URL forms;
// `user:password@host:` of scp forms (a bare `git@host:` user is kept — it is not a secret).
export function stripCredentials(url) {
  if (typeof url !== 'string' || !url) return null;
  const noQuery = (u) => u.replace(/[?#].*$/, '');
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(url);
  if (scheme) {
    // Strip the query string/fragment BEFORE locating the userinfo separator (OG-14/F16): an '@'
    // inside a query string (e.g. "?next=x@evil/y") must never be mistaken for one.
    const rest = noQuery(url.slice(scheme[0].length));
    // The userinfo may itself contain '/', ':' or '@': the host begins after the last '@' that
    // still has a '/' (the path) somewhere after it, or after the last '@' when there is no path.
    const at = rest.lastIndexOf('@');
    if (at === -1) return scheme[0] + rest;
    // An '@' that sits in the PATH (a '/' before it, none after it) is not userinfo.
    if (rest.slice(0, at).includes('/') && !rest.slice(at + 1).includes('/')) return scheme[0] + rest;
    return scheme[0] + rest.slice(at + 1);
  }
  // scp-style: user[:password]@host:path — the password itself may contain '@' (OG-14/F14), so the
  // host is identified by the LAST '@' that is immediately followed by a bare "host:" (no further
  // '@' or ':' before that colon), not the first one.
  const scp = /^(.*)@([^@/:]+):(.*)$/.exec(url);
  if (scp) {
    const user = scp[1].split(':')[0];
    return user === 'git' ? `git@${scp[2]}:${noQuery(scp[3])}` : `${scp[2]}:${noQuery(scp[3])}`;
  }
  return noQuery(url);
}
// A comparable key for "same remote": host/path, lower-case, no .git suffix.
const remoteKey = (url) => {
  if (!url) return null;
  const m = url.match(/^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]*@)?([^/:]+)[:/](.+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : url.toLowerCase();
};
const out = (dir, args) => { const r = git(dir, args); return r.status === 0 ? r.stdout.trim() : null; };
const hasRef = (dir, ref) => git(dir, ['rev-parse', '--verify', '-q', '--end-of-options', `${ref}^{commit}`]).status === 0;

function analyze(org, name, entries) {
  const dir = join(org, name);
  const c = { name, listed: true, reasons: [] };
  if (!entries.includes(name)) {
    const other = entries.find((e) => e.toLowerCase() === name.toLowerCase());
    return { ...c, kind: 'missing', reasons: [other ? `not found (a dir named "${other}" differs in case)` : 'not found in the org folder'] };
  }
  const st = lstatSync(dir);
  if (st.isSymbolicLink()) return { ...c, kind: 'symlink', reasons: ['a symlink — not opened (it may point outside the org folder)'] };
  if (!st.isDirectory()) return { ...c, kind: 'not-git', reasons: ['not a directory'] };
  if (!realpathSync(dir).startsWith(org + '/')) return { ...c, kind: 'symlink', reasons: ['resolves outside the org folder — not opened'] };
  const dotGit = join(dir, '.git');
  const top = out(dir, ['rev-parse', '--show-toplevel']);
  if (!top || realpathSync(top) !== realpathSync(dir)) return { ...c, kind: 'not-git', reasons: ['not a git work tree of its own'] };
  const isWorktree = existsSync(dotGit) && lstatSync(dotGit).isFile();
  c.kind = isWorktree ? 'worktree' : 'repo';
  if (isWorktree) c.reasons.push('linked worktree of another repo');
  c.remote = stripCredentials(out(dir, ['config', '--get', 'remote.origin.url']));
  c.defaultBranch = (out(dir, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD']) || '').replace(/^origin\//, '')
    || out(dir, ['symbolic-ref', '-q', '--short', 'HEAD']);
  c.baseCandidates = BASE_CANDIDATES.filter((b) => hasRef(dir, `refs/remotes/origin/${b}`) || hasRef(dir, `refs/heads/${b}`));
  const topNames = (out(dir, ['ls-tree', '--name-only', 'HEAD']) || '').split('\n').filter(Boolean);
  const hints = [];
  if (HARNESS_NAME.test(name)) hints.push('name');
  for (const f of topNames) if (HARNESS_FILE.test(f)) hints.push(f);
  c.harness = { likely: hints.length > 0, hints };
  if (c.kind === 'repo' && COPY_NAME.test(name)) { c.kind = 'copy'; c.reasons.push('name marks it as a copy'); }
  return c;
}

export function discover({ org, repos, exclude = [], forbid = [] } = {}) {
  if (!org || !existsSync(org) || !statSync(org).isDirectory()) throw new Error(`org folder not found: ${org}`);
  const root = realpathSync(org);
  for (const n of [...(repos || []), ...exclude, ...forbid]) if (!isRepoName(n)) throw new Error(`invalid repo name: ${JSON.stringify(n)}`);
  const all = readdirSync(root, { withFileTypes: true });
  const entries = all.map((e) => e.name);
  const dirs = all.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort();

  // The deny set comes FIRST, so forbidden / excluded dirs are never opened.
  const forbiddenBy = new Map(forbid.map((n) => [n, 'option']));
  for (const n of readGuideForbidden(root)) if (!forbiddenBy.has(n)) forbiddenBy.set(n, 'CLAUDE.md');

  const listed = Array.isArray(repos) && repos.length ? [...new Set(repos)] : null;
  const candidates = [];
  const denied = (name) => {
    if (forbiddenBy.has(name)) return { name, opened: false, forbidden: true, forbiddenBy: forbiddenBy.get(name), suggested: false, reasons: [`forbidden (${forbiddenBy.get(name)}) — not opened`] };
    if (exclude.includes(name)) return { name, opened: false, suggested: false, reasons: ['excluded (--exclude) — not opened'] };
    return null;
  };
  if (listed) {
    for (const name of dirs) if (!listed.includes(name)) candidates.push({ name, listed: false });
    for (const name of listed) candidates.push(denied(name) || analyze(root, name, entries));
  } else {
    for (const name of dirs) candidates.push(denied(name) || analyze(root, name, entries));
  }
  candidates.sort((a, b) => a.name.localeCompare(b.name));
  const opened = candidates.filter((c) => c.listed !== false && c.opened !== false);

  // Copies: repos sharing one origin; the one named like the remote is the original.
  const groups = new Map();
  for (const c of opened) if (c.kind === 'repo' && c.remote) {
    const k = remoteKey(c.remote); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(c);
  }
  for (const [k, group] of groups) {
    if (group.length < 2) continue;
    const originalName = basename(k);
    const original = group.find((c) => c.name.toLowerCase() === originalName);
    if (!original) { for (const c of group) c.reasons.push(`shares its origin with ${group.filter((x) => x !== c).map((x) => x.name).join(', ')}`); continue; }
    for (const c of group) if (c !== original) { c.kind = 'copy'; c.reasons.push(`same origin as ${original.name}`); }
  }

  for (const c of opened) {
    c.forbidden = false;
    c.suggested = c.kind === 'repo';
  }
  return { org: root, selectionMode: listed ? 'listed' : 'all', forbidden: [...forbiddenBy.keys()].sort(), candidates };
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n) => { const i = args.indexOf(n); return i === -1 ? undefined : args[i + 1]; };
  const list = (n) => (opt(n) ? opt(n).split(',').map((s) => s.trim()).filter(Boolean) : undefined);
  try {
    process.stdout.write(JSON.stringify(discover({ org: opt('--org'), repos: list('--repos'), exclude: list('--exclude') || [], forbid: list('--forbid') || [] }), null, 2) + '\n');
  } catch (e) { process.stderr.write(`${e.message}\n`); process.exit(2); }
}
