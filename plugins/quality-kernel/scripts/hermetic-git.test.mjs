import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, devNull } from 'node:os';
import { join } from 'node:path';
import { hermeticGitEnv } from './hermetic-git.mjs';

// The developer environment the tests must be immune to: a global excludesfile and an
// XDG default ignore file, both listing `.quality-kernel/`.
function hostileEnv(kind) {
  const root = mkdtempSync(join(tmpdir(), 'qk-hostile-'));
  const home = join(root, 'home');
  const xdg = join(root, 'xdg');
  mkdirSync(join(xdg, 'git'), { recursive: true });
  mkdirSync(home, { recursive: true });
  if (kind === 'global-excludesfile') {
    const ignore = join(root, 'gitignore_global');
    writeFileSync(ignore, '.quality-kernel/\n');
    writeFileSync(join(home, '.gitconfig'), `[core]\n\texcludesfile = ${ignore}\n`);
  } else {
    writeFileSync(join(xdg, 'git', 'ignore'), '.quality-kernel/\n');
  }
  // Start from the real env minus anything the hermetic module already injected.
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: xdg };
  for (const k of Object.keys(env)) if (/^GIT_CONFIG_/.test(k) || k === 'QK_HERMETIC_GIT') delete env[k];
  return { root, env };
}

function isIgnored(env) {
  const repo = mkdtempSync(join(tmpdir(), 'qk-hermetic-repo-'));
  try {
    spawnSync('git', ['-C', repo, 'init', '-q'], { env });
    mkdirSync(join(repo, '.quality-kernel'));
    writeFileSync(join(repo, '.quality-kernel', 'tools.json'), '{}');
    const r = spawnSync('git', ['-C', repo, 'check-ignore', '-q', '.quality-kernel/tools.json'], { env });
    assert.ok(r.status === 0 || r.status === 1, `check-ignore failed: ${r.stderr}`);
    return r.status === 0;
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

for (const kind of ['global-excludesfile', 'xdg-default-ignore']) {
  test(`hostile ${kind}: control ignores tools.json, hermetic env does not`, () => {
    const { root, env } = hostileEnv(kind);
    try {
      assert.strictEqual(isIgnored(env), true, 'control: the hostile config must ignore the file');
      assert.strictEqual(isIgnored(hermeticGitEnv(env)), false, 'hermetic env must not ignore the file');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('hermeticGitEnv appends to an existing GIT_CONFIG_COUNT instead of overwriting it', () => {
  const env = hermeticGitEnv({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'kept' });
  assert.strictEqual(env.GIT_CONFIG_COUNT, '3');
  assert.strictEqual(env.GIT_CONFIG_KEY_0, 'user.name');
  assert.strictEqual(env.GIT_CONFIG_VALUE_0, 'kept');
  assert.strictEqual(env.GIT_CONFIG_KEY_1, 'core.excludesFile');
  assert.strictEqual(env.GIT_CONFIG_VALUE_1, devNull);
  assert.strictEqual(env.GIT_CONFIG_KEY_2, 'core.attributesFile');
  assert.strictEqual(env.GIT_CONFIG_GLOBAL, devNull);
  assert.strictEqual(env.GIT_CONFIG_NOSYSTEM, '1');
});

test('importing the module applies the hermetic env to this process', () => {
  assert.strictEqual(process.env.GIT_CONFIG_GLOBAL, devNull);
  assert.strictEqual(process.env.GIT_CONFIG_NOSYSTEM, '1');
  assert.strictEqual(process.env.QK_HERMETIC_GIT, '1');
});
