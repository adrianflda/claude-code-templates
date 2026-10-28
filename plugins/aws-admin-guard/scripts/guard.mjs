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
import { basename, simpleCommands, unwrap } from './shell-words.mjs';

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

function selectsProfile(command, profiles) {
  return profiles.some((p) =>
    new RegExp(`(--[\\w-]*profile(?:=|\\s+)|\\b[A-Za-z_]*profile\\s*=\\s*)\\\\?["']?${esc(p)}(?![\\w-])`, 'i').test(command));
}

// The broad check, kept for commands the shell reader cannot read (unbalanced quotes): any write
// intent anywhere in a command that mentions a transcript blocks it.
const WRITE_INTENT = /(^|[^0-9])&?>>?\s*(?!\/dev\/null|&)|\btee\b|\bsed\s+-[a-z]*i|\bperl\s+-[a-z]*i|open\([^)]*['"][wa+x]|write(File|Sync)?\b|append|truncate|\b(mv|cp|rm|dd|ln)\b/;
// Code an interpreter runs (python -c, node -e, a heredoc fed to python) that writes, moves or deletes files.
const WRITE_CODE = new RegExp([
  /open\(.*?,\s*(mode\s*=\s*)?f?['"][^'"]*[wax+]/, // python open(p, 'a'), even when p holds a $(...)
  /open\([^)]*['"]\s*\+?[>|]/, // perl open(F, ">>", p) / open(F, ">p")
  /\.write_(text|bytes)\(|(write|append)File(Sync)?\(|createWriteStream/, // pathlib, node fs
  /\b(File|IO|FileUtils)\.(write|open|delete|unlink|rename|mv|cp|rm|touch)/, // ruby
  /truncate|unlink|\brename|os\.replace|shutil\.|\.remove\(|rmSync|rmdir/,
].map((r) => r.source).join('|'));
// awk writes from inside its program: print > "f", print >> "f", printf ... | "cmd"
const AWK_WRITE = /(print|printf)[^;}]*(>|\|)/;
// Interpreter code that starts other programs: what they write cannot be read from the code, so the
// broad WRITE_INTENT check applies to it.
const SPAWNS = /os\.system|subprocess|popen|child_process|exec(Sync|File)?\(|spawn|`|\bsystem\(/;
const INTERPRETERS = /^(python[\d.]*|node|perl|ruby|deno|bun)$/;
const SHELLS = new Set(['bash', 'sh', 'zsh']);
const ANY_OPERAND = new Set(['tee', 'mv', 'rm', 'truncate', 'shred', 'unlink']);
const LAST_OPERAND = new Set(['cp', 'ln', 'rsync', 'install']);
// Programs that only read the files they are given. Any other program handed a transcript-like
// argument is treated as writing it (fail-closed): editors, archivers, `sort -o`, unknown tools.
const READERS = new Set(['cat', 'head', 'tail', 'less', 'more', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'jq', 'yq',
  'wc', 'cut', 'tr', 'nl', 'column', 'diff', 'cmp', 'comm', 'join', 'paste', 'fold', 'tac', 'rev', 'zcat', 'base64',
  'strings', 'xxd', 'od', 'hexdump', 'md5', 'md5sum', 'shasum', 'sha256sum', 'cksum', 'stat', 'file', 'du', 'ls',
  'cd', 'pushd', 'test', '[', 'echo', 'printf', 'realpath', 'readlink', 'dirname', 'basename', 'tree']);

/**
 * True when the command would write, replace or delete a session transcript. Since 2026-10-28 it
 * looks at what each command WRITES -- output redirections, the operands of tee/cp/mv/rm/ln/
 * truncate/dd/sed -i/perl -i, find -delete, and interpreter code -- instead of any ">" anywhere:
 * all 12 blocks of the previous 30 days were read-only commands (">=" in jq, "(?<c>" in rg,
 * "> scratch/out" next to a transcript read). A write target counts as a transcript when it names
 * one, is under .claude/projects, is a relative *.jsonl, or cannot be known before it runs (a
 * variable, $(...), a glob). Reading transcripts stays allowed.
 */
function writesTranscript(command, transcriptPath) {
  const mentions = (transcriptPath && command.includes(transcriptPath)) || /\.claude\/projects/.test(command);
  if (!mentions) return false;
  try {
    return writesIn(command, transcriptPath, 0);
  } catch {
    return WRITE_INTENT.test(command);
  }
}

function transcriptLike(word, transcriptPath) {
  const t = word.text;
  return word.dynamic || t.includes('.claude/projects') || Boolean(transcriptPath && t.includes(transcriptPath)) ||
    (/\.jsonl$/.test(t) && !/^[/~]/.test(t));
}

function writesIn(command, transcriptPath, depth) {
  const hit = (w) => transcriptLike(w, transcriptPath);
  for (const cmd of simpleCommands(command)) {
    if (cmd.outputs.some(hit)) return true;
    const words = unwrap(cmd.words);
    if (!words.length) continue;
    const name = basename(words[0].text);
    const args = words.slice(1);
    const operands = args.filter((w) => !w.text.startsWith('-'));
    if (name === 'eval' && depth < 3 && writesIn(args.map((w) => w.text).join(' '), transcriptPath, depth + 1)) {
      return true;
    }
    if (SHELLS.has(name)) {
      const c = args.findIndex((w) => w.text === '-c');
      if (c >= 0 && args[c + 1] && depth < 3 && writesIn(args[c + 1].text, transcriptPath, depth + 1)) return true;
      if (cmd.heredoc && depth < 3 && writesIn(cmd.heredoc, transcriptPath, depth + 1)) return true;
    }
    if (ANY_OPERAND.has(name) && operands.some(hit)) return true;
    const targetDir = args.some((w) => /^(-t|--target-directory)/.test(w.text));
    if (LAST_OPERAND.has(name) && operands.length &&
        (hit(operands[operands.length - 1]) || (targetDir && operands.some(hit)))) return true;
    if (name === 'dd' && args.some((w) => w.text.startsWith('of=') && hit({ ...w, text: w.text.slice(3) }))) return true;
    if ((name === 'sed' || name === 'perl') && args.some((w) => /^-[a-zA-Z]*i|^--in-place/.test(w.text)) &&
        operands.some(hit)) return true;
    if (name === 'find' && args.some((w) => ['-delete', '-exec', '-execdir', '-ok'].includes(w.text)) &&
        args.some(hit)) return true;
    if (/^[gnm]?awk$/.test(name) && args.some((w) => AWK_WRITE.test(w.text))) return true;
    if (INTERPRETERS.test(name)) {
      const code = [];
      args.forEach((w, i) => { if (/^-[a-z]*[cep]$|^--eval$/.test(w.text) && args[i + 1]) code.push(args[i + 1].text); });
      if (cmd.heredoc) code.push(cmd.heredoc);
      if (code.some((c) => WRITE_CODE.test(c) || (SPAWNS.test(c) && WRITE_INTENT.test(c)))) return true;
      continue; // a script file or read-only code: what it reads is its business
    }
    if (name === 'sort') {
      if (args.some((w) => /^(-o|--output)/.test(w.text)) && args.some(hit)) return true;
      continue;
    }
    if (name === 'uniq') {
      if (operands.length > 1 && hit(operands[1])) return true;
      continue;
    }
    const handled = SHELLS.has(name) || ANY_OPERAND.has(name) || LAST_OPERAND.has(name) || READERS.has(name) ||
      ['eval', 'dd', 'sed', 'perl', 'find', 'awk', 'gawk', 'nawk', 'mawk'].includes(name);
    if (!handled && args.some(hit)) return true;
  }
  return false;
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

// This file is only ever run as the hook (never imported), so it always runs main().
// Any crash must still block: Claude Code treats exit codes other than 2 as "allow".
const failClosed = (e) => {
  process.stderr.write(`[aws-admin-guard] BLOCKED. The hook failed (${e?.message || e}); retry the command.\n`);
  process.exit(2);
};
process.on('uncaughtException', failClosed);
process.on('unhandledRejection', failClosed);
main();
