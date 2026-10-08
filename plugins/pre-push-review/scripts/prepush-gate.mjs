#!/usr/bin/env node
/**
 * pre-push-review — Claude Code PreToolUse GUARD.
 *
 * The review itself is done once, by git, in ./git-pre-push.mjs (a global git config hook,
 * see ./install-git-hook.mjs). This guard never runs the panel. It only makes sure that a
 * `git push` Claude is about to run will really go through that hook, and blocks the ways
 * Claude could get around it:
 *
 *  - the directory the push leaves from cannot be known, or is not a repository;
 *  - the global gate is not active for that repository (hook.ai-review not listed for
 *    pre-push, disabled, defined at another scope, or its command does not point at an
 *    existing git-pre-push.mjs);
 *  - bypass attempts: `--no-verify`, `-c core.hooksPath=...`, `-c hook....`, `--config-env`,
 *    GIT_CONFIG_* / PREPUSH_REVIEW_SKIP / AI_REVIEW_SKIP / AI_REVIEW_REQUIRED on the command or
 *    exported in this process's environment;
 *  - `git config` commands that change hook.ai-review.* or core.hooksPath;
 *  - a Bash call that would be killed before the review finishes (needs run_in_background or
 *    a timeout of at least 600000 ms).
 *
 * Fail closed: every doubt blocks. Protocol: reads the PreToolUse JSON on stdin; exit 0 =
 * no objection, exit 2 = block (stderr is fed back to the model). It never sets
 * `permissionDecision`: whether the push may run stays with the normal permission flow.
 *
 * This is a reading of a command line, not a shell, and a guard for the agent only. A human
 * in a terminal can still type `git push --no-verify`, and anything that edits the git config
 * file by other means is out of what a command line shows. True enforcement needs a
 * server-side check.
 */
import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { findPushTargets, splitCommands } from './push-target.mjs';

const MIN_TIMEOUT_MS = 600_000;
const here = dirname(fileURLToPath(import.meta.url));
const installer = join(process.env.CLAUDE_PLUGIN_ROOT || resolve(here, '..'), 'scripts', 'install-git-hook.mjs');

function readStdin() {
  return new Promise((res) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      if (data.length < 1_000_000) data += c;
    });
    process.stdin.on('end', () => res(data));
    setTimeout(() => res(data), 2000).unref?.();
  });
}

function block(message) {
  process.stderr.write(`pre-push-review BLOCKED this command: ${message}\n`);
  process.exit(2);
}

const raw = await readStdin();
let payload = {};
try {
  payload = JSON.parse(raw || '{}');
} catch {
  process.exit(0); // can't parse: don't interfere
}

const toolName = payload.tool_name || payload.toolName || '';
const input = payload.tool_input || payload.toolInput || {};
const command = input.command || '';
const baseCwd = payload.cwd || process.cwd();
if (toolName !== 'Bash' || !command) process.exit(0);

const segments = splitCommands(command);
const GIT_WORD = /(^|[\s;&|(`"'/])git(\s|$)/;

// 1. Changes to the gate's own configuration are the user's call.
const READ_ONLY = /(^|\s)(--get(-all|-regexp|-urlmatch|-color(bool)?)?|--list|-l|get|list)(\s|$)/;
for (const seg of segments) {
  if (
    GIT_WORD.test(seg) &&
    /(^|\s)config(\s|$)/.test(seg) &&
    /hook\.ai-review|core\.hookspath/i.test(seg) &&
    !READ_ONLY.test(seg)
  ) {
    block(
      'it changes the review gate configuration (hook.ai-review.* or core.hooksPath).\n' +
        'Do not change it. Ask the user to make that change themselves.',
    );
  }
}

// From here on only pushes matter.
const targets = findPushTargets(command, baseCwd);
if (!targets.length) process.exit(0);

// 2. Bypass attempts.
const BYPASS_NOTE = 'The review gate cannot be skipped from here. Ask the user if a change is needed.';
for (const seg of segments) {
  if (GIT_WORD.test(seg) && /(^|\s)push(\s|$)/.test(seg) && /(^|\s)--no-v[a-z]*/.test(seg)) {
    block(`\`--no-verify\` on a push skips the review hook. ${BYPASS_NOTE}`);
  }
  if (GIT_WORD.test(seg) && /(^|\s)-c\s*['"]?(core\.hookspath|hook\.)/i.test(seg)) {
    block(`\`-c core.hooksPath=...\` or \`-c hook....\` would replace the review hook. ${BYPASS_NOTE}`);
  }
  if (GIT_WORD.test(seg) && /(^|\s)--config-env/.test(seg)) {
    block(`\`--config-env\` can replace the review hook configuration. ${BYPASS_NOTE}`);
  }
}
const ENV_BYPASS = /(^|[\s;&|(`'"])(GIT_CONFIG[A-Z0-9_]*|PREPUSH_REVIEW_SKIP|AI_REVIEW_SKIP|AI_REVIEW_REQUIRED)\s*=/;
if (ENV_BYPASS.test(command)) {
  block(`the command sets an environment variable that can change or skip the review hook (GIT_CONFIG_*, PREPUSH_REVIEW_SKIP, AI_REVIEW_SKIP, AI_REVIEW_REQUIRED). ${BYPASS_NOTE}`);
}
const badEnv = Object.keys(process.env).filter((n) =>
  /^(GIT_CONFIG[A-Z0-9_]*|PREPUSH_REVIEW_SKIP|AI_REVIEW_SKIP|AI_REVIEW_REQUIRED)$/.test(n),
);
if (badEnv.length) {
  block(`the environment of this session exports ${badEnv.join(', ')}, which can change or skip the review hook. Unset it and restart the session. ${BYPASS_NOTE}`);
}

// 3. The repository must be known.
if (targets.some((t) => !t.known)) {
  block(
    'it cannot tell which repository the push leaves from, because the directory depends on\n' +
      'something only the shell knows (a variable, a command substitution, --git-dir, xargs).\n' +
      'Push with a literal path instead: `git -C <dir> push ...` or `cd <dir> && git push ...`.',
  );
}

const git = (dir, args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
const NOT_INSTALLED = `Ask the user to run: node ${installer}`;

for (const dir of [...new Set(targets.map((t) => t.dir))]) {
  const top = git(dir, ['rev-parse', '--show-toplevel']);
  if (top.status !== 0) {
    block(`${dir} is not a git repository (or does not exist), so the gate cannot be checked for this push.`);
  }
  const root = top.stdout.trim();

  // 4. The global gate must be active for this repository.
  const listed = git(root, ['hook', 'list', 'pre-push']);
  if (listed.status !== 0 || !listed.stdout.split('\n').some((l) => l.trim() === 'ai-review')) {
    block(`the global review gate (git hook "ai-review" on pre-push) is not active in ${root}. ${NOT_INSTALLED}`);
  }
  const enabled = git(root, ['config', '--bool', '--get', 'hook.ai-review.enabled']);
  if (enabled.status === 0 && enabled.stdout.trim() === 'false') {
    block(`the review gate is disabled (hook.ai-review.enabled=false) in ${root}. ${NOT_INSTALLED}`);
  }
  const cmds = git(root, ['config', '--show-scope', '--get-all', 'hook.ai-review.command'])
    .stdout.split('\n')
    .filter(Boolean);
  const [scope, value] = (cmds[0] || '').split('\t');
  if (cmds.length !== 1 || scope !== 'global') {
    block(`hook.ai-review.command in ${root} must be defined exactly once, in the global git config (found: ${cmds.join(' | ') || 'none'}). ${NOT_INSTALLED}`);
  }
  const m = /^node\s+(?:'([^']+)'|"([^"]+)"|(\S+))$/.exec(value || '');
  const script = m && (m[1] || m[2] || m[3]);
  if (!script || basename(script) !== 'git-pre-push.mjs' || !existsSync(script)) {
    block(`hook.ai-review.command ("${value}") does not point at an existing git-pre-push.mjs. ${NOT_INSTALLED}`);
  }
}

// 5. The review takes minutes; the call must survive it.
if (!(input.run_in_background === true || Number(input.timeout) >= MIN_TIMEOUT_MS)) {
  block(
    'the review runs inside `git push` and can take several minutes, but this Bash call would be killed first.\n' +
      'Retry the same command with timeout 600000 (or run_in_background: true).',
  );
}

process.exit(0);
