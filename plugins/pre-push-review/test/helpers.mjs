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

/**
 * Run a script with JSON on stdin; never throws. HOME is a fresh temporary directory unless the
 * test passes one: the scripts write under ~/.cache, and a test must never touch the developer's.
 */
export function runNode(script, { args = [], input = '', cwd, env = {} } = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    input,
    encoding: 'utf8',
    env: { ...cleanEnv(), HOME: tempDir('home'), ...env },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * A plugin root with the real runner and installer next to a fake panel. The panel records
 * what it saw and then behaves as told: FAKE_PANEL_EXIT is its exit code, FAKE_PANEL_OUT its
 * stdout, FAKE_PANEL_KILL makes it die from a signal (FAKE_PANEL_KILL_HEAD: only for that range's
 * head), FAKE_PANEL_HANG makes it never finish.
 */
export function fakePlugin({ withPanel = true, qkGate = false, realPanel = false } = {}) {
  // Laid out as in the plugins repo: <plugins>/pre-push-review next to <plugins>/quality-kernel.
  const root = join(tempDir('plugins'), 'pre-push-review');
  mkdirSync(join(root, 'scripts'), { recursive: true });
  if (qkGate) fakeQkGate(join(root, '..', 'quality-kernel', 'scripts', 'qk-gate.mjs'));
  for (const f of ['git-pre-push.mjs', 'install-git-hook.mjs', 'run-log.mjs']) {
    copyFileSync(join(SCRIPTS, f), join(root, 'scripts', f));
  }
  if (realPanel) {
    // The real panel (with its modules); the test supplies a `claude` stand-in through CLAUDE_BIN.
    for (const f of ['ai-review-panel.mjs', 'diff-budget.mjs', 'roles.mjs', 'verify.mjs']) {
      copyFileSync(join(SCRIPTS, f), join(root, 'scripts', f));
    }
  } else if (withPanel) {
    executable(
      join(root, 'scripts', 'ai-review-panel.mjs'),
      `import { appendFileSync } from 'node:fs';
appendFileSync(process.env.FAKE_PANEL_LOG, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), required: process.env.AI_REVIEW_REQUIRED, skip: process.env.AI_REVIEW_SKIP, prepushSkip: process.env.PREPUSH_REVIEW_SKIP, pushRef: process.env.AI_REVIEW_PUSH_REF ?? null }) + '\\n');
// FAKE_PANEL_FAIL_HEAD: report a critical issue only for the --range whose head is that sha.
if (process.env.FAKE_PANEL_FAIL_HEAD && process.argv.slice(2).at(-1) === process.env.FAKE_PANEL_FAIL_HEAD) {
  process.stdout.write('[CRITICAL] x.js:1 - broken on this range\\n');
  process.exit(1);
}
if (process.env.FAKE_PANEL_GRANDCHILD) {
  const { spawn } = await import('node:child_process');
  const { writeFileSync } = await import('node:fs');
  const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
  writeFileSync(process.env.FAKE_PANEL_LOG + '.child', String(c.pid));
}
// FAKE_PANEL_KILL_HEAD: die from a signal only for the --range whose head is that sha.
if (process.env.FAKE_PANEL_KILL || (process.env.FAKE_PANEL_KILL_HEAD && process.argv.slice(2).at(-1) === process.env.FAKE_PANEL_KILL_HEAD)) process.kill(process.pid, 'SIGKILL');
if (process.env.FAKE_PANEL_HANG) await new Promise(() => setInterval(() => {}, 1000));
process.stdout.write(process.env.FAKE_PANEL_OUT ?? 'SUMMARY: 0 critical\\n[pre-push-review] Passed. No blocking issues.\\n');
process.exit(Number(process.env.FAKE_PANEL_EXIT ?? 0));
`,
    );
  }
  return root;
}

/**
 * A fake quality-kernel gate. It records its cwd and args to FAKE_QK_LOG, prints a verdict JSON
 * line on stdout and exits FAKE_QK_EXIT (default 0); FAKE_QK_REASON is the referee reason;
 * FAKE_QK_HANG makes it never finish.
 */
export function fakeQkGate(path) {
  mkdirSync(dirname(path), { recursive: true });
  return executable(
    path,
    `import { appendFileSync } from 'node:fs';
if (process.env.FAKE_QK_LOG) appendFileSync(process.env.FAKE_QK_LOG, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), memLevel: process.env.QK_MEM_MAX_PRESSURE_LEVEL ?? null }) + '\\n');
if (process.env.FAKE_QK_HANG) await new Promise(() => setInterval(() => {}, 1000));\nif (process.env.FAKE_QK_SLEEP_MS) await new Promise((r) => setTimeout(r, Number(process.env.FAKE_QK_SLEEP_MS)));
process.stderr.write('[fake-qk] running\\n');
const head = process.argv[process.argv.indexOf('--head') + 1];\nconst code = process.env.FAKE_QK_FAIL_HEAD ? (head === process.env.FAKE_QK_FAIL_HEAD ? 1 : 0) : Number(process.env.FAKE_QK_EXIT ?? 0);
const gate = { 0: 'pass', 1: 'fail', 2: 'indeterminate', 3: 'blocked-needs-breaker' }[code] ?? 'weird';
process.stdout.write(JSON.stringify({ gate, referee: { reason: process.env.FAKE_QK_REASON ?? 'fake reason' }, notes: [] }) + '\\n');
process.exit(code);
`,
  );
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
    if (/^(AI_REVIEW_|PREPUSH_REVIEW_|QK_|GIT_CONFIG|CLAUDE_PLUGIN_ROOT$|CLAUDE_BIN$)/.test(name)) delete env[name];
  }
  return env;
}
