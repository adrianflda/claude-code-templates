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

/**
 * The script path of a stored `node <path>` command, undoing the installer's shell quoting
 * ('...' groups, \' for an apostrophe). Null when the value is anything else.
 */
function storedScript(value) {
  const m = /^node\s+(\S.*)$/.exec(value);
  if (!m) return null;
  let rest = m[1];
  let out = '';
  while (rest) {
    const part = /^(?:'([^']*)'|\\(.)|"([^"]*)"|([^'"\\\s]+))/.exec(rest);
    if (!part) return null;
    out += part[1] ?? part[2] ?? part[3] ?? part[4];
    rest = rest.slice(part[0].length);
  }
  return out;
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
  payload = null;
}
if (payload === null || typeof payload !== 'object') {
  // Unreadable payload: stay out of the way, unless the raw text looks like a push.
  if (/git/.test(raw) && /push/.test(raw)) {
    block('the hook payload could not be parsed and it mentions `git` and `push`, so the push cannot be checked.');
  }
  process.exit(0);
}

const toolName = payload.tool_name || payload.toolName || '';
const input = payload.tool_input || payload.toolInput || {};
const command = input.command || '';
const baseCwd = payload.cwd || process.cwd();
if (toolName !== 'Bash' || !command) process.exit(0);

const segments = splitCommands(command);
const GIT_WORD = /(^|[\s;&|(`"'/])git(\s|$)/;

// 1. Changes to the gate's own configuration are the user's call.
const GATE_KEY = /hook\.ai-review|core\.hookspath/i;
const WRITE_FLAGS = /^(--unset(-all)?|--replace-all|--add|--remove-section|--rename-section|--edit|-e|--set|set|unset|edit|--fixed-value)$/;
const READ_FLAGS = /^(--get(-all|-regexp|-urlmatch)?|--list|-l|get|list)$/;
const OPTION_WITH_VALUE = /^(--file|-f|--blob|--type|-t|--default|--comment)$/;

/** Words of a command up to an unquoted `#` comment; nothing is expanded. */
function words(seg) {
  const out = [];
  for (const raw of seg.match(/"(?:\\.|[^"\\])*"|'[^']*'|\S+/g) ?? []) {
    if (raw.startsWith('#')) break;
    out.push(/^(".*"|'.*')$/s.test(raw) ? raw.slice(1, -1) : raw);
  }
  return out;
}

/**
 * Does this `git config` command touch the gate's keys, or might it? Mentions anywhere in the
 * segment count (a comment cannot hide them). Reading is allowed only when it is plainly a
 * read: a read action, no write action, and no value after the key. Anything else is treated
 * as a write (when in doubt, block).
 */
function changesGateConfig(seg) {
  if (!GIT_WORD.test(seg) || !GATE_KEY.test(seg)) return false;
  const w = words(seg);
  const at = w.indexOf('config');
  if (at === -1) return /(^|\s)config(\s|$)/.test(seg);
  const args = w.slice(at + 1);
  if (args.some((a) => WRITE_FLAGS.test(a))) return true;
  // `get` and `list` are actions only as the first word; later they are a value.
  const verb = /^(get|list)$/.test(args[0] ?? '') ? 1 : 0;
  if (!verb && !args.some((a) => a.startsWith('-') && READ_FLAGS.test(a))) return true;
  const positional = [];
  for (let i = verb; i < args.length; i += 1) {
    if (OPTION_WITH_VALUE.test(args[i])) i += 1;
    else if (!args[i].startsWith('-')) positional.push(args[i]);
  }
  const listing = args.some((a) => a === '--list' || a === '-l') || args[0] === 'list';
  return positional.length > (listing ? 0 : 1); // a value (or value pattern) after the key
}

for (const seg of segments) {
  if (changesGateConfig(seg)) {
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
  // Only options after the `push` word belong to the push (not `git commit --no-verify`).
  const w = words(seg);
  const pushAt = w.indexOf('push');
  const direct = pushAt !== -1 && w.slice(pushAt + 1).some((a) => /^--no-v/.test(a));
  // `bash -c 'git push --no-verify'`: the whole script is one quoted word.
  const nested = w.some((a) => /\bgit\b.*\bpush\b.*\s--no-v/.test(a));
  if (GIT_WORD.test(seg) && (direct || nested)) {
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
  const script = storedScript(value || '');
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
