// Org mode (explicit, opt-in with --org <dir>): an org folder holds its repos side by side. Which
// repos form the system comes from the org guide that the org-workspace plugin writes
// (<org>/.claude/org-workspace/guide.json — the machine copy of the guide block in <org>/CLAUDE.md);
// the gate config of each app — tools.json and critical-surface.json — lives OUTSIDE every product
// repo, in <org>/.quality-kernel/repos/<name>/, and in org mode it WINS over the repo's own.
//
// Trust model (read this before relying on it):
//  - A repo's OWN change cannot supply or loosen its config: the files are outside every repo, so no
//    commit under review can touch them. Only plain files are read (a symlink anywhere on the path
//    is refused), with a size cap.
//  - The config is not versioned, so it is PINNED by content: qk-gate hashes the whole org config
//    once (orgPin), passes the hash to route and referee — each re-hashes and refuses a mismatch —
//    and re-checks it after the run; a change during the run makes the verdict indeterminate.
//  - It does NOT protect against whoever can write the org folder: that party owns every listed
//    repo's contract (as the owner of a config repo did before). Code the gate executes runs with the
//    user's rights (README "Honest limits"); the real fix for that class is per-repo isolation.
//  - Without --org nothing here runs: single-repo behaviour is unchanged.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { git } from './safe-git.mjs';

export const GUIDE_FILE = join('.claude', 'org-workspace', 'guide.json');
export const CONFIG_DIR = join('.quality-kernel', 'repos');
const MAX_FILE = 1024 * 1024;
// A repo name is a plain sibling directory name; a file name is a plain file inside repos/<name>/.
const NAME = /^(?!\.{1,2}$)[A-Za-z0-9._ ()-]+$/;
const FILE = /^(?!\.{1,2}$)[A-Za-z0-9._-]+$/;

export const isRepoName = (name) => typeof name === 'string' && NAME.test(name);

// The directory of a listed repo, only when it is a real directory directly under the org folder:
// never a symlink (it may point outside the org or at a forbidden repo, and discover never lists one),
// its real path must be exactly <real org>/<name> (also catches a case-folded name), and its git
// directory must be its own `.git` (see below). Check it before a listed repo is opened or run.
// Returns { dir } or { error }.
export function orgRepoDir(org, name) {
  if (!isRepoName(name)) return { error: `"${name}" is not a plain repo name` };
  const dir = join(org, name);
  let st;
  try { st = lstatSync(dir); } catch { return { error: `repo not found at ${dir}` }; }
  if (st.isSymbolicLink()) return { error: `${dir} is a symlink — refused (it may point outside the org folder or at a forbidden repo)` };
  if (!st.isDirectory()) return { error: `${dir} is not a directory` };
  let real, root;
  try { real = realpathSync.native(dir); root = realpathSync.native(org); } catch (err) { return { error: `cannot resolve ${dir}: ${err.code || err.message}` }; }
  if (real !== join(root, name)) return { error: `${dir} resolves to ${real}, not ${join(root, name)} — refused` };
  // Pin the repository itself, not just the path: a `.git` gitfile (`gitdir: ../forbidden/.git`), a
  // symlinked `.git`, a GIT_DIR/common-dir elsewhere or an object alternates file would make this
  // name read and run ANOTHER repo's committed code (e.g. a forbidden one). Linked worktrees are
  // refused for the same reason: gate the main checkout.
  const dotGit = join(real, '.git');
  let g;
  try { g = lstatSync(dotGit); } catch { return { error: `${dir} has no .git directory of its own — refused` }; }
  if (!g.isDirectory()) return { error: `${dir}/.git is ${g.isSymbolicLink() ? 'a symlink' : 'a gitfile (a linked worktree or a pointer to another repository)'} — refused` };
  for (const flag of ['--absolute-git-dir', '--git-common-dir']) {
    const r = git(real, ['rev-parse', '--path-format=absolute', flag]);
    let got = null;
    try { got = r.status === 0 ? realpathSync.native(r.stdout.trim()) : null; } catch { got = null; }
    if (got !== dotGit) return { error: `${dir}: git ${flag.replace(/^--/, '')} is ${got || 'unresolvable'}, not its own .git — refused` };
  }
  if (existsSync(join(dotGit, 'objects', 'info', 'alternates'))) return { error: `${dir}: its object store borrows objects from another repository (objects/info/alternates) — refused` };
  return { dir };
}
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// The real top level of the git work tree containing dir, or null.
function topLevel(dir) {
  if (typeof dir !== 'string' || !existsSync(dir) || !statSync(dir).isDirectory()) return null;
  const r = git(dir, ['rev-parse', '--show-toplevel']);
  return r.status === 0 ? realpathSync(r.stdout.trim()) : null;
}

// A plain file under the org folder: its text, null when absent; throws on a symlink, a non-file, an
// oversized file, or a symlinked directory on the way (callers fail closed).
function readPlain(root, rel) {
  let p = root;
  for (const part of rel.split('/')) {
    p = join(p, part);
    let st;
    try { st = lstatSync(p); } catch { return null; }
    if (st.isSymbolicLink()) throw new Error(`org config: ${p} is a symlink — refused`);
    if (p !== join(root, rel) && !st.isDirectory()) return null;
  }
  const st = lstatSync(p);
  if (!st.isFile()) throw new Error(`org config: ${p} is not a regular file`);
  if (st.size > MAX_FILE) throw new Error(`org config: ${p} is larger than ${MAX_FILE} bytes`);
  return readFileSync(p, 'utf8');
}

// The repos of the system, from the org guide: { org, repos: { name: { role, base, harness? } },
// forbidden }, or null when there is no usable guide.json (absent, not JSON, wrong shape).
export function readOrgManifest(orgDir) {
  let raw;
  try { raw = readPlain(realpathSync(orgDir), GUIDE_FILE.split('\\').join('/')); } catch { return null; }
  if (raw === null) return null;
  let g;
  try { g = JSON.parse(raw); } catch { return null; }
  if (!g || !Array.isArray(g.repos) || (g.forbidden !== undefined && !(Array.isArray(g.forbidden) && g.forbidden.every((x) => typeof x === 'string')))) return null;
  // Entries are kept as written (names and fields are validated per repo by the callers, so one bad
  // entry is reported for itself); an entry without a string name, or a duplicate name, makes the
  // whole guide unusable — which repo it meant is unknowable.
  const repos = {};
  for (const r of g.repos) {
    if (!r || typeof r !== 'object' || typeof r.name !== 'string' || !r.name || own(repos, r.name)) return null;
    repos[r.name] = { role: r.role, base: r.base };
  }
  for (const r of g.repos) if (typeof r.harnessOf === 'string' && own(repos, r.harnessOf) && repos[r.harnessOf].role === 'app') repos[r.harnessOf].harness = r.name;
  return { dir: realpathSync(orgDir), org: typeof g.org === 'string' ? g.org : null, repos, forbidden: g.forbidden || [] };
}

// A content hash of the whole org config (the guide + every file under .quality-kernel/repos/),
// so route, referee and the re-check after the run can tell they read the same bytes. Throws on a
// symlink anywhere in it.
export function orgPin(orgDir) {
  const root = realpathSync(orgDir);
  const h = createHash('sha256');
  const add = (rel) => { const t = readPlain(root, rel); h.update(`${rel}\0${t === null ? '\u0001absent' : t}\0`); };
  add(GUIDE_FILE.split('\\').join('/'));
  const walk = (rel) => {
    const abs = join(root, rel);
    let st;
    try { st = lstatSync(abs); } catch { return; }
    if (st.isSymbolicLink()) throw new Error(`org config: ${abs} is a symlink — refused`);
    if (!st.isDirectory()) return;
    for (const e of readdirSync(abs).sort()) {
      const r = `${rel}/${e}`;
      const s2 = lstatSync(join(root, r));
      if (s2.isSymbolicLink()) throw new Error(`org config: ${join(root, r)} is a symlink — refused`);
      if (s2.isDirectory()) walk(r); else add(r);
    }
  };
  walk(CONFIG_DIR.split('\\').join('/'));
  return h.digest('hex');
}

// Org mode for repoDir.
//   opts.org undefined      -> null (mode off: single-repo behaviour)
//   org serves the repo     -> { dir, pin, name }
//   anything else           -> { error } (explicit mode fails closed, never falls back) —
//                              including an empty value and a pin that no longer matches
export function findOrg(repoDir, { org, pin } = {}) {
  if (org === undefined) return null;
  if (typeof org !== 'string' || org === '') return { error: 'empty --org value (org mode needs the path of the org folder)' };
  if (!existsSync(org) || !statSync(org).isDirectory()) return { error: `org folder not found: ${org}` };
  const repoTop = topLevel(repoDir);
  if (!repoTop) return { error: `${repoDir} is not a git repository` };
  const root = realpathSync(org);
  if (repoTop === root) return { error: 'the org folder cannot be the repo itself' };
  const name = basename(repoTop);
  if (dirname(repoTop) !== root) return { error: `${repoTop} is not a repo directly under the org folder ${root}` };
  const entry = orgRepoDir(root, name);
  if (entry.error) return { error: entry.error };
  const m = readOrgManifest(root);
  if (!m) return { error: `no usable org guide at ${join(root, GUIDE_FILE)} (run /org-init from the org-workspace plugin)` };
  if (!own(m.repos, name)) return { error: `the org guide does not list "${name}"` };
  if (m.forbidden.includes(name)) return { error: `"${name}" is forbidden in the org guide` };
  if (m.repos[name].role !== 'app') return { error: `"${name}" is listed with role ${JSON.stringify(m.repos[name].role)}, only "app" is gated` };
  let now;
  try { now = orgPin(root); } catch (e) { return { error: e.message }; }
  if (pin !== undefined && pin !== now) return { error: `the org config changed since it was pinned (${String(pin).slice(0, 12)} -> ${now.slice(0, 12)})` };
  return { dir: root, pin: now, name };
}

// <org>/.quality-kernel/repos/<name>/<file>: its text, or null when absent. Throws on a symlink or
// a non-file (callers fail closed).
export function showOrgFile(o, file) {
  if (!o || o.error || !o.dir || typeof file !== 'string' || !FILE.test(file) || !isRepoName(o.name)) return null;
  return readPlain(o.dir, `${CONFIG_DIR.split('\\').join('/')}/${o.name}/${file}`);
}

// Describes where a config came from, for evidence and ledgers.
export const orgSource = (o) => ({ source: 'org', org: o.dir, pin: o.pin });
export const repoSource = (base) => ({ source: 'repo', ref: base });
