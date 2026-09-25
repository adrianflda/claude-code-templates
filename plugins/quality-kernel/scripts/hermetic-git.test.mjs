import { hermeticGitEnv } from './hermetic-git.mjs';
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir, devNull } from 'node:os';
import { join, dirname } from 'node:path';

// Each hostile case is a real developer/hook environment the suite must be immune to. Every case
// runs its probe twice: the control (hostile env as-is) must show the effect — proving the setup is
// real — and the hermetic env must not.

const git = (env, cwd, ...a) => spawnSync('git', ['-C', cwd, ...a], { env, encoding: 'utf8' });
const ok = (r, what) => { assert.strictEqual(r.status, 0, `${what}: ${r.stderr}`); return r; };

// process.env is already hermetic (this file imports the module); rebuild a "developer" env on top.
function developerEnv(root) {
  const home = join(root, 'home'), xdg = join(root, 'xdg');
  mkdirSync(home, { recursive: true }); mkdirSync(join(xdg, 'git'), { recursive: true });
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: xdg };
  delete env.GIT_CONFIG_GLOBAL; delete env.GIT_CONFIG_NOSYSTEM; delete env.GIT_ATTR_NOSYSTEM;
  return { env, home, xdg };
}
let repoSeq = 0;
const repoName = () => `r${++repoSeq}`;

function freshRepo(env, root, name = 'repo') {
  const repo = join(root, name);
  mkdirSync(repo);
  ok(git(env, repo, 'init', '-q'), 'git init');
  ok(git(env, repo, 'config', 'user.email', 't@t'), 'config email');
  ok(git(env, repo, 'config', 'user.name', 't'), 'config name');
  return repo;
}

function markerHook(root) {
  const hooks = join(root, 'hooks'), marker = join(root, 'hook-ran');
  mkdirSync(hooks);
  writeFileSync(join(hooks, 'post-commit'), `#!/bin/sh\ntouch '${marker}'\n`);
  chmodSync(join(hooks, 'post-commit'), 0o755);
  return { hooks, marker };
}

// probe(env) -> true when the hostile effect happened
function ignoresToolsJson(root) {
  return (env) => {
    const repo = freshRepo(env, root, repoName());
    mkdirSync(join(repo, '.quality-kernel'));
    writeFileSync(join(repo, '.quality-kernel', 'tools.json'), '{}');
    const r = git(env, repo, 'check-ignore', '-q', '.quality-kernel/tools.json');
    assert.ok(r.status === 0 || r.status === 1, `check-ignore: ${r.stderr}`);
    return r.status === 0;
  };
}
function runsHook(root, marker) {
  return (env) => {
    rmSync(marker, { force: true });
    const repo = freshRepo(env, root, repoName());
    writeFileSync(join(repo, 'f'), 'x');
    ok(git(env, repo, 'add', 'f'), 'add');
    ok(git(env, repo, 'commit', '-qm', 'c'), 'commit');
    return existsSync(marker);
  };
}

const HOSTILE = {
  'global core.excludesfile lists .quality-kernel/': (root) => {
    const { env, home } = developerEnv(root);
    writeFileSync(join(root, 'ignore'), '.quality-kernel/\n');
    writeFileSync(join(home, '.gitconfig'), `[core]\n\texcludesfile = ${join(root, 'ignore')}\n`);
    return { env, probe: ignoresToolsJson(root) };
  },
  'XDG git/ignore lists .quality-kernel/': (root) => {
    const { env, xdg } = developerEnv(root);
    writeFileSync(join(xdg, 'git', 'ignore'), '.quality-kernel/\n');
    return { env, probe: ignoresToolsJson(root) };
  },
  'global core.hooksPath runs personal hooks': (root) => {
    const { env, home } = developerEnv(root);
    const { hooks, marker } = markerHook(root);
    writeFileSync(join(home, '.gitconfig'), `[core]\n\thooksPath = ${hooks}\n`);
    return { env, probe: runsHook(root, marker) };
  },
  'core.hooksPath via GIT_CONFIG_PARAMETERS (outer `git -c`)': (root) => {
    const { env } = developerEnv(root);
    const { hooks, marker } = markerHook(root);
    env.GIT_CONFIG_PARAMETERS = `'core.hookspath'='${hooks}'`;
    return { env, probe: runsHook(root, marker) };
  },
  'commit.gpgsign via GIT_CONFIG_COUNT': (root) => {
    const { env } = developerEnv(root);
    Object.assign(env, {
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'true',
      GIT_CONFIG_KEY_1: 'gpg.program', GIT_CONFIG_VALUE_1: 'false',
    });
    return {
      env,
      probe: (e) => {
        const repo = freshRepo(e, root, repoName());
        writeFileSync(join(repo, 'f'), 'x');
        ok(git(e, repo, 'add', 'f'), 'add');
        return git(e, repo, 'commit', '-qm', 'c').status !== 0;
      },
    };
  },
  'inherited GIT_DIR (suite run from a git hook)': (root) => {
    const { env } = developerEnv(root);
    const outer = freshRepo(env, root, 'outer');
    writeFileSync(join(outer, 'o'), 'o');
    ok(git(env, outer, 'add', 'o'), 'outer add'); ok(git(env, outer, 'commit', '-qm', 'o'), 'outer commit');
    const plain = { ...env };
    const count = () => Number(ok(git(plain, outer, 'rev-list', '--count', 'HEAD'), 'count').stdout.trim());
    // With GIT_DIR set and no GIT_WORK_TREE, git uses the cwd as work tree: the fixture's files are
    // committed into the outer repository.
    env.GIT_DIR = join(outer, '.git');
    return {
      env,
      probe: (e) => {
        const before = count();
        const fixture = join(root, `fx${++repoSeq}`);
        mkdirSync(fixture);
        git(e, fixture, 'init', '-q');
        git(e, fixture, 'config', 'user.email', 't@t'); git(e, fixture, 'config', 'user.name', 't');
        // unique content: a repeat run must not produce an empty (rejected) commit in the outer repo
        writeFileSync(join(fixture, 'f'), fixture);
        git(e, fixture, 'add', '-A'); git(e, fixture, 'commit', '-qm', 'fixture');
        return count() !== before;
      },
    };
  },
  'XDG git/attributes rewrites archived bytes (export-subst)': (root) => {
    const { env, xdg } = developerEnv(root);
    writeFileSync(join(xdg, 'git', 'attributes'), 'stamp.txt export-subst\n');
    return {
      env,
      probe: (e) => {
        const repo = freshRepo(e, root, repoName());
        writeFileSync(join(repo, 'stamp.txt'), '$Format:%H$');
        ok(git(e, repo, 'add', 'stamp.txt'), 'add'); ok(git(e, repo, 'commit', '-qm', 'c'), 'commit');
        return !ok(git(e, repo, 'archive', 'HEAD', 'stamp.txt'), 'archive').stdout.includes('$Format:%H$');
      },
    };
  },
  'GIT_TEMPLATE_DIR installs hooks into every git init': (root) => {
    const { env } = developerEnv(root);
    const template = join(root, 'template');
    const { hooks, marker } = markerHook(root);
    mkdirSync(template);
    ok(spawnSync('cp', ['-R', hooks, join(template, 'hooks')], { encoding: 'utf8' }), 'template hooks');
    env.GIT_TEMPLATE_DIR = template;
    return { env, probe: runsHook(root, marker) };
  },
};

for (const [name, make] of Object.entries(HOSTILE)) {
  test(`hostile env — ${name}: control shows the effect, hermetic env does not`, () => {
    const root = mkdtempSync(join(tmpdir(), 'qk-hostile-'));
    try {
      const { env, probe } = make(root);
      assert.strictEqual(probe(env), true, 'control: the hostile setup must take effect');
      assert.strictEqual(probe(hermeticGitEnv(env)), false, 'the hermetic env must neutralize it');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('repo-local config still wins over the pins (attack tests can plant local config)', () => {
  const root = mkdtempSync(join(tmpdir(), 'qk-local-'));
  try {
    const env = hermeticGitEnv();
    const repo = freshRepo(env, root);
    writeFileSync(join(root, 'local-ignore'), 'secret.txt\n');
    ok(git(env, repo, 'config', 'core.excludesFile', join(root, 'local-ignore')), 'local excludesFile');
    writeFileSync(join(repo, 'secret.txt'), 's');
    assert.strictEqual(git(env, repo, 'check-ignore', '-q', 'secret.txt').status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('hermeticGitEnv drops inherited git variables and does not mutate its input', () => {
  const base = {
    PATH: process.env.PATH, KEEP: 'yes',
    GIT_DIR: '/x', GIT_WORK_TREE: '/x', GIT_INDEX_FILE: '/x', GIT_OBJECT_DIRECTORY: '/x',
    GIT_ALTERNATE_OBJECT_DIRECTORIES: '/x', GIT_COMMON_DIR: '/x', GIT_NAMESPACE: 'n',
    GIT_CONFIG: '/x', GIT_CONFIG_PARAMETERS: "'a.b'='c'",
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_VALUE_0: 'c',
    GIT_TEMPLATE_DIR: '/x', GIT_CEILING_DIRECTORIES: '/x', GIT_EXEC_PATH: '/x',
  };
  const snapshot = { ...base };
  const env = hermeticGitEnv(base);
  assert.deepStrictEqual(base, snapshot, 'input must not be mutated');
  assert.deepStrictEqual(
    Object.keys(env).filter((k) => k.startsWith('GIT_')).sort(),
    ['GIT_ATTR_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'],
  );
  assert.strictEqual(env.KEEP, 'yes');
  assert.strictEqual(env.GIT_CONFIG_NOSYSTEM, '1');
  assert.strictEqual(env.GIT_ATTR_NOSYSTEM, '1');
  assert.strictEqual(readFileSync(env.GIT_CONFIG_GLOBAL, 'utf8'),
    `[core]\n\texcludesFile = ${devNull}\n\tattributesFile = ${devNull}\n`);
});

// The in-place rewrite of process.env is what protects every other test file; it only shows when the
// parent really exports git variables, so run a child process that does.
test('importing the module rewrites an inherited env and removes its temp config on exit', () => {
  const moduleUrl = new URL('./hermetic-git.mjs', import.meta.url).href;
  const script = `await import(${JSON.stringify(moduleUrl)}); process.stdout.write(JSON.stringify(process.env));`;
  const inherited = { ...process.env, GIT_DIR: '/nonexistent-qk', GIT_CONFIG_PARAMETERS: "'core.hookspath'='/x'", GIT_TEMPLATE_DIR: '/x' };
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: inherited, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const childEnv = JSON.parse(r.stdout);
  for (const k of ['GIT_DIR', 'GIT_CONFIG_PARAMETERS', 'GIT_TEMPLATE_DIR']) assert.strictEqual(childEnv[k], undefined, k);
  assert.strictEqual(childEnv.GIT_CONFIG_NOSYSTEM, '1');
  assert.ok(childEnv.GIT_CONFIG_GLOBAL && childEnv.GIT_CONFIG_GLOBAL !== process.env.GIT_CONFIG_GLOBAL, 'child pins its own config');
  assert.ok(!existsSync(dirname(childEnv.GIT_CONFIG_GLOBAL)), 'the pinned config dir is removed when the process exits');
});
