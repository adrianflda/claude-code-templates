// How the gate calls git. Every call reads the object store as a fresh clone would and runs no
// command taken from repo-local config:
// - GIT_NO_REPLACE_OBJECTS: `git replace` makes cat-file/ls-tree/diff return substitute content
//   under the ORIGINAL object id — one porcelain command forged a PASS.
// - core.fsmonitor=false: a command local config can set; some git calls run it.
// - GIT_ATTR_NOSYSTEM: system gitattributes are not part of the committed tree.
// - inherited GIT_DIR-style variables would point every `-C <repo>` call at another repository.
import { spawnSync } from 'node:child_process';

const REDIRECT_VARS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE'];

export function gateGitEnv(base = process.env) {
  const env = { ...base, GIT_NO_REPLACE_OBJECTS: '1', GIT_ATTR_NOSYSTEM: '1' };
  for (const k of REDIRECT_VARS) delete env[k];
  return env;
}

const ENV = gateGitEnv();
export function git(repo, args, opts = {}) {
  return spawnSync('git', ['-C', repo, '-c', 'core.fsmonitor=false', ...args], { encoding: 'utf8', ...opts, env: ENV });
}
