import './hermetic-git.mjs';
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { gateGitEnv } from './safe-git.mjs';

// Contract (safe-git.mjs header): the gate's git answers come from the repo's objects alone. No
// inherited GIT_* variable except GIT_CONFIG_GLOBAL / GIT_CONFIG_NOSYSTEM reaches git; grafts (in the
// environment or in .git/info/grafts) and a commit-graph file never change ancestry.
const SAFE_GIT = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'safe-git.mjs')).href;

function fixture(t, tag = '') {
  const dir = mkdtempSync(join(tmpdir(), 'qk-safe-git-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const g = (...a) => {
    const r = spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  g('init', '-q', '-b', 'main');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', `base${tag}`);
  const base = g('rev-parse', 'HEAD');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'head');
  const head = g('rev-parse', 'HEAD');
  g('checkout', '-q', '--orphan', 'other');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'unrelated');
  const stranger = g('rev-parse', 'HEAD');
  g('checkout', '-q', 'main');
  return { dir, base, head, stranger, g };
}

// Runs safe-git's git() in a child whose environment is `env` (safe-git reads process.env at import).
function safeGit(dir, args, env = {}) {
  const code = `import { git } from ${JSON.stringify(SAFE_GIT)};
const r = git(${JSON.stringify(dir)}, ${JSON.stringify(args)});
process.stdout.write(JSON.stringify({ status: r.status, stdout: r.stdout, stderr: r.stderr }));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env: { ...process.env, ...env } });
  assert.strictEqual(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
const isAncestor = (f, env) => safeGit(f.dir, ['merge-base', '--is-ancestor', f.stranger, f.head], env).status;
const plainIsAncestor = (f, env = {}) => spawnSync('git', ['-C', f.dir, 'merge-base', '--is-ancestor', f.stranger, f.head],
  { env: { ...process.env, ...env } }).status;

test('a graft file named by GIT_GRAFT_FILE cannot forge ancestry', (t) => {
  const f = fixture(t);
  const grafts = join(f.dir, 'forged-grafts');
  writeFileSync(grafts, `${f.head} ${f.stranger}\n`);
  assert.strictEqual(plainIsAncestor(f, { GIT_GRAFT_FILE: grafts }), 0, 'control: plain git honours the graft');
  assert.strictEqual(isAncestor(f, { GIT_GRAFT_FILE: grafts }), 1);
});

test('a graft file in .git/info/grafts cannot forge ancestry', (t) => {
  const f = fixture(t);
  mkdirSync(join(f.dir, '.git', 'info'), { recursive: true });
  writeFileSync(join(f.dir, '.git', 'info', 'grafts'), `${f.head} ${f.stranger}\n`);
  assert.strictEqual(plainIsAncestor(f), 0, 'control: plain git honours the graft');
  assert.strictEqual(isAncestor(f), 1);
});

// Rewrites `child`'s first parent in a freshly written commit-graph to `parent`.
function forgeCommitGraphParent(f, child, parent) {
  const r = spawnSync('git', ['-C', f.dir, 'commit-graph', 'write', '--stdin-commits'], { input: `${child}\n${parent}\n`, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const file = join(f.dir, '.git', 'objects', 'info', 'commit-graph');
  const buf = readFileSync(file);
  const chunks = {};
  for (let i = 0; i < buf[6]; i++) chunks[buf.toString('latin1', 8 + i * 12, 12 + i * 12)] = Number(buf.readBigUInt64BE(12 + i * 12));
  const oids = Array.from({ length: buf.readUInt32BE(chunks.OIDF + 255 * 4) }, (_, i) => buf.toString('hex', chunks.OIDL + i * 20, chunks.OIDL + i * 20 + 20));
  const ci = oids.indexOf(child), pi = oids.indexOf(parent);
  assert.ok(ci >= 0 && pi >= 0, 'both commits are in the graph');
  buf.writeUInt32BE(pi, chunks.CDAT + ci * 36 + 20);
  chmodSync(file, 0o644);
  writeFileSync(file, buf);
}

test('a forged commit-graph file cannot forge ancestry', (t) => {
  const f = fixture(t);
  forgeCommitGraphParent(f, f.head, f.stranger);
  assert.strictEqual(plainIsAncestor(f), 0, 'control: plain git trusts the forged graph');
  assert.strictEqual(isAncestor(f), 1);
});

test('config injected through GIT_CONFIG_PARAMETERS or GIT_CONFIG_COUNT never reaches git', (t) => {
  const f = fixture(t);
  const viaParams = { GIT_CONFIG_PARAMETERS: "'qk.probe'='injected'" };
  const viaCount = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'qk.probe', GIT_CONFIG_VALUE_0: 'injected' };
  for (const env of [viaParams, viaCount]) {
    const control = spawnSync('git', ['-C', f.dir, 'config', '--get', 'qk.probe'], { encoding: 'utf8', env: { ...process.env, ...env } });
    assert.strictEqual(control.stdout.trim(), 'injected', 'control: plain git reads the injected config');
    const r = safeGit(f.dir, ['config', '--get', 'qk.probe'], env);
    assert.deepStrictEqual([r.status, r.stdout], [1, ''], JSON.stringify(env));
  }
});

test('an inherited GIT_DIR cannot redirect a call to another repository', (t) => {
  const f = fixture(t);
  const other = fixture(t, ' (other repo)');
  assert.notStrictEqual(other.head, f.head, 'the two repositories have different histories');
  const redirect = { GIT_DIR: join(other.dir, '.git') };
  const control = spawnSync('git', ['-C', f.dir, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: { ...process.env, ...redirect } });
  assert.strictEqual(control.stdout.trim(), other.head, 'control: plain git follows GIT_DIR');
  const r = safeGit(f.dir, ['rev-parse', 'HEAD'], redirect);
  assert.deepStrictEqual([r.status, r.stdout.trim()], [0, f.head]);
});

test('gateGitEnv keeps only the two config-file selectors, whatever the case of the name', () => {
  const env = gateGitEnv({ PATH: '/bin', GIT_CONFIG_GLOBAL: '/g', GIT_CONFIG_NOSYSTEM: '1', GIT_FOO: 'x',
    git_dir: '/elsewhere', Git_Graft_File: '/forged' });
  assert.deepStrictEqual(env, { PATH: '/bin', GIT_CONFIG_GLOBAL: '/g', GIT_CONFIG_NOSYSTEM: '1',
    GIT_NO_REPLACE_OBJECTS: '1', GIT_ATTR_NOSYSTEM: '1', GIT_GRAFT_FILE: env.GIT_GRAFT_FILE });
  assert.ok(env.GIT_GRAFT_FILE && env.GIT_GRAFT_FILE !== '/forged');
});

test('GIT_CONFIG_GLOBAL is still honoured (it only picks the user config file)', (t) => {
  const f = fixture(t);
  const cfg = join(f.dir, 'global-config');
  writeFileSync(cfg, '[qk]\n\tprobe = global\n');
  const r = safeGit(f.dir, ['config', '--get', 'qk.probe'], { GIT_CONFIG_GLOBAL: cfg });
  assert.deepStrictEqual([r.status, r.stdout.trim()], [0, 'global']);
});

test('the real ancestry answer is unchanged: base is an ancestor of head, the stranger is not', (t) => {
  const f = fixture(t);
  assert.strictEqual(safeGit(f.dir, ['merge-base', '--is-ancestor', f.base, f.head]).status, 0);
  assert.strictEqual(isAncestor(f), 1);
});
