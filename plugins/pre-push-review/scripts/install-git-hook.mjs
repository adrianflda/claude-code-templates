#!/usr/bin/env node
/**
 * pre-push-review — installs the single global review gate as a git config hook.
 *
 *   node install-git-hook.mjs          install (idempotent)
 *   node install-git-hook.mjs --check  exit 0 if installed, otherwise exit 1 and say why
 *
 * Install sets, in the GLOBAL git config only:
 *
 *   hook.ai-review.event   = pre-push
 *   hook.ai-review.command = node <this plugin>/scripts/git-pre-push.mjs
 *
 * and, when the global core.hooksPath points at a directory whose pre-push hook runs the old
 * ~/.config/git-ai-review harness (a second, unversioned copy of the review), unsets it so a
 * push is reviewed once. Repository-local config is never touched. GIT_CONFIG_GLOBAL selects
 * another global config file (used by the tests).
 *
 * Requires git >= 2.54 (config-based hooks).
 */
import { spawnSync } from 'child_process';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const runner = resolve(here, 'git-pre-push.mjs');
const wanted = `node ${/[^\w@%+=:,./-]/.test(runner) ? `'${runner.replace(/'/g, `'\\''`)}'` : runner}`;

const git = (...args) => spawnSync('git', ['config', '--global', ...args], { encoding: 'utf8' });
const getAll = (key) => {
  const r = git('--get-all', key);
  return r.status === 0 ? r.stdout.split('\n').filter(Boolean) : [];
};

/** The global core.hooksPath when its pre-push runs the old harness; otherwise null. */
function oldHarnessPath() {
  const [raw] = getAll('core.hooksPath').slice(-1);
  if (!raw) return null;
  const dir = raw.replace(/^~(?=\/|$)/, homedir());
  const prePush = join(dir, 'pre-push');
  try {
    return /git-ai-review/.test(readFileSync(prePush, 'utf8')) ? raw : null;
  } catch {
    return null;
  }
}

const events = getAll('hook.ai-review.event');
const commands = getAll('hook.ai-review.command');
const legacy = oldHarnessPath();

if (process.argv.includes('--check')) {
  const problems = [];
  if (!events.includes('pre-push')) problems.push('hook.ai-review.event is not set to pre-push in the global git config');
  if (commands.length !== 1) problems.push('hook.ai-review.command is not set exactly once in the global git config');
  else if (commands[0] !== wanted) problems.push(`hook.ai-review.command is "${commands[0]}", expected "${wanted}"`);
  if (!existsSync(runner)) problems.push(`the runner is missing: ${runner}`);
  if (legacy) problems.push(`the global core.hooksPath (${legacy}) still runs the old git-ai-review harness: pushes would be reviewed twice`);
  if (problems.length) {
    process.stderr.write(`pre-push-review gate is NOT installed correctly:\n- ${problems.join('\n- ')}\nRun: node ${join(here, 'install-git-hook.mjs')}\n`);
    process.exit(1);
  }
  process.stdout.write('pre-push-review gate is installed.\n');
  process.exit(0);
}

if (!existsSync(runner)) {
  process.stderr.write(`The runner is missing: ${runner}\n`);
  process.exit(1);
}

const must = (r, what) => {
  if (r.status !== 0) {
    process.stderr.write(`Could not ${what}: ${r.stderr.trim() || `git exited ${r.status}`}\n`);
    process.exit(1);
  }
};

const changes = [];
if (!(events.length === 1 && events[0] === 'pre-push')) {
  must(git('--replace-all', 'hook.ai-review.event', 'pre-push'), 'set hook.ai-review.event');
  changes.push('set global hook.ai-review.event = pre-push');
}
if (!(commands.length === 1 && commands[0] === wanted)) {
  must(git('--replace-all', 'hook.ai-review.command', wanted), 'set hook.ai-review.command');
  changes.push(`set global hook.ai-review.command = ${wanted}`);
}
if (legacy) {
  const others = (() => {
    try {
      return readdirSync(legacy.replace(/^~(?=\/|$)/, homedir())).filter((f) => f !== 'pre-push' && !f.startsWith('.'));
    } catch {
      return [];
    }
  })();
  must(git('--unset-all', 'core.hooksPath'), 'unset core.hooksPath');
  changes.push(`unset global core.hooksPath (was ${legacy}; its pre-push ran the old git-ai-review harness)`);
  if (others.length) {
    changes.push(
      `WARNING: ${legacy} also holds ${others.join(', ')}; those hooks no longer run in repositories without their own core.hooksPath. Set core.hooksPath back yourself if you still need them.`,
    );
  }
}

if (!changes.length) process.stdout.write('Already installed: nothing changed.\n');
else process.stdout.write(`Installed. Changes to the global git config:\n- ${changes.join('\n- ')}\n`);
process.stdout.write('Repository-local git config was not touched.\n');
