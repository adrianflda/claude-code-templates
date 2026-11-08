// The git the run journal reads with (spec §2, §5.2). Stricter than the gate's safe-git: the journal's
// answers (is this sha on the branch? which commits carry which QK-Task trailer?) must come from the
// repo's objects alone, so nothing from the caller's environment or the repo's config may bend them or
// run a program.
//  - Environment: every inherited GIT_* variable is dropped (GIT_CONFIG_PARAMETERS / GIT_CONFIG_COUNT,
//    GIT_GRAFT_FILE, GIT_CEILING_DIRECTORIES, GIT_DIR, ... — an allowlist of none), then the gate's
//    hardening is added (no replace objects, no system attributes) and grafts are pointed at /dev/null
//    (an empty graft file: `.git/info/grafts` is never read).
//  - Config: fsmonitor and commit-graph off (a forged commit-graph could change ancestry answers),
//    trailer separator fixed to ':' (a repo-set separator must not hide QK-Task trailers), signatures
//    never shown (log.showSignature would run the repo's gpg.program).
import { spawnSync } from 'node:child_process';
import { gateGitEnv } from '../safe-git.mjs';

export function journalGitEnv(base = process.env) {
  const env = Object.fromEntries(Object.entries(base).filter(([k]) => !k.startsWith('GIT_')));
  // LC_ALL=C: callers match git's own messages (e.g. "not a git repository"), never a translation.
  return { ...gateGitEnv(env), GIT_GRAFT_FILE: '/dev/null', LC_ALL: 'C', LANGUAGE: '' };
}
const ENV = journalGitEnv();
const CONFIG = ['core.fsmonitor=false', 'core.commitGraph=false', 'core.useReplaceRefs=false', 'trailer.separators=:', 'log.showSignature=false']
  .flatMap((c) => ['-c', c]);

export function git(dir, args, opts = {}) {
  return spawnSync('git', ['-C', dir, ...CONFIG, ...args], { encoding: 'utf8', ...opts, env: ENV });
}
