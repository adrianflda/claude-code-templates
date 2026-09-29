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
import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { git, readVerifiedBlob } from './safe-git.mjs';

const MANIFEST_VERSION = 1;
// A repo name is a plain sibling directory name; a file name is a plain file inside repos/<name>/.
const NAME = /^(?!\.{1,2}$)[A-Za-z0-9._ ()-]+$/;
const FILE = /^(?!\.{1,2}$)[A-Za-z0-9._-]+$/;
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export const isRepoName = (name) => typeof name === 'string' && NAME.test(name);
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
  return { dir: top, ref, sha, repos: m.repos, forbidden: m.forbidden || [] };
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
