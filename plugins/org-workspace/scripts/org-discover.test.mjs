import './hermetic-git.mjs';
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, chmodSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discover, stripCredentials } from './org-discover.mjs';
import { BEGIN, END } from './org-guide.mjs';

// Phase 0 of /org-init: list the org folder's repos and classify them, reading git metadata
// only (never file contents). With an explicit repo list, nothing else is opened.
const here = dirname(fileURLToPath(import.meta.url));
const gitIn = (dir) => (...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
function write(dir, p, c) { const d = join(dir, p); mkdirSync(dirname(d), { recursive: true }); writeFileSync(d, c); }
function repo(root, name, { files = { 'README.md': name }, branches = [], remote } = {}) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const git = gitIn(dir);
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  for (const [p, c] of Object.entries(files)) write(dir, p, c);
  git('add', '-A'); git('commit', '-qm', 'init');
  for (const b of branches) git('branch', b);
  if (remote) git('remote', 'add', 'origin', remote);
  return { dir, git };
}
const orgDir = () => realpathSync(mkdtempSync(join(tmpdir(), 'qk-disc-')));
const byName = (inv) => Object.fromEntries(inv.candidates.map((c) => [c.name, c]));
// OG-1/OG-2/OG-3: the forbidden list is read from guide.json, never from CLAUDE.md's rendered block.
const writeGuide = (org, g) => write(org, '.claude/org-workspace/guide.json', JSON.stringify(g));

test('classifies repos, worktrees, copies, harnesses and plain dirs', () => {
  const org = orgDir();
  const app = repo(org, 'app', { branches: ['development'], remote: 'git@github.com:Org/app.git' });
  repo(org, 'app (Copy)', { remote: 'git@github.com:Org/app.git' });
  repo(org, 'dup', { remote: 'git@github.com:Org/app.git' });
  repo(org, 'app-qa-local', { files: { 'playwright.config.ts': 'x' } });
  app.git('worktree', 'add', '-q', join(org, 'wt-app'), '-b', 'wt');
  mkdirSync(join(org, 'plain'));
  const s = byName(discover({ org }));
  assert.strictEqual(s.app.kind, 'repo');
  assert.strictEqual(s['app (Copy)'].kind, 'copy');
  assert.strictEqual(s.dup.kind, 'copy', 'same origin as "app", whose name matches the remote');
  assert.strictEqual(s['wt-app'].kind, 'worktree');
  assert.strictEqual(s.plain.kind, 'not-git');
  assert.strictEqual(s['app-qa-local'].harness.likely, true);
  assert.ok(s['app-qa-local'].harness.hints.includes('name'));
  assert.ok(s['app-qa-local'].harness.hints.includes('playwright.config.ts'));
  assert.strictEqual(s.app.harness.likely, false);
  assert.deepStrictEqual(s.app.baseCandidates, ['development', 'main']);
});

test('only repos are suggested; copies, worktrees, plain dirs and forbidden repos are not', () => {
  const org = orgDir();
  repo(org, 'app'); repo(org, 'app-qa'); repo(org, 'app (Copy)'); mkdirSync(join(org, 'plain'));
  const s = byName(discover({ org, forbid: ['app-qa'] }));
  assert.strictEqual(s.app.suggested, true);
  assert.strictEqual(s['app-qa'].suggested, false);
  assert.strictEqual(s['app-qa'].forbidden, true);
  assert.strictEqual(s['app (Copy)'].suggested, false);
  assert.strictEqual(s.plain.suggested, false);
});

// OG-1/OG-2/OG-3 (F1): the rendered CLAUDE.md block is a derived view only; the forbidden list
// always comes from guide.json itself, never a regex-parse of the rendered markdown.
test('forbidden repos recorded in guide.json are carried over and never opened', () => {
  const org = orgDir();
  repo(org, 'app'); repo(org, 'app-qa');
  writeGuide(org, { org: 't', repos: [], forbidden: ['app-qa', 'other-qa'] });
  const inv = discover({ org });
  const s = byName(inv);
  assert.strictEqual(s['app-qa'].forbidden, true);
  assert.strictEqual(s['app-qa'].forbiddenBy, 'guide.json');
  assert.strictEqual(s['app-qa'].opened, false);
  assert.deepStrictEqual(inv.forbidden, ['app-qa', 'other-qa']);
});

test('a forbidden-looking line in CLAUDE.md prose is not read as a rule: only guide.json counts', () => {
  const org = orgDir(); repo(org, 'app'); repo(org, 'app-qa');
  writeFileSync(join(org, 'CLAUDE.md'), `${BEGIN}\n- Forbidden (never open, run or write): \`app\`\n${END}\n`);
  assert.strictEqual(byName(discover({ org })).app.forbidden, false, 'CLAUDE.md prose must never be parsed back');
  writeGuide(org, { org: 't', repos: [], forbidden: ['app'] });
  assert.strictEqual(byName(discover({ org })).app.forbidden, true, 'the same name IS forbidden once guide.json says so');
});

// OG-2 (Gherkin "readGuideForbidden fails closed on a corrupt or symlinked guide.json"): a symlinked
// or unparsable guide.json must throw, never silently fall back to an empty forbidden list.
test('OG-2: a symlinked or corrupt guide.json makes discover fail closed, not silently empty', () => {
  const org = orgDir(); repo(org, 'app');
  const elsewhere = join(realpathSync(mkdtempSync(join(tmpdir(), 'qk-disc-x-'))), 'g.json');
  writeFileSync(elsewhere, JSON.stringify({ forbidden: ['app'] }));
  mkdirSync(join(org, '.claude', 'org-workspace'), { recursive: true });
  symlinkSync(elsewhere, join(org, '.claude', 'org-workspace', 'guide.json'));
  assert.throws(() => discover({ org }), /symlink/);

  const org2 = orgDir(); repo(org2, 'app');
  write(org2, '.claude/org-workspace/guide.json', '{not json');
  assert.throws(() => discover({ org: org2 }), /not valid JSON/);
});
test('hidden dirs and plain files are not listed at all (no credential file names in the output)', () => {
  const org = orgDir();
  repo(org, 'app');
  mkdirSync(join(org, '.worktrees'));
  writeFileSync(join(org, 'adrian_credentials.csv'), 'secret');
  writeFileSync(join(org, 'ec2-prod.pem'), 'key');
  const inv = discover({ org });
  assert.deepStrictEqual(inv.candidates.map((c) => c.name), ['app']);
  assert.doesNotMatch(JSON.stringify(inv), /credentials|\.pem|secret/);
});

test('remote URLs have credentials stripped', () => {
  const org = orgDir();
  repo(org, 'app', { remote: 'https://user:ghp_TOKEN123@github.com/Org/app.git' });
  const s = byName(discover({ org }));
  assert.strictEqual(s.app.remote, 'https://github.com/Org/app.git');
  assert.doesNotMatch(JSON.stringify(s), /ghp_TOKEN123|user:/);
});

test('with an explicit repo list, other dirs are reported by name only and never opened', () => {
  const org = orgDir();
  repo(org, 'app'); repo(org, 'other', { remote: 'git@github.com:Org/other.git' });
  const locked = repo(org, 'locked');
  chmodSync(locked.dir, 0o000); // opening it would fail: proves it is never touched
  try {
    const inv = discover({ org, repos: ['app'] });
    assert.strictEqual(inv.selectionMode, 'listed');
    const s = byName(inv);
    assert.strictEqual(s.app.suggested, true);
    assert.deepStrictEqual(s.other, { name: 'other', listed: false });
    assert.deepStrictEqual(s.locked, { name: 'locked', listed: false });
  } finally { chmodSync(locked.dir, 0o755); }
});

test('a listed repo that is missing, not a repo, or forbidden is reported, not silently dropped', () => {
  const org = orgDir();
  repo(org, 'app'); mkdirSync(join(org, 'plain')); repo(org, 'app-qa');
  const s = byName(discover({ org, repos: ['app', 'ghost', 'plain', 'app-qa'], forbid: ['app-qa'] }));
  assert.strictEqual(s.ghost.kind, 'missing'); assert.strictEqual(s.ghost.suggested, false);
  assert.strictEqual(s.plain.kind, 'not-git'); assert.strictEqual(s.plain.suggested, false);
  assert.strictEqual(s['app-qa'].suggested, false); assert.match(s['app-qa'].reasons.join(' '), /forbidden/);
});

test('--exclude removes a repo from the suggestion', () => {
  const org = orgDir();
  repo(org, 'app'); repo(org, 'legacy');
  const s = byName(discover({ org, exclude: ['legacy'] }));
  assert.strictEqual(s.legacy.suggested, false);
  assert.match(s.legacy.reasons.join(' '), /excluded/);
});

test('invalid names in --repos are refused (no path traversal)', () => {
  const org = orgDir();
  repo(org, 'app');
  assert.throws(() => discover({ org, repos: ['../etc'] }), /invalid repo name/);
});

test('CLI prints the inventory as JSON', () => {
  const org = orgDir();
  repo(org, 'app');
  const r = spawnSync('node', [join(here, 'org-discover.mjs'), '--org', org, '--repos', 'app'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).candidates[0].name, 'app');
});

// --- round 2 ---
// A git wrapper that logs every invocation (cwd + args) and then runs the real git: the oracle for
// "this dir was never opened" (a chmod-000 dir is not one — git errors are swallowed as not-git).
function loggingGit() {
  const bin = realpathSync(mkdtempSync(join(tmpdir(), 'qk-gitlog-')));
  const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const log = join(bin, 'calls.log');
  writeFileSync(join(bin, 'git'), `#!/bin/sh\necho "$PWD $*" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(real)} "$@"\n`);
  chmodSync(join(bin, 'git'), 0o755);
  return { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, calls: () => { try { return readFileSync(log, 'utf8'); } catch { return ''; } } };
}
const cli = (args, env) => spawnSync('node', [join(here, 'org-discover.mjs'), ...args], { encoding: 'utf8', env });

test('listed mode: non-listed dirs get zero git calls (instrumented git)', () => {
  const org = orgDir(); repo(org, 'app'); repo(org, 'other');
  const g = loggingGit();
  const r = cli(['--org', org, '--repos', 'app'], g.env);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(g.calls(), /\/app /, 'control: the wrapper does log git calls');
  assert.doesNotMatch(g.calls(), /\/other\b/);
});

test('all mode: forbidden and excluded dirs are listed by name and never opened', () => {
  const org = orgDir(); repo(org, 'app'); repo(org, 'qa-team', { remote: 'https://h/qa.git' }); repo(org, 'legacy');
  const g = loggingGit();
  const r = cli(['--org', org, '--forbid', 'qa-team', '--exclude', 'legacy'], g.env);
  assert.strictEqual(r.status, 0, r.stderr);
  const s = byName(JSON.parse(r.stdout));
  assert.deepStrictEqual(s['qa-team'], { name: 'qa-team', opened: false, forbidden: true, forbiddenBy: 'option', suggested: false, reasons: ['forbidden (option) — not opened'] });
  assert.deepStrictEqual(s.legacy, { name: 'legacy', opened: false, suggested: false, reasons: ['excluded (--exclude) — not opened'] });
  assert.doesNotMatch(g.calls(), /qa-team|legacy/);
});

test('forbidden names are exposed at the top level, also in listed mode', () => {
  const org = orgDir(); repo(org, 'app'); repo(org, 'qa-team');
  writeGuide(org, { org: 't', repos: [], forbidden: ['guide-forbidden'] });
  const inv = discover({ org, repos: ['app'], forbid: ['qa-team'] });
  assert.deepStrictEqual(inv.forbidden, ['guide-forbidden', 'qa-team']);
});
test('listed names: symlinks are refused and names must match the dir entry exactly', () => {
  const org = orgDir(); repo(org, 'Client');
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'qk-out-')));
  repo(outside, 'secretrepo', { remote: 'https://h/secret.git' });
  symlinkSync(join(outside, 'secretrepo'), join(org, 'app'));
  const s = byName(discover({ org, repos: ['app', 'client'] }));
  assert.strictEqual(s.app.kind, 'symlink'); assert.strictEqual(s.app.suggested, false);
  assert.strictEqual(s.app.remote, undefined);
  assert.strictEqual(s.client.kind, 'missing');
  assert.match(s.client.reasons.join(' '), /case/);
});

test('credentials are stripped from every remote form', () => {
  const cases = [
    ['https://user:p@ss@github.com/O/a.git', 'https://github.com/O/a.git'],
    ['https://user:ab/cd@github.com/O/a.git', 'https://github.com/O/a.git'],
    ['https://github.com/O/a.git?access_token=SECRETQ#frag', 'https://github.com/O/a.git'],
    ['https://ghp_TOKEN123@github.com/O/a.git', 'https://github.com/O/a.git'],
    ['user:tok@host:O/a.git', 'host:O/a.git'],
    ['git@github.com:O/a.git', 'git@github.com:O/a.git'],
    ['ssh://git:pw@github.com/O/a.git', 'ssh://github.com/O/a.git'],
  ];
  for (const [input, want] of cases) {
    const org = orgDir(); repo(org, 'app', { remote: input });
    assert.strictEqual(byName(discover({ org })).app.remote, want, input);
  }
});

// OG-14 / F14+F16 / Gherkin "credentials are fully stripped from an scp-style remote with '@' in the
// password" and "a query-string '@' does not corrupt the stripped host".
test('OG-14: an scp-style password containing "@" is fully stripped, not just its tail', () => {
  assert.strictEqual(stripCredentials('user:p@ss@host:O/a.git'), 'host:O/a.git');
  const org = orgDir(); repo(org, 'app', { remote: 'user:p@ss@host:O/a.git' });
  const inv = discover({ org });
  assert.strictEqual(byName(inv).app.remote, 'host:O/a.git');
  assert.doesNotMatch(JSON.stringify(inv), /p@ss/);
});

test('OG-14: a query-string "@" does not relocate the stripped host', () => {
  assert.strictEqual(stripCredentials('https://github.com/O/a.git?next=x@evil/y'), 'https://github.com/O/a.git');
});

// --- round 3 ---
test('R3.4: a symlink inside the org pointing at a forbidden repo is refused, never opened', () => {
  const org = orgDir(); repo(org, 'q', { remote: 'https://h/o/q.git' });
  symlinkSync(join(org, 'q'), join(org, 'lnk'));
  const g = loggingGit();
  const r = cli(['--org', org, '--repos', 'lnk', '--forbid', 'q'], g.env);
  assert.strictEqual(r.status, 0, r.stderr);
  const s = byName(JSON.parse(r.stdout));
  assert.strictEqual(s.lnk.kind, 'symlink'); assert.strictEqual(s.lnk.suggested, false);
  assert.doesNotMatch(g.calls(), /\/(q|lnk)\b/);
});

test("R3.4: an '@' in the URL path keeps the host; copies are detected across ssh/https and case", () => {
  assert.strictEqual(byName(discover({ org: (() => { const o = orgDir(); repo(o, 'app', { remote: 'https://host/o/a@b.git' }); return o; })() })).app.remote, 'https://host/o/a@b.git');
  const org = orgDir();
  repo(org, 'app', { remote: 'git@github.com:Org/App.git' }); repo(org, 'dup', { remote: 'https://github.com/org/app.git' });
  assert.strictEqual(byName(discover({ org })).dup.kind, 'copy');
});

// OG-19(d)/F21: two repos sharing a remote with NEITHER named like it (no "original") both keep kind
// 'repo' and each names the other in its reason, instead of exercising a path no test ever hit.
test('OG-19(d): two repos sharing a remote, neither named like it, both keep kind repo and name each other', () => {
  const org = orgDir();
  repo(org, 'alpha', { remote: 'git@github.com:Org/real-name.git' });
  repo(org, 'beta', { remote: 'git@github.com:Org/real-name.git' });
  const s = byName(discover({ org }));
  assert.strictEqual(s.alpha.kind, 'repo');
  assert.strictEqual(s.beta.kind, 'repo');
  assert.match(s.alpha.reasons.join(' '), /shares its origin with beta/);
  assert.match(s.beta.reasons.join(' '), /shares its origin with alpha/);
});
