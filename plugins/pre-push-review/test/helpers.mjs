import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts');

export function tempDir(prefix) {
  return realpathSync(mkdtempSync(join(tmpdir(), `${prefix}-`)));
}

export function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** A repository with one commit on `main`. */
export function makeRepo(prefix, files = { 'README.md': 'hello\n' }) {
  const dir = tempDir(prefix);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  write(dir, files);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  return dir;
}

export function write(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
}

export function executable(path, source) {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
  return path;
}

/** Run a script with JSON on stdin; never throws. */
export function runNode(script, { args = [], input = '', cwd, env = {} } = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    input,
    encoding: 'utf8',
    env: { ...cleanEnv(), ...env },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** The developer's own review settings must not leak into a test. */
function cleanEnv() {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(AI_REVIEW_|PREPUSH_REVIEW_|CLAUDE_PLUGIN_ROOT$|CLAUDE_BIN$)/.test(name)) delete env[name];
  }
  return env;
}
