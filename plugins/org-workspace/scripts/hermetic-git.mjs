// Test-only side-effect module: every git process the tests spawn (fixtures, and the
// gate/referee under test, which inherit process.env) ignores the developer's own git
// setup. Without it, a global excludesfile listing `.quality-kernel/` keeps a fixture's
// tools.json out of the base commit; a global hooksPath or commit.gpgsign (also when passed
// by an outer `git -c`) fails fixture commits; an inherited GIT_DIR (tests run from a git
// hook) makes fixtures commit into the outer repo. Import it first in any test that uses git.
//
// Repo-local config (.git/config) is NOT overridden: the pins live in a temporary *global*
// config, so a test can still model an attack that plants local config.
import { devNull, tmpdir } from 'node:os';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Every inherited GIT_* variable is dropped: an outer git (hook, `git -c`, worktree) redirects or
// configures child processes through many of them (GIT_DIR, GIT_CONFIG_PARAMETERS, GIT_TEMPLATE_DIR,
// ...), and an allowlist of what to keep is shorter and safer than a list of what to remove.

// excludesFile/attributesFile must be set explicitly: with no global value git falls back
// to $XDG_CONFIG_HOME/git/{ignore,attributes}.
const GLOBAL_CONFIG = `[core]\n\texcludesFile = ${devNull}\n\tattributesFile = ${devNull}\n`;

let globalConfigPath = null;
function pinnedGlobalConfig() {
  if (!globalConfigPath) {
    const dir = mkdtempSync(join(tmpdir(), 'qk-hermetic-git-'));
    globalConfigPath = join(dir, 'gitconfig');
    writeFileSync(globalConfigPath, GLOBAL_CONFIG);
    process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  }
  return globalConfigPath;
}

export function hermeticGitEnv(base = process.env) {
  const env = { ...base };
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k];
  env.GIT_CONFIG_GLOBAL = pinnedGlobalConfig();
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_ATTR_NOSYSTEM = '1';
  return env;
}

// Rewrite this process's env in place (node --test runs each file in its own process).
const hermetic = hermeticGitEnv();
for (const k of Object.keys(process.env)) if (!(k in hermetic)) delete process.env[k];
Object.assign(process.env, hermetic);
