// Test-only side-effect module: every git process the tests spawn (fixtures, and the
// gate/referee under test, which inherit process.env) ignores the developer's own git
// config. Without it, a global excludesfile listing `.quality-kernel/` keeps a fixture's
// tools.json out of the base commit and the gate exits 2; a global hooksPath runs the
// developer's hooks on every fixture commit. Import it first in any test that uses git.
import { devNull } from 'node:os';

// Pinned at command scope (highest precedence). excludesFile/attributesFile must be set
// explicitly: with no global config, git falls back to $XDG_CONFIG_HOME/git/{ignore,attributes}.
const PINNED = [
  ['core.excludesFile', devNull],
  ['core.attributesFile', devNull],
];

export function hermeticGitEnv(base = process.env) {
  const env = { ...base, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1' };
  let n = Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10) || 0;
  for (const [key, value] of PINNED) {
    env[`GIT_CONFIG_KEY_${n}`] = key;
    env[`GIT_CONFIG_VALUE_${n}`] = value;
    n += 1;
  }
  env.GIT_CONFIG_COUNT = String(n);
  return env;
}

// Apply once per process (node --test runs each file in its own process).
if (process.env.QK_HERMETIC_GIT !== '1') {
  Object.assign(process.env, hermeticGitEnv(), { QK_HERMETIC_GIT: '1' });
}
