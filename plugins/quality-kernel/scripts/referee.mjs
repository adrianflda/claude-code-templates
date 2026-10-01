#!/usr/bin/env node
// Re-executing verification referee — M0 (v2.2). Spec: docs/agentic-harness/spec-m0-referee.v1.md.
// Rework rationale + honest limits: docs/agentic-harness/validation-panel.{v1,v2}.md
//
// It does NOT trust any agent's "done" claim, and it does NOT trust the worktree. It verifies a
// COMMITTED target (`--head <sha>`, default HEAD) against a COMMITTED base (`--base <sha>`), reads
// the real exit status, and fails closed on any uncertainty.
//
// Layers (each must hold, else indeterminate/fail):
//  - PRECONDITIONS the gate validates (panel v2.1 finding A/C): every changed path must be either
//    overlaid production, a recognized test/harness file, or inert docs — otherwise the gate cannot
//    verify it, so it is indeterminate ("declare it in productionGlobs"). A path that is production
//    AND matches a harness/test pattern is ambiguous -> indeterminate.
//  - TRUSTED run: full BASE tree, with ONLY head PRODUCTION overlaid (productionGlobs minus an
//    immutable harness denylist). Tests/fixtures/helpers/runners/manifests/configs stay at base.
//  - HARNESS INTEGRITY (finding B): the non-overlaid files are hashed before setup and after verify;
//    any mutation (a build step rewriting its own test) -> indeterminate.
//  - HEAD-AS-IS run: the full committed head, so code outside productionGlobs and head's own new
//    tests execute too. Both runs must be green.
//  - ACCEPTANCE (optional, Constitution P3): a human-approved suite distinct from the coder's tests,
//    run against the immutable trusted tree.
//
// HONEST LIMITS (NOT covered by M0+M1 — the M2 live-breaker's job): in-process oracle subversion
// (production code the tests import can monkeypatch node:assert or call process.exit(0)), gate
// fingerprinting, and a baseline with genuinely no tests. Only a black-box probe in a
// prod-indistinguishable environment closes these. Symlinks in a committed tree => indeterminate.
//
// Usage:  referee.mjs --repo <dir> --base <ref> [--head <ref>] [--workspace <dir>] [--workspace-ref <ref>]
//         [--no-ledger] [--canary]
//         (with an explicit --workspace, the workspace's contract for this repo wins; see workspace.mjs;
//         --canary: after a green run, re-run on head with every test file raising — it must go RED;
//         this shows the command exits non-zero when test files are broken — NOT that it executes
//         them (a linter that parses them passes too) nor which tests run)
// Exit:   0 = PASS · 1 = real FAIL · 2 = indeterminate (fail-closed)

import { spawnSync } from 'node:child_process';
import { existsSync, statSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, readlinkSync, rmSync, appendFileSync, lstatSync, symlinkSync, openSync, closeSync, readSync, chmodSync, rmdirSync } from 'node:fs';
import { join, dirname, isAbsolute, normalize } from 'node:path';
import { tmpdir, devNull } from 'node:os';
import { randomBytes, createHash } from 'node:crypto';
import { globToRegExp, TEST_GLOBS, isLedger } from './route.mjs';
import { git, readVerifiedBlob } from './safe-git.mjs';
import { findWorkspace, showWorkspaceFile, workspaceSource, repoSource } from './workspace.mjs';
import { canaryMatcher, sabotage } from './canary.mjs';

// CONVERGENCE FIX (panel v2.6 root cause): there is NO silent "inert" / "harness-by-name" allow-list
// of changes the gate skips — that path-name allow-list always leaked a real runtime input (a prompt
// .md, a file named changelog-parser, a lib/spec/** module). Every changed path is put in EXACTLY one
// category and each category has an explicit, non-silent disposition:
//   production  (in productionGlobs)         -> overlaid from head onto the base tree and VERIFIED
//   test        (in testGlobs)               -> stays at base, EXECUTED (immutable oracle)
//   manifest    (package.json/pyproject/...) -> production fields drive runtime -> indeterminate on change
//   everything else changed/removed          -> indeterminate ("declare it in productionGlobs")
// Want cheap docs/prompts/config? Declare them in productionGlobs — overlaying prose is harmless and
// makes anything read at runtime actually verifiable.
const MANIFEST_GLOBS = [
  '**/package.json', '**/package-lock.json', '**/npm-shrinkwrap.json', '**/pnpm-lock.yaml', '**/pnpm-workspace.yaml', '**/yarn.lock',
  '**/pyproject.toml', '**/setup.py', '**/setup.cfg', '**/requirements*.txt', '**/Pipfile', '**/Pipfile.lock', '**/poetry.lock',
  '**/Cargo.toml', '**/Cargo.lock', '**/go.mod', '**/go.sum', '**/Gemfile', '**/Gemfile.lock', '**/composer.json', '**/composer.lock',
];
// Test/runner/config files that must NEVER be overlaid from head (panel S2/S3 root cause). This is
// the BROAD set used for the "what to overlay" decision — deliberately wider than the declared test
// roots, so a nested test (packages/*/test/**, src/test/**) or a runner config under productionGlobs
// is NOT overlaid; the change cannot rewrite its own oracle. A path that is BOTH production and in
// this set is ambiguous (fail-closed) — the operator narrows productionGlobs to source only.
const HARNESS_DENYLIST = [
  '**/.quality-kernel/**', '**/Makefile*', '**/.npmrc', '**/.gitattributes',
  '**/jest.config.*', '**/vitest.config.*', '**/vite.config.*', '**/playwright.config.*', '**/cypress.config.*',
  '**/webpack.config.*', '**/rollup.config.*', '**/tsup.config.*', '**/esbuild.config.*',
  '**/tsconfig*.json', '**/.eslintrc*', '**/.prettierrc*', '**/.babelrc*', '**/babel.config.*', '**/.mocharc.*',
  '**/conftest.py', '**/pytest.ini', '**/tox.ini',
  // oracle/test-support components (panel T1/T2/T3): assertion helpers, mocks, stubs, fixtures.
  '**/__mocks__/**', '**/mocks/**', '**/stubs/**', '**/fixtures/**', '**/testing/**',
  '**/test-utils/**', '**/testutils/**', '**/test-helpers/**', '**/testUtils.*', '**/test_utils.*', '**/test-utils.*', '**/testHelpers.*',
  '**/node_modules/**', '**/vendor/**',
];
// Base content that marks a file as an ORACLE component (imports a real test/assertion framework),
// so a file NAMED like production but importing one is never overlaid (panel T-class, by content).
const ORACLE_IMPORT_RE = /(?:from|require\s*\(|import\s*\(?)\s*['"](?:node:test|node:assert(?:\/strict)?|assert|vitest|jest|mocha|chai|sinon|ava|tape|jasmine|power-assert|should|expect|@testing-library|@jest\/globals)/;
// A production file must not read from a declared-test root (panel S4).
const TEST_ROOT_REF_RE = /['"`](?:\.\.?\/)*(?:tests?|__tests__)\//;
// The NARROW, anchored set for the SEPARATE "which change is allowed unverified" decision (panel S1):
// only unambiguous test locations/suffixes. Go/Python conventions (*_test.*, test_*.*) are NOT here
// by default — declare them in tools.json "testGlobs" for those repos.
const DEFAULT_TEST_GLOBS = ['**/*.test.*', '**/*.spec.*', '**/__tests__/**', 'tests/**', 'test/**'];
const DEGENERATE_GLOBS = new Set(['**', '**/*', '**/**', '*']);
// package.json fields that drive runtime resolution / the dependency (supply-chain) surface.
// "scripts" is in this set because the verify command itself is usually a script entry
// (the documented default is `npm test`): if scripts.test is swapped for a no-op, the trusted
// base run and the head-as-is run stop meaning the same thing and the referee would PASS a
// change that replaced its own oracle.
const PKG_PROD_FIELDS = ['name', 'main', 'module', 'browser', 'exports', 'imports', 'type', 'bin', 'scripts', 'dependencies', 'peerDependencies', 'optionalDependencies', 'bundledDependencies', 'overrides', 'resolutions', 'workspaces', 'files', 'packageManager', 'pnpm', 'engines'];
const DEFAULT_LINK_PATHS = []; // opt-in: linking worktree dirs is a trust assumption (panel N6). Prefer verifySetup.

function emit(v) { process.stdout.write(JSON.stringify(v) + '\n'); }
function ledgerAppend(repoDir, record) {
  if (noLedger) return; // e.g. /init-workspace verification must not write into product repos
  try {
    const dir = join(repoDir, '.quality-kernel');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'evidence-ledger.jsonl'),
      JSON.stringify({ ts: Math.round(Date.now()) / 1000, source: 'referee', ...record }) + '\n');
  } catch { /* audit write must never affect the verdict */ }
}
function indeterminate(reason) { emit({ pass: false, indeterminate: true, evidence: null, reason }); process.exit(2); }

// --- args ---
const args = process.argv.slice(2);
let repo = null, base = null, head = 'HEAD', workspaceDir, workspaceRef, noLedger = false, canaryMode = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--repo') repo = args[++i];
  else if (args[i] === '--base') base = args[++i];
  else if (args[i] === '--head') head = args[++i];
  else if (args[i] === '--workspace') workspaceDir = args[++i] ?? ''; // present without a value = empty -> fails closed
  else if (args[i] === '--workspace-ref') workspaceRef = args[++i];
  else if (args[i] === '--no-ledger') noLedger = true; // audit-only: never affects the verdict
  else if (args[i] === '--canary') canaryMode = true; // a green run must also be seen RED (canary.mjs)
}
if (!repo) indeterminate('missing --repo <dir>');
if (!existsSync(repo) || !statSync(repo).isDirectory()) indeterminate(`repo not found or not a directory: ${repo}`);
{ // filteredPath() uses `git check-attr --source`, added in git 2.40
  const found = (git(repo, ['--version']).stdout || '').trim();
  const [maj, min] = (found.match(/(\d+)\.(\d+)/) || []).slice(1).map(Number);
  if (!(maj > 2 || (maj === 2 && min >= 40))) indeterminate(`git >= 2.40 is required (found: ${found || 'no git'})`);
}
if (!base) indeterminate('missing --base <ref> (the committed baseline to verify head against)');
if (git(repo, ['rev-parse', '--is-inside-work-tree']).status !== 0) {
  indeterminate(`not a git work tree: ${repo}`);
}
for (const ref of [base, head]) {
  if (git(repo, ['rev-parse', '--verify', `${ref}^{commit}`]).status !== 0) {
    indeterminate(`unverifiable ref "${ref}" (need a committed base..head; worktree is never trusted)`);
  }
}
const show = (ref, path, enc = 'utf8') => git(repo, ['show', `${ref}:${path}`], { encoding: enc });

// --- contract from the BASE ref (immutable to the change) ---
// A contract missing at base is often one the user's own ignore rules kept out of `git add`
// (a global excludesfile listing .quality-kernel/ is common, since the ledger lives there).
// Only the rule's location is reported, never its pattern text: an ignore file is worktree state the
// change controls, and the reason may be read by an agent. --no-index keeps the probe off the index
// (and, with the safe-git pins, off any fsmonitor command).
function ignoreHint(path) {
  if (!existsSync(join(repo, path))) return '';
  const r = git(repo, ['check-ignore', '--no-index', '-v', '-z', '--stdin'], { input: `${path}\0`, encoding: 'utf8' });
  if (r.status !== 0) return '';
  const [source, line, pattern] = r.stdout.split('\0');
  if (!pattern || pattern.startsWith('!')) return ''; // a negation rule means the file is NOT ignored
  const where = `${source}:${line}`.replace(/[\x00-\x1f\x7f]/g, '?');
  return ` — it exists in the worktree but an ignore rule excludes it (${where}); commit it with \`git add -f ${path}\``;
}
// Where the contract comes from. Without --workspace: the repo's base ref, as always. With an
// explicit --workspace (see workspace.mjs for the trust model): the workspace's file at the pinned
// workspace commit WINS; the repo's own base file is used only when the workspace has none, and a
// workspace that cannot serve this repo is indeterminate — never a silent single-repo fallback.
let toolsSource = repoSource(base);
function loadToolsAtBase() {
  let text = null;
  const ws = findWorkspace(repo, { workspace: workspaceDir, ref: workspaceRef });
  if (ws && ws.error) indeterminate(`workspace mode: ${ws.error}`);
  // Both reads are hash-verified: altered stored bytes fail closed, never read as "absent".
  if (ws) {
    try { text = showWorkspaceFile(ws, 'tools.json'); } catch (e) { indeterminate(e.message); }
    if (text !== null) toolsSource = workspaceSource(ws);
  }
  if (text === null) {
    const own = readVerifiedBlob(repo, base, '.quality-kernel/tools.json');
    if (own.error) indeterminate(`contract integrity: ${own.error}`);
    if (!own.absent) text = own.text;
  }
  if (text === null) {
    const inWs = ws ? `no tools.json in the workspace (repos/${ws.name}/ at ${ws.sha.slice(0, 12)}) nor ` : 'no ';
    indeterminate(`${inWs}.quality-kernel/tools.json at base ${base} (the verify contract must be committed in the baseline)${ignoreHint('.quality-kernel/tools.json')}`);
  }
  let j; try { j = JSON.parse(text); } catch (e) { indeterminate(`unreadable tools.json (${toolsSource.source}${toolsSource.sha ? ` ${toolsSource.sha.slice(0, 12)}` : ''}) at base ${base}: ${e.message}`); }
  if (!j || typeof j.verify !== 'string' || !j.verify.trim()) indeterminate('tools.json "verify" must be a non-empty string at base');
  if (!Array.isArray(j.productionGlobs) || j.productionGlobs.length === 0) indeterminate('tools.json "productionGlobs" must be a non-empty array at base');
  for (const g of j.productionGlobs) {
    if (typeof g !== 'string' || DEGENERATE_GLOBS.has(g.trim())) indeterminate(`productionGlobs entry "${g}" is too broad — use narrow source globs like "src/**"`);
  }
  for (const g of (Array.isArray(j.outputGlobs) ? j.outputGlobs : [])) {
    if (typeof g !== 'string' || DEGENERATE_GLOBS.has(g.trim())) indeterminate(`outputGlobs entry "${g}" is too broad — it would disable the created-file check; name specific build/coverage dirs like "dist/**"`);
  }
  for (const g of (Array.isArray(j.testGlobs) ? j.testGlobs : [])) {
    if (typeof g !== 'string' || DEGENERATE_GLOBS.has(g.trim())) indeterminate(`testGlobs entry "${g}" is too broad`);
  }
  return {
    verify: j.verify.trim(),
    productionGlobs: j.productionGlobs,
    testGlobs: Array.isArray(j.testGlobs) && j.testGlobs.length ? j.testGlobs : DEFAULT_TEST_GLOBS,
    acceptance: typeof j.acceptance === 'string' && j.acceptance.trim() ? j.acceptance.trim() : null,
    verifySetup: typeof j.verifySetup === 'string' && j.verifySetup.trim() ? j.verifySetup.trim() : null,
    linkPaths: Array.isArray(j.linkPaths) ? j.linkPaths : DEFAULT_LINK_PATHS,
    outputGlobs: Array.isArray(j.outputGlobs) ? j.outputGlobs : [],
  };
}
const tools = loadToolsAtBase();
const match = (globs) => { const res = globs.map(globToRegExp); return (p) => res.some((re) => re.test(p)); };
const rawProd = match(tools.productionGlobs);
const isDeclaredTest = match(tools.testGlobs);   // NARROW: which change is allowed unverified (S1)
const isManifest = match(MANIFEST_GLOBS);
const isOutput = match(tools.outputGlobs);
// BROAD: what must never be overlaid from head (S2/S3). Wider than the declared test roots on purpose.
const isNeverOverlay = match([...TEST_GLOBS, ...HARNESS_DENYLIST, ...MANIFEST_GLOBS]);
// A file is overlaid from head iff it is production AND not in the broad never-overlay set.
const isProd = (p) => rawProd(p) && !isNeverOverlay(p);

// H3 (enforcement, not convention): the ACCEPTANCE oracle is meant to be an INDEPENDENT,
// human-approved check, immutable from base. If its command executes a file that is overlaid
// production (head-controlled), the change controls its own acceptance oracle. Refuse. (A build step
// inside verify/verifySetup running overlaid code is the DECLARED execution-trust limit; its concrete
// file-manipulation forms are caught by the harness-integrity checks below.)
if (tools.acceptance) {
  for (const tok of tools.acceptance.match(/[\w@./-]+\.(?:mjs|cjs|js|jsx|ts|tsx|py|rb|go|sh)\b/g) || []) {
    const p = tok.replace(/^\.\//, '');
    if (isProd(p)) indeterminate(`the acceptance oracle executes "${p}", which is overlaid production code (head-controlled) — the change would control its own acceptance oracle. Move it out of productionGlobs (e.g. an acceptance/ dir declared in testGlobs).`);
  }
}

const childEnv = { ...process.env };
delete childEnv.NODE_TEST_CONTEXT;

function diffPaths() {
  const d = git(repo, ['diff', '-z', '--name-status', '-M', `${base}..${head}`]);
  if (d.status !== 0) indeterminate(`git diff base..head failed: ${(d.stderr || '').trim()}`);
  const parts = d.stdout.split('\0'); const changed = [], deleted = []; let i = 0;
  while (i < parts.length) {
    const s = parts[i]; if (!s) { i++; continue; }
    const c = s[0];
    if (c === 'R' || c === 'C') { const oldp = parts[i + 1], newp = parts[i + 2]; i += 3; if (c === 'R' && oldp) deleted.push(oldp); if (newp) changed.push(newp); }
    else { const p = parts[i + 1]; i += 2; if (!p) continue; if (c === 'D') deleted.push(p); else if (c === 'T') { deleted.push(p); changed.push(p); } else changed.push(p); }
  }
  return { changed, deleted };
}

// A manifest's production fields drive runtime resolution / the dependency surface, which re-running
// the base suite (resolved via the BASE manifest) cannot verify. package.json is field-checked;
// any other manifest/lockfile change is treated as unverifiable.
function manifestChangeIsBenign(p) {
  if (!/(^|\/)package\.json$/.test(p)) return false; // only package.json gets the field-level pass
  const parse = (ref) => { const r = show(ref, p); if (r.status !== 0) return {}; try { return JSON.parse(r.stdout) || {}; } catch { return null; } };
  const bj = parse(base), hj = parse(head);
  if (bj === null || hj === null) return false;
  return PKG_PROD_FIELDS.every((f) => JSON.stringify(bj[f]) === JSON.stringify(hj[f]));
}

// --- PRECONDITIONS: every changed/removed path gets an EXPLICIT disposition; nothing is silently
// skipped (panel v2.6 root cause). production=overlaid+verified · test=executed · manifest=field-check
// · anything else => indeterminate ("declare it in productionGlobs"). ---
const diff = diffPaths();
// ignore the tool's own append-only audit ledgers (a committed evidence/run ledger must not trip the gate)
diff.changed = diff.changed.filter((p) => !isLedger(p));
diff.deleted = diff.deleted.filter((p) => !isLedger(p));
// Option B (panel U2): tests the PR MODIFIED are overlaid from head so a legitimate behavior change
// (code + its test updated together) verifies green; the router forces such a change to human review
// (a test edit is a contract change). Tests the PR did NOT touch stay at base, so breaking covered
// code without editing its test is still mechanically blocked.
const changedTest = new Set(diff.changed.filter(isDeclaredTest));
const dispose = (p, removed) => {
  const prod = rawProd(p), nover = isNeverOverlay(p), t = isDeclaredTest(p), m = isManifest(p);
  // (1) production glob that also matches a test/harness/manifest pattern -> would not be overlaid,
  //     so it cannot be verified: fail-closed (restores the v2.2-v2.6 defense of ATTACK B, S2/S3).
  if (prod && nover) indeterminate(`"${p}" matches productionGlobs but also a test/harness/manifest pattern — ambiguous; the gate will not overlay it, so it cannot be verified. Narrow productionGlobs to source only, or declare it in testGlobs.`);
  if (prod) return;                                   // (2) overlaid from head + verified
  if (t) return;                                      // (3) declared test: executed, immutable-from-base
  if (m) { if (!manifestChangeIsBenign(p)) indeterminate(`manifest "${p}" changed in a way that affects runtime resolution / dependencies — not verifiable by re-running the base suite; needs human review`); return; }
  // (4) looks like a test/harness/config file but is NOT a declared test and NOT production.
  if (nover) indeterminate(`"${p}" ${removed ? 'was removed' : 'changed'} — it looks like a test/harness/config file but is not a declared test. If it is production, add it to productionGlobs; if a test, add it to testGlobs; a build/test-config change needs human review.`);
  // (5) anything else the gate has no way to verify.
  indeterminate(`"${p}" ${removed ? 'was removed' : 'changed'} but is not covered by productionGlobs and is not a declared test — the gate cannot verify it. Declare it in productionGlobs (overlaying docs/prompts/config/assets is safe and makes anything read at runtime verifiable).`);
};
for (const p of diff.changed) dispose(p, false);
for (const p of diff.deleted) dispose(p, true);
// Content checks over overlaid production files: an oracle component named like production (T-class),
// or production reading from a test root (S4). Both make the run unverifiable -> indeterminate.
for (const p of diff.changed) {
  if (!isProd(p)) continue;
  const b = show(base, p); if (b.status === 0 && ORACLE_IMPORT_RE.test(b.stdout)) indeterminate(`"${p}" is under productionGlobs but its base content imports a test/assertion framework — it is an oracle component, not code under test; move it out of productionGlobs or declare it in testGlobs`);
  const h = show(head, p); if (h.status === 0 && TEST_ROOT_REF_RE.test(h.stdout)) indeterminate(`"${p}" (production) references a declared-test root (tests/ or __tests__/) — production must not read from the test harness; move the file it needs out of the test root`);
}

// --- committed-tree listing + symlink rejection ---
function lsTree(ref) {
  const r = git(repo, ['ls-tree', '-r', '-z', ref]);
  if (r.status !== 0) return null;
  const out = [];
  for (const chunk of r.stdout.split('\0')) {
    if (!chunk) continue;
    const t = chunk.indexOf('\t'); if (t < 0) continue;
    const [mode, type, oid] = chunk.slice(0, t).split(' ');
    out.push({ mode, type, oid, path: chunk.slice(t + 1) });
  }
  return out;
}
const baseEntries = lsTree(base), headEntries = lsTree(head);
if (!baseEntries || !headEntries) indeterminate('could not list base/head tree');
// A crafted tree (git hash-object --literally) can hold entries named '..', '.' or '', or names
// containing '/', which git itself refuses to check out. Materialized, they alias other paths in the
// temp tree — overwriting a base harness file with head content forged a PASS. Refuse them, along
// with .git components (the harness snapshot skips .git dirs) and duplicate paths.
function unsafePath(p) {
  for (const c of p.split('/')) {
    if (c === '' || c === '.' || c === '..' || c.includes('\\')) return true;
    const n = c.toLowerCase().replace(/[. ]+$/, '');
    if (n === '.git' || /^git~\d+$/.test(n)) return true;
  }
  return false;
}
for (const [ref, entries] of [[base, baseEntries], [head, headEntries]]) {
  const seen = new Set();
  for (const e of entries) {
    if (unsafePath(e.path)) indeterminate(`unsafe path in the committed tree of ${ref}: ${JSON.stringify(e.path)}`);
    if (seen.has(e.path)) indeterminate(`duplicate path in the committed tree of ${ref}: ${JSON.stringify(e.path)}`);
    seen.add(e.path);
  }
}
const sym = [...baseEntries, ...headEntries].find((e) => e.mode === '120000');
if (sym) indeterminate(`symlink in a committed tree is not allowed under the gate: ${sym.path}`);
// W6: on a case-insensitive / normalization-insensitive filesystem, two distinct committed paths
// collapse to one inode when materialized (last-writer-wins), so the tree the gate runs is not the tree
// git records and the verdict is platform-dependent. Refuse rather than verify a lie.
{
  const seen = new Map();
  for (const e of [...baseEntries, ...headEntries]) {
    const key = e.path.normalize('NFC').toLowerCase();
    const prev = seen.get(key);
    if (prev && prev !== e.path) indeterminate(`case/normalization-colliding paths "${prev}" and "${e.path}" cannot be materialized faithfully on all filesystems`);
    seen.set(key, e.path);
  }
}
// Trees are materialized from raw blobs (below), so checkout-time conversions are never applied: a
// path with a filter attribute (e.g. Git LFS) would be verified as its placeholder. Refuse rather
// than verify content the project never runs. check-attr also reads $GIT_DIR/info/attributes (it
// cannot be switched off), so a filter set there refuses too — fail-closed.
function filteredPath(ref, entries) {
  const paths = entries.filter((e) => e.type === 'blob').map((e) => e.path);
  if (paths.length === 0) return null;
  const r = git(repo, ['-c', `core.attributesFile=${devNull}`, 'check-attr', '--source', ref, '-z', '--stdin', 'filter'],
    { input: paths.join('\0') + '\0' });
  if (r.status !== 0) indeterminate(`cannot read the attributes of ${ref}: ${(r.stderr || '').trim()}`);
  const f = r.stdout.split('\0');
  for (let i = 0; i + 2 < f.length; i += 3) if (f[i + 2] !== 'unspecified' && f[i + 2] !== 'unset') return f[i];
  return null;
}
for (const [ref, entries] of [[base, baseEntries], [head, headEntries]]) {
  const p = filteredPath(ref, entries);
  if (p) indeterminate(`"${p}" has a filter attribute for ${ref} (committed .gitattributes, or $GIT_DIR/info/attributes; e.g. Git LFS): the gate verifies committed bytes and would run the filter's placeholder, not the file the project uses`);
}

// --- tree building ---
// indeterminate() ends the process with process.exit, which skips `finally` blocks, so temp
// trees are also removed from an exit handler.
const tempTrees = new Set();
process.on('exit', () => {
  for (const d of tempTrees) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort; keep cleaning the rest */ } }
});
function tmpDir() { const d = mkdtempSync(join(tmpdir(), randomBytes(6).toString('hex'))); tempTrees.add(d); return d; }
function safeJoin(root, p) { const d = normalize(join(root, p)); return (d === root || d.startsWith(root + '/')) ? d : null; }
function readFully(fd, buf, pos) {
  let off = 0;
  while (off < buf.length) { const n = readSync(fd, buf, off, buf.length - off, pos + off); if (n === 0) break; off += n; }
  return off;
}
// Write a committed tree from raw blobs (`git cat-file --batch`, no shell, no conversion). `git archive`
// applied checkout conversions driven by uncommitted state — $GIT_DIR/info/attributes, filter drivers
// in local/global config, core.autocrlf — which could flip the verdict either way (a smudge filter
// neutering the base harness turned a real FAIL into PASS). The batch output is staged through a temp
// file and copied one blob at a time, so a large repo is not buffered in memory.
// Each blob is re-hashed against its committed id: git does not verify objects on read, so a
// rewritten loose object or an alternate store would otherwise feed different bytes under the same
// id. (Tree and commit objects are still trusted — see README "Honest limits".)
// Returns null on success, or the reason the tree could not be materialized.
const OBJECT_FORMAT = (git(repo, ['rev-parse', '--show-object-format']).stdout || '').trim() || 'sha1';
const MAX_BLOB_BYTES = Number(process.env.QK_MAX_BLOB_BYTES) || 256 * 1024 * 1024;
function materialize(entries, into) {
  const blobs = entries.filter((e) => e.type === 'blob');
  const batch = join(tmpdir(), `qk-${randomBytes(8).toString('hex')}.batch`);
  const fd = openSync(batch, 'wx+', 0o600); // exclusive, owner-only: it holds repo contents
  try {
    const r = git(repo, ['cat-file', '--batch'], { input: blobs.map((e) => e.oid).join('\n') + '\n', stdio: ['pipe', fd, 'pipe'] });
    if (r.status !== 0) return `git cat-file --batch failed: ${(r.stderr || '').toString().trim()}`;
    const header = Buffer.alloc(256);
    let pos = 0;
    for (const e of blobs) {
      const nl = header.subarray(0, readFully(fd, header, pos)).indexOf(10);
      if (nl < 0) return `unreadable object header for ${e.path}`;
      const [oid, type, size] = header.subarray(0, nl).toString('latin1').split(' ');
      if (oid !== e.oid || type !== 'blob') return `object for ${e.path} is not the committed blob`;
      if (Number(size) > MAX_BLOB_BYTES) return `blob for ${e.path} is ${size} bytes (limit ${MAX_BLOB_BYTES}; set QK_MAX_BLOB_BYTES)`;
      pos += nl + 1;
      const dest = safeJoin(into, e.path);
      if (!dest) return `unsafe path in committed tree: ${e.path}`;
      const body = Buffer.alloc(Number(size));
      if (readFully(fd, body, pos) !== body.length) return `truncated blob for ${e.path}`;
      const actual = createHash(OBJECT_FORMAT).update(`blob ${body.length}\0`).update(body).digest('hex');
      if (actual !== e.oid) return `blob for ${e.path} does not hash to its committed id (the object store was altered)`;
      const mode = e.mode === '100755' ? 0o755 : 0o644;
      try {
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, body);
        chmodSync(dest, mode); // an overlay overwrites an existing base file: mode on create is not enough
      } catch (err) { return `could not write ${e.path}: ${err.code || err.message}`; }
      pos += body.length + 1;
    }
  } finally {
    closeSync(fd);
    try { rmSync(batch, { force: true }); } catch { /* temp cleanup is best-effort */ }
  }
  for (const e of entries.filter((x) => x.type === 'commit')) { // submodule gitlink: empty dir, like a checkout
    const d = safeJoin(into, e.path);
    if (!d) return `unsafe path in committed tree: ${e.path}`;
    try { mkdirSync(d, { recursive: true }); } catch (err) { return `could not create ${e.path}: ${err.code || err.message}`; }
  }
  return null;
}
function linkDeps(root) {
  for (const lp of tools.linkPaths) {
    if (typeof lp !== 'string' || isAbsolute(lp) || lp.includes('..')) continue;
    const src = join(repo, lp), dest = safeJoin(root, lp);
    if (dest && existsSync(src) && !existsSync(dest)) { try { symlinkSync(src, dest); } catch { /* verify reports a missing dep */ } }
  }
}
// Snapshot every non-symlink file (sha256 + kernel ctime). Finding B (X4/X5): ctime is kernel-set and
// cannot be forged by the same user, so it catches a write-then-restore that leaves sha unchanged; the
// path SET catches files a setup/verify step CREATES. Finding Y (v2.3): the ignore set is MINIMAL —
// only dependency/VCS dirs (which a provisioning step legitimately fills) — so a build that plants a
// subverted module in build/dist/__pycache__/coverage is NO LONGER hidden; legitimate build/coverage
// output must be declared in tools.json "outputGlobs". A fake vendored dependency inside node_modules
// (Y1) is the residual execution-trust limit: keep verifySetup to immutable tooling (npm ci) from the
// base lockfile — do not let it run overlaid head code.
const IGNORE_DIRS = new Set([...tools.linkPaths.filter((x) => typeof x === 'string'),
  'node_modules', '.venv', 'venv', 'vendor', '.git']);
function snapshot(root) {
  const map = new Map();
  const walk = (dir, rel) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (IGNORE_DIRS.has(ent.name)) continue;
      const abs = join(dir, ent.name), r = rel ? `${rel}/${ent.name}` : ent.name;
      // Symlinks are RECORDED, not skipped (panel Z5): a symlink created during the run — pointing
      // e.g. into an ignored dir — would otherwise smuggle in a module the immutable tests import.
      if (ent.isSymbolicLink()) { map.set('L:' + r, readlinkSync(abs)); continue; }
      if (ent.isDirectory()) walk(abs, r);
      else if (ent.isFile()) map.set('F:' + r, { sha: createHash('sha256').update(readFileSync(abs)).digest('hex'), ctime: statSync(abs).ctimeMs });
    }
  };
  walk(root, '');
  return map;
}

function buildTrustedTree() {
  const tmp = tmpDir();
  const baseErr = materialize(baseEntries, tmp);
  if (baseErr) indeterminate(`could not materialize base: ${baseErr}`);
  // defence in depth: every committed base file must exist in the harness tree.
  for (const e of baseEntries) {
    const d = safeJoin(tmp, e.path);
    if (!d || !existsSync(d)) indeterminate(`base file "${e.path}" did not materialize — cannot trust an incomplete harness`);
  }
  const headPaths = new Set(headEntries.map((e) => e.path));
  const overlay = (p) => isProd(p) || changedTest.has(p); // production + the PR's own modified tests
  const overlaid = headEntries.filter((x) => overlay(x.path));
  // production removed at head goes first, so a file that became a directory (or the reverse) can
  // take its place; a directory left empty by that is removed, one that still holds harness files
  // is a conflict the gate cannot resolve.
  for (const e of baseEntries.filter((x) => isProd(x.path))) { if (!headPaths.has(e.path)) { const d = safeJoin(tmp, e.path); if (d) rmSync(d, { force: true }); } }
  for (const e of overlaid) {
    const dest = safeJoin(tmp, e.path);
    if (!dest || !existsSync(dest)) continue;
    const st = lstatSync(dest);
    if (st.isSymbolicLink()) indeterminate(`overlay target is a symlink: ${e.path}`);
    if (st.isDirectory()) { try { rmdirSync(dest); } catch { indeterminate(`head file "${e.path}" replaces a base directory that still holds harness files`); } }
  }
  const overlayErr = materialize(overlaid, tmp);
  if (overlayErr) indeterminate(`could not overlay head: ${overlayErr}`);
  linkDeps(tmp);
  return tmp;
}
function buildHeadTree() {
  const tmp = tmpDir();
  const headErr = materialize(headEntries, tmp);
  if (headErr) indeterminate(`could not materialize head: ${headErr}`);
  linkDeps(tmp);
  return tmp;
}

function run(cmd, cwd, label) {
  const r = spawnSync(cmd, { cwd, shell: true, encoding: 'utf8', env: childEnv, timeout: 300000 });
  if (r.error || r.status === null || r.status === undefined) indeterminate(`${label} could not complete: "${cmd}" (${r.signal ? `timed out (${r.signal})` : (r.error ? r.error.message : 'no exit status')})`);
  if ((r.status === 127 || r.status === 126) && !(r.stdout && r.stdout.trim())) indeterminate(`${label} not executable (exit ${r.status}): "${cmd}"`);
  return r.status;
}
function setup(cwd, label) { if (tools.verifySetup) { const s = run(tools.verifySetup, cwd, `${label} setup`); if (s !== 0) indeterminate(`${label} setup failed (exit ${s}): "${tools.verifySetup}"`); } }

// TRUSTED run + harness-integrity check
const trusted = buildTrustedTree();
let trustedExit, acceptanceExit = null;
try {
  const before = snapshot(trusted);
  setup(trusted, 'trusted');
  trustedExit = run(tools.verify, trusted, 'verify (base harness × head production)');
  if (tools.acceptance) acceptanceExit = run(tools.acceptance, trusted, 'acceptance oracle');
  const after = snapshot(trusted);
  const bail = (msg) => { rmSync(trusted, { recursive: true, force: true }); indeterminate(msg); };
  for (const [k, b] of before) {
    const a = after.get(k); const p = k.slice(2);
    if (a === undefined) bail(`the verify/setup chain removed an immutable harness ${k[0] === 'L' ? 'symlink' : 'file'}: "${p}"`);
    if (k[0] === 'L') { if (a !== b) bail(`the verify/setup chain re-pointed a symlink: "${p}"`); }
    else if (a.sha !== b.sha || a.ctime !== b.ctime) bail(`the verify/setup chain mutated an immutable harness file: "${p}" — cannot trust its result`);
  }
  for (const k of after.keys()) {
    if (before.has(k)) continue;
    const p = k.slice(2);
    if (k[0] === 'L') bail(`the verify/setup chain created a symlink in the verification tree: "${p}" — never legitimate`);
    if (!isOutput(p)) bail(`the verify/setup chain created a file in the verification tree: "${p}" — the chain must not write source/test files (declare legitimate build/coverage output in tools.json "outputGlobs"; put dependencies under linkPaths or provision them with verifySetup)`);
  }
} finally { rmSync(trusted, { recursive: true, force: true }); }

// HEAD-AS-IS run
const headTree = buildHeadTree();
let headExit;
try { setup(headTree, 'head'); headExit = run(tools.verify, headTree, 'verify (head as-is)'); }
finally { rmSync(headTree, { recursive: true, force: true }); }

const green = trustedExit === 0 && headExit === 0 && (acceptanceExit === null || acceptanceExit === 0);

// RED CANARY (--canary): the same command on head, with every test file raising on load, must fail.
// A command that still exits 0 runs no tests, so its green proves nothing (canary.mjs).
let canary = null;
if (canaryMode && green) {
  const isTarget = canaryMatcher(tools.testGlobs);
  const targets = headEntries.filter((e) => e.type === 'blob' && (e.mode === '100644' || e.mode === '100755') && isTarget(e.path));
  // Structured outcome for callers (ws-verify): `canary.proven` is false when the command was never
  // seen RED, whatever the wording of `reason`.
  const unproven = (why, extra = {}) => {
    emit({ pass: false, indeterminate: true, canary: { proven: false, ...extra }, evidence: null, reason: `RED canary: ${why}` });
    process.exit(2);
  };
  if (!targets.length) unproven('head has no JS/TS/Python test file to sabotage, so this command cannot be shown to ever fail', { sabotaged: 0, exit: null });
  const tree = buildHeadTree();
  let canaryExit;
  try {
    const sabotaged = new Map();
    for (const e of targets) {
      const dest = safeJoin(tree, e.path);
      if (!dest || lstatSync(dest).isSymbolicLink()) unproven(`cannot sabotage "${e.path}"`, { sabotaged: 0, exit: null });
      const bytes = sabotage(e.path, readFileSync(dest));
      writeFileSync(dest, bytes);
      sabotaged.set(dest, bytes);
    }
    setup(tree, 'canary');
    canaryExit = run(tools.verify, tree, 'RED canary (head with every test file raising)');
    // A setup/verify step that restores the test files would undo the sabotage unseen.
    for (const [dest, bytes] of sabotaged) {
      let now = null;
      try { now = lstatSync(dest).isFile() ? readFileSync(dest) : null; } catch { now = null; }
      if (!now || !now.equals(bytes)) unproven(`the verify/setup chain rewrote or removed a sabotaged test file ("${dest.slice(tree.length + 1)}") — the canary result cannot be trusted`, { sabotaged: targets.length, exit: canaryExit });
    }
  } finally { rmSync(tree, { recursive: true, force: true }); }
  canary = { proven: canaryExit !== 0, exit: canaryExit, sabotaged: targets.length };
}
const canaryGreen = !!canary && canary.exit === 0;
const pass = green && !canaryGreen;
ledgerAppend(repo, { verify: tools.verify, tools_source: toolsSource, acceptance: tools.acceptance, base, head, trusted_exit: trustedExit, head_exit: headExit, acceptance_exit: acceptanceExit, ...(canary ? { canary_exit: canary.exit } : {}), pass });
if (canaryGreen) {
  emit({
    pass: false, indeterminate: true, canary,
    evidence: { verify: tools.verify, toolsSource, trustedExit, headExit, acceptance: tools.acceptance, acceptanceExit, base, head, overlaidTests: [...changedTest], canary },
    reason: `RED canary stayed green: "${tools.verify}" exited 0 with all ${canary.sabotaged} test file(s) raising on load — it loads no test file (or swallows its failure), so its green proves nothing`,
  });
  process.exit(2);
}
emit({
  pass,
  evidence: { verify: tools.verify, toolsSource, trustedExit, headExit, acceptance: tools.acceptance, acceptanceExit, base, head, overlaidTests: [...changedTest], ...(canary ? { canary } : {}) },
  ...(canary ? { canary } : {}),
  reason: pass
    ? `verified: base harness × head production green + head-as-is green${acceptanceExit === null ? '' : ' + acceptance oracle green'}${canary ? ` + RED canary red (exit ${canary.exit}, ${canary.sabotaged} test file(s) sabotaged)` : ''} (re-executed)`
    : trustedExit !== 0
      ? `the immutable base harness failed (exit ${trustedExit}) against head production — the change likely neutered/removed its tests or broke covered code (re-executed)`
      : headExit !== 0
        ? `the head-as-is suite failed (exit ${headExit}) — head contains a genuine regression (re-executed)`
        : `the acceptance oracle failed (exit ${acceptanceExit}) (re-executed)`,
});
process.exit(pass ? 0 : 1);
