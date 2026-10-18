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

function readStdin() {
  // Resolve on 'end'. The timer only guards against a caller that never closes stdin, and it
  // is reset by every chunk, so a slow but live payload is never cut short.
  return new Promise((res) => {
    let d = '';
    let timer = setTimeout(() => res(d), 10_000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      if (d.length < 16_000_000) d += c;
      clearTimeout(timer);
      timer = setTimeout(() => res(d), 10_000);
    });
    process.stdin.on('end', () => { clearTimeout(timer); res(d); });
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

if (import.meta.url === `file://${process.argv[1]}`) main();
