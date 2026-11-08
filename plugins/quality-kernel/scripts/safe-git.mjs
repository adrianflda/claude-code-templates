// How the gate calls git. Every call reads the object store as a fresh clone would and runs no
// command taken from repo-local config:
// - GIT_NO_REPLACE_OBJECTS: `git replace` makes cat-file/ls-tree/diff return substitute content
//   under the ORIGINAL object id — one porcelain command forged a PASS.
// - core.fsmonitor=false: a command local config can set; some git calls run it.
// - GIT_ATTR_NOSYSTEM: system gitattributes are not part of the committed tree.
// - inherited GIT_* variables: every one is dropped except GIT_CONFIG_GLOBAL / GIT_CONFIG_NOSYSTEM
//   (they only choose which user/system config file is read — the same trust as ~/.gitconfig, and
//   the tests pin them). GIT_DIR-style variables would point every `-C <repo>` call at another
//   repository; GIT_CONFIG_PARAMETERS / GIT_CONFIG_COUNT (set by any outer `git -c`) inject config;
//   GIT_GRAFT_FILE rewrites ancestry.
// - GIT_GRAFT_FILE=/dev/null: an empty graft file, so `.git/info/grafts` is never read either.
// - core.commitGraph=false: ancestry (merge-base, base..head) is read from the commits themselves,
//   not from a commit-graph file that code the gate ran could have rewritten.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { devNull } from 'node:os';

const KEPT_GIT_VARS = new Set(['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM']);

export function gateGitEnv(base = process.env) {
  const env = Object.fromEntries(Object.entries(base).filter(([k]) => {
    // Windows env names are case-insensitive (git_dir there is GIT_DIR): compare upper-cased.
    const K = k.toUpperCase();
    return !K.startsWith('GIT_') || KEPT_GIT_VARS.has(K);
  }));
  return { ...env, GIT_NO_REPLACE_OBJECTS: '1', GIT_ATTR_NOSYSTEM: '1', GIT_GRAFT_FILE: devNull };
}

const ENV = gateGitEnv();
const PINS = ['-c', 'core.fsmonitor=false', '-c', 'core.commitGraph=false'];
export function git(repo, args, opts = {}) {
  return spawnSync('git', ['-C', repo, ...PINS, ...args], { encoding: 'utf8', ...opts, env: ENV });
}

// Read a committed file whose bytes decide the verdict (a gate config), checked against its object
// id. git does not verify objects on read: a loose object rewritten in place (e.g. by code a gate
// executed) is returned under its original id by `git show` / `cat-file`. Returns { text }, or
// { absent: true } ONLY when the trees along the path read cleanly and have no such entry, or
// { error } for anything else — an unreadable/corrupt tree, a non-regular-file entry (symlink,
// directory, submodule), or blob bytes that do not hash to the id. Callers must treat { error } as
// fail-closed, never as "absent".
// Limit: the leaf blob is re-hashed; the commit and tree objects on the path are trusted (a tree
// rewritten in place with VALID content can point the path at another real blob) — see README
// "Honest limits". Closing that is per-repo isolation, not more checks here.
export function readVerifiedBlob(repo, rev, path) {
  const ls = git(repo, ['--literal-pathspecs', 'ls-tree', '-z', '--full-tree', '--end-of-options', rev, '--', path]);
  if (ls.status !== 0) return { error: `cannot read the tree of ${rev} for ${path}: ${(ls.stderr || '').trim() || `exit ${ls.status}`}` };
  const entry = ls.stdout.split('\0').filter(Boolean);
  if (entry.length === 0) return { absent: true };
  const [meta, entryPath] = entry[0].split('\t');
  const [mode, type, oid] = meta.split(' ');
  if (entry.length !== 1 || entryPath !== path) return { error: `unexpected tree entry for ${path} at ${rev}` };
  if (type !== 'blob' || (mode !== '100644' && mode !== '100755')) return { error: `${path} at ${rev} is not a regular file (mode ${mode}, ${type})` };
  const blob = git(repo, ['cat-file', 'blob', oid], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  if (blob.status !== 0) return { error: `${path} at ${rev} is not a readable blob` };
  const format = (git(repo, ['rev-parse', '--show-object-format']).stdout || '').trim() || 'sha1';
  const actual = createHash(format).update(`blob ${blob.stdout.length}\0`).update(blob.stdout).digest('hex');
  if (actual !== oid) return { error: `${path} at ${rev} does not hash to its id ${oid} (the object store was altered)` };
  return { text: blob.stdout.toString('utf8') };
}
