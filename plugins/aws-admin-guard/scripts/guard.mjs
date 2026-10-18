#!/usr/bin/env node
/**
 * aws-admin-guard — Claude Code PreToolUse hook (Bash, Write, Edit, MultiEdit, NotebookEdit).
 *
 * Rule (see ../RULE.md): the AWS admin profile is used only after the human authorized it
 * and confirmed a second time, in two separate typed messages (see consent-core.mjs).
 *
 * Blocks (exit 2, reason on stderr):
 *   - any Bash command that selects a guarded profile (--profile admin, --profile=admin,
 *     AWS_PROFILE=admin, AWS_DEFAULT_PROFILE=admin, -e AWS_PROFILE=admin, -var profile=admin,
 *     profile = "admin") while there is no live grant in this session;
 *   - any attempt to write a session transcript (the consent oracle), from Bash or from the
 *     file tools. Reading transcripts is allowed.
 *
 * Limits: a command that reaches the profile indirectly (a script that sets it internally,
 * a variable expanded at run time) is not seen. This guard stops accidents and shortcuts,
 * not a determined adversary.
 */
import { config, esc, grantState, humanPrompts } from './consent-core.mjs';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function readStdin() {
  // Read until EOF, bounded three ways: size (8 MB), idle time (5 s) and total time (15 s).
  // Anything abnormal resolves to '' so the caller's JSON.parse fails and its fallback runs.
  return new Promise((res) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(idle);
      clearTimeout(hard);
      res(ok ? chunks.join('') : '');
    };
    let idle = setTimeout(() => finish(false), 5_000);
    const hard = setTimeout(() => finish(false), 15_000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      size += c.length;
      if (size > 8_000_000) return finish(false);
      chunks.push(c);
      clearTimeout(idle);
      idle = setTimeout(() => finish(false), 5_000);
    });
    process.stdin.on('end', () => finish(true));
    process.stdin.on('error', () => finish(false));
  });
}

export function selectsProfile(command, profiles) {
  return profiles.some((p) =>
    new RegExp(`(--profile(?:=|\\s+)|\\b[A-Za-z_]*profile\\s*=\\s*)\\\\?["']?${esc(p)}(?![\\w-])`, 'i').test(command));
}

const WRITE_INTENT = /(^|[^0-9&])>>?\s*(?!\/dev\/null|&)|\btee\b|\bsed\s+-[a-z]*i|\bperl\s+-[a-z]*i|open\([^)]*['"][wa+x]|write(File|Sync)?\b|append|truncate|\b(mv|cp|rm|dd|ln)\b/;

export function writesTranscript(command, transcriptPath) {
  const touches = (transcriptPath && command.includes(transcriptPath)) ||
    /\.claude\/projects\b[\s\S]*\.jsonl/.test(command);
  return Boolean(touches) && WRITE_INTENT.test(command);
}

function block(reason) {
  process.stderr.write(`[aws-admin-guard] BLOCKED. ${reason}\n`);
  process.exit(2);
}

async function main() {
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch (e) {
    // A guard that cannot read what it is guarding must not say yes.
    process.stderr.write(`[aws-admin-guard] BLOCKED. The hook could not read the tool call (${e.message}); retry the command.\n`);
    process.exit(2);
  }
  const tool = input?.tool_name;
  const transcript = input?.transcript_path;
  const ti = input?.tool_input || {};
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
    const f = String(ti.file_path || ti.notebook_path || '');
    if ((transcript && f === transcript) || /\.claude\/projects\/.*\.jsonl$/.test(f)) {
      block('Session transcripts record what the human typed; they are the consent record and must not be edited.');
    }
    process.exit(0);
  }
  if (tool !== 'Bash') process.exit(0);
  const command = String(ti.command ?? '');
  if (writesTranscript(command, transcript)) {
    block('This command would write a session transcript. Transcripts are the consent record and must not be edited.');
  }
  const cfg = config();
  if (!selectsProfile(command, cfg.profiles)) process.exit(0);
  const s = grantState(humanPrompts(transcript), Date.now(), cfg);
  if (s.stage === 'granted') process.exit(0);
  const why = s.stage === 'pending'
    ? 'The user authorized it once; the second confirmation is still missing.'
    : s.expired ? 'The previous authorization expired.' : 'There is no authorization in this session.';
  block(`This command uses the AWS profile "${cfg.profiles.join('" / "')}". ${why} ` +
    'Stop, explain in the user\'s language what you need it for and the exact commands, and ask for ' +
    'authorization and a second confirmation in two separate messages. Then run the command again ' +
    `(the grant lasts ${cfg.ttlMs / 60000} min after the confirmation). Do not switch to another way of getting admin.`);
}

// Run as a hook, not when imported. Compare real paths: Claude Code may launch the script
// through a symlinked plugin directory, and a mismatch here would silently skip the guard.
const isEntry = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isEntry) {
  // Any crash must still block: Claude Code treats exit codes other than 2 as "allow".
  const failClosed = (e) => {
    process.stderr.write(`[aws-admin-guard] BLOCKED. The hook failed (${e?.message || e}); retry the command.\n`);
    process.exit(2);
  };
  process.on('uncaughtException', failClosed);
  process.on('unhandledRejection', failClosed);
  main();
}
