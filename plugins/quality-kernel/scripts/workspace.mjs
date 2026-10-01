// Workspace mode (explicit, opt-in with --workspace): an org folder holds its repos side by side plus
// a control repo (by convention named `workspace`) whose committed `workspace.json` lists the repos
// that form the system. In workspace mode the gate config of a listed repo — tools.json and
// critical-surface.json — comes from `workspace/repos/<name>/`, and it WINS over the repo's own.
//
// Trust model (read this before relying on it):
//  - The workspace ref is resolved ONCE to a commit SHA, fully qualified (a branch as origin/<ref>
//    or refs/heads/<ref> — both must agree when both exist — or a full commit SHA; tags can never
//    shadow it) and every file is read at that SHA, hash-verified against its blob id (safe-git
//    readVerifiedBlob), never from the worktree. So a repo's OWN change cannot supply or loosen
//    the rules it is checked against; qk-gate / qk-org-gate also re-check after the run that the
//    ref did not move.
//  - It does NOT protect against whoever can commit to the workspace ref, or chooses the ref: the
//    caller picks --workspace-ref, and that party owns the contract of every listed repo.
//  - Code the gate executes runs with the user's rights (execution-trust limit, README "Honest
//    limits"). Commit and tree objects are trusted — only the leaf blob is re-hashed — so code run
//    while gating one repo can rewrite a workspace tree in place (valid content, same id) and change
//    which blob a LATER repo of the same qk-org-gate run reads, undetected; it can also rewrite the
//    workspace for later runs, or the plugin's own scripts. A local-only workspace is anchored only
//    locally. The real fix for this class is per-repo isolation, not more checks.
//  - Without --workspace nothing here runs: single-repo behaviour is unchanged. Run route/referee
//    through qk-gate so both use the same pinned commit.
import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { git, readVerifiedBlob } from './safe-git.mjs';

const MANIFEST_VERSION = 1;
// A repo name is a plain sibling directory name; a file name is a plain file inside repos/<name>/.
const NAME = /^(?!\.{1,2}$)[A-Za-z0-9._ ()-]+$/;
const FILE = /^(?!\.{1,2}$)[A-Za-z0-9._-]+$/;
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

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

const commitOf = (dir, qualified) => {
  const r = git(dir, ['rev-parse', '--verify', '-q', '--end-of-options', `${qualified}^{commit}`]);
  return r.status === 0 ? r.stdout.trim() : null;
};

// A branch name or a full commit SHA -> the commit SHA, or null. A branch resolves as
// origin/<ref> and/or refs/heads/<ref>; when both exist they must be the same commit (otherwise
// which one is trusted is ambiguous -> null). Revision syntax (main~1), abbreviated SHAs, HEAD,
// tags, tree/blob ids and anything option-like are refused.
export function resolveWorkspaceRef(wsDir, ref) {
  if (typeof ref !== 'string' || !ref || ref.startsWith('-')) return null;
  if (FULL_SHA.test(ref)) return commitOf(wsDir, ref) === ref ? ref : null;
  if (ref === 'HEAD' || git(wsDir, ['check-ref-format', '--branch', ref]).status !== 0) return null;
  if (/[~^:@{}]/.test(ref)) return null;
  const remote = commitOf(wsDir, `refs/remotes/origin/${ref}`);
  const local = commitOf(wsDir, `refs/heads/${ref}`);
  if (remote && local && remote !== local) return null;
  return remote || local;
}

// A workspace file at the pinned commit, hash-verified: its text, null when absent, and a thrown
// error when the file cannot be read cleanly — altered blob bytes, a corrupt tree on the path, a
// non-regular-file entry (fail closed — never read as "absent"; see readVerifiedBlob's limit).
function showAt(dir, sha, path) {
  const r = readVerifiedBlob(dir, sha, path);
  if (r.error) throw new Error(`workspace integrity: ${r.error}`);
  return r.absent ? null : r.text;
}

// The committed manifest of the workspace repo at wsDir, pinned to the commit `ref` resolves to:
// { dir, ref, sha, repos, forbidden }, or null when wsDir is not a repo of its own, the ref does not
// resolve, or the manifest is missing / not a supported shape.
export function readWorkspaceManifest(wsDir, ref = 'main') {
  const top = topLevel(wsDir);
  if (!top || top !== realpathSync(wsDir)) return null;
  const sha = resolveWorkspaceRef(top, ref);
  if (!sha) return null;
  let raw;
  try { raw = showAt(top, sha, 'workspace.json'); } catch { return null; } // altered manifest = unusable
  if (raw === null) return null;
  let m;
  try { m = JSON.parse(raw); } catch { return null; }
  if (!m || m.version !== MANIFEST_VERSION || !m.repos || typeof m.repos !== 'object' || Array.isArray(m.repos)) return null;
  // A present-but-malformed deny list must not silently deny nothing.
  if (m.forbidden !== undefined && !(Array.isArray(m.forbidden) && m.forbidden.every((x) => typeof x === 'string'))) return null;
  return { dir: top, ref, sha, org: typeof m.org === 'string' ? m.org : null, repos: m.repos, forbidden: m.forbidden || [] };
}

// Workspace mode for repoDir.
//   opts.workspace undefined   -> null (mode off: single-repo behaviour)
//   workspace serves the repo  -> { dir, ref, sha, name }
//   anything else              -> { error } (explicit mode must fail closed, never fall back) —
//                                 including an empty value (e.g. `--workspace "$UNSET"`)
export function findWorkspace(repoDir, { workspace, ref = 'main' } = {}) {
  if (workspace === undefined) return null;
  if (typeof workspace !== 'string' || workspace === '') return { error: 'empty --workspace value (workspace mode needs the path of the workspace repo)' };
  const repoTop = topLevel(repoDir);
  if (!repoTop) return { error: `${repoDir} is not a git repository` };
  const wsTop = topLevel(workspace);
  if (!wsTop || wsTop !== realpathSync(workspace)) return { error: `workspace ${workspace} is not a git repository of its own` };
  if (wsTop === repoTop) return { error: 'a repo cannot be its own workspace' };
  const m = readWorkspaceManifest(wsTop, ref);
  if (!m) return { error: `no usable workspace.json (version ${MANIFEST_VERSION}) at ref "${ref}" of ${wsTop}` };
  const name = basename(repoTop);
  if (!isRepoName(name) || !own(m.repos, name)) return { error: `the workspace does not list "${name}"` };
  if (m.forbidden.includes(name)) return { error: `"${name}" is forbidden in the workspace` };
  const spec = m.repos[name];
  if (!spec || spec.role !== 'app') return { error: `"${name}" is listed with role ${JSON.stringify(spec && spec.role)}, only "app" is gated` };
  return { dir: m.dir, ref, sha: m.sha, name };
}

// Reads repos/<name>/<file> at the pinned workspace commit; null when absent or unsafe. Throws when
// the stored bytes do not hash to their id (callers fail closed).
export function showWorkspaceFile(ws, file) {
  if (!ws || ws.error || !ws.sha || typeof file !== 'string' || !FILE.test(file) || !isRepoName(ws.name)) return null;
  return showAt(ws.dir, ws.sha, `repos/${ws.name}/${file}`);
}

// Describes where a config came from, for evidence and ledgers.
export const workspaceSource = (ws) => ({ source: 'workspace', workspace: ws.dir, ref: ws.ref, sha: ws.sha });
export const repoSource = (base) => ({ source: 'repo', ref: base });
