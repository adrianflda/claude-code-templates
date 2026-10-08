import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
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

/**
 * A plugin root with the real runner and installer next to a fake panel. The panel records
 * what it saw and then behaves as told: FAKE_PANEL_EXIT is its exit code, FAKE_PANEL_OUT its
 * stdout, FAKE_PANEL_KILL makes it die from a signal, FAKE_PANEL_HANG makes it never finish.
 */
export function fakePlugin({ withPanel = true } = {}) {
  const root = tempDir('plugin');
  mkdirSync(join(root, 'scripts'));
  for (const f of ['git-pre-push.mjs', 'install-git-hook.mjs']) {
    copyFileSync(join(SCRIPTS, f), join(root, 'scripts', f));
  }
  if (withPanel) {
    executable(
      join(root, 'scripts', 'ai-review-panel.mjs'),
      `import { appendFileSync } from 'node:fs';
appendFileSync(process.env.FAKE_PANEL_LOG, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), required: process.env.AI_REVIEW_REQUIRED, skip: process.env.AI_REVIEW_SKIP, prepushSkip: process.env.PREPUSH_REVIEW_SKIP }) + '\\n');
if (process.env.FAKE_PANEL_GRANDCHILD) {
  const { spawn } = await import('node:child_process');
  const { writeFileSync } = await import('node:fs');
  const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
  writeFileSync(process.env.FAKE_PANEL_LOG + '.child', String(c.pid));
}
if (process.env.FAKE_PANEL_KILL) process.kill(process.pid, 'SIGKILL');
if (process.env.FAKE_PANEL_HANG) await new Promise(() => setInterval(() => {}, 1000));
process.stdout.write(process.env.FAKE_PANEL_OUT ?? 'SUMMARY: 0 critical\\n[pre-push-review] Passed. No blocking issues.\\n');
process.exit(Number(process.env.FAKE_PANEL_EXIT ?? 0));
`,
    );
  }
  return root;
}

/** Install the plugin's gate into a fresh HOME (its ~/.gitconfig). */
export function installGate(plugin, home = tempDir('home')) {
  const r = runNode(join(plugin, 'scripts', 'install-git-hook.mjs'), { env: { HOME: home } });
  if (r.code !== 0) throw new Error(`install failed: ${r.stderr}`);
  return home;
}

/** The developer's own review settings must not leak into a test. */
function cleanEnv() {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(AI_REVIEW_|PREPUSH_REVIEW_|GIT_CONFIG|CLAUDE_PLUGIN_ROOT$|CLAUDE_BIN$)/.test(name)) delete env[name];
  }
  return env;
}
