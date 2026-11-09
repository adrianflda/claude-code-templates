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
 * a variable expanded at run time) is not seen. A script file handed a transcript is judged by its
 * own text, so code it imports from elsewhere, or a change to the file after the check, is not seen. This guard stops accidents and shortcuts,
 * not a determined adversary.
 */
import { config, esc, grantState, humanPrompts } from './consent-core.mjs';
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix, resolve as resolvePath } from 'node:path';
import { basename, loopVariable, onlyReserved, runsUnwrapped, ShellParseError, simpleCommands, unwrap } from './shell-words.mjs';

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

// The broad check, for what cannot be read word by word (unbalanced quotes, a script fed on stdin):
// any write intent anywhere in a command that mentions a transcript blocks it. It scans shell text;
// WRITE_CODE below scans program code. They overlap on purpose and are kept separate because the
// same word means different things in each (">" is a redirect in one and a comparison in the other).
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
// Any operand of these can be the file overwritten, moved or removed. ln is here because linking a
// transcript (its source operand) makes an alias that a later command writes without naming it.
const ANY_OPERAND = new Set(['tee', 'mv', 'rm', 'truncate', 'shred', 'unlink', 'ln']);
// Only the last operand of these is written (the others are read), unless -t names the target or
// cp makes links (-l / -s), which are aliases of every source.
const LAST_OPERAND = new Set(['cp', 'rsync', 'install']);
const CP_LINKS = /^-[a-zA-Z]*[ls]|^--(link|symbolic-link)$/;
const JUDGED_ABOVE = new Set(['dd', 'sed', 'perl', 'find', 'awk', 'gawk', 'nawk', 'mawk']);
const MAX_DEPTH = 3; // nested bash -c / eval / heredoc levels read; deeper is treated as a write
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
// Claude Code's memory folder sits next to the transcripts and is meant to be written. A path inside
// it (no "..", not a *.jsonl) is not a transcript.
const MEMORY_PATH = /[^\s'"]*\.claude\/projects\/[^/\s'"]+\/memory(\/[^\s'"]*)?/g;
const inMemory = (t) => !t.includes('..') && !/\.jsonl$/.test(t) &&
  /\.claude\/projects\/[^/]+\/memory(\/|$)/.test(t);

// Where Claude Code keeps transcripts, symlinks resolved and lowercased (APFS ignores case).
const PROJECTS_DIR = (() => {
  const dir = resolvePath(process.env.CLAUDE_CONFIG_DIR || resolvePath(homedir(), '.claude'), 'projects');
  try { return realpathSync.native(dir).toLowerCase(); } catch { return dir.toLowerCase(); }
})();
/** The spelling the text checks compare: lowercase, `//` and `/./` collapsed. `..` is kept, because the
 * memory carve-out treats any `..` as leaving memory/. */
const spelling = (t) => t.toLowerCase().replace(/\/{2,}/g, '/').replace(/\/\.(?=\/|$)/g, '');
/** `~`, `$HOME`, `$PWD` (and their `${}` forms) expanded from the hook's own environment: the values the
 * command starts with. A word that still holds `$`, a backtick or a glob after this is not resolved. */
function expandKnown(t, cwd) {
  return t.replace(/^~(?=\/|$)/, homedir())
    .replace(/\$(\{HOME\}|HOME\b)/g, homedir())
    .replace(/\$(\{PWD\}|PWD\b)/g, cwd);
}
const UNRESOLVED = /[$`*?[\]{}]/;

/** Where a real (symlink-resolved, lowercased) path sits: 'transcripts' anywhere in the projects folder
 * but a project's memory/ (where *.jsonl still counts), else null. */
function projectsArea(real) {
  if (real !== PROJECTS_DIR && !real.startsWith(PROJECTS_DIR + '/')) return null;
  const rest = real.slice(PROJECTS_DIR.length + 1);
  return /^[^/]+\/memory(\/|$)/.test(rest) && !rest.endsWith('.jsonl') ? 'memory' : 'transcripts';
}

/** One disk view per hook run: the transcript's identity is read once, each path at most once. */
function diskView(transcriptPath) {
  let id = null;
  try { const st = statSync(transcriptPath); id = `${st.dev}:${st.ino}`; } catch { /* none */ }
  const memo = new Map();
  /** { alias, area } for an absolute path: alias = the same file as the transcript (through a symlink
   * or a hard link, wherever it sits); area = projectsArea of where it really is. A file that does not
   * exist yet is judged by its real parent folder. */
  return (abs) => {
    if (memo.has(abs)) return memo.get(abs);
    let alias = false;
    try { const st = statSync(abs); alias = id !== null && `${st.dev}:${st.ino}` === id; } catch { /* missing */ }
    let real = null;
    try { real = realpathSync.native(abs); } catch {
      try { real = resolvePath(realpathSync.native(posix.dirname(abs)), posix.basename(abs)); } catch { /* no parent */ }
    }
    const r = { alias, area: projectsArea((real ?? abs).toLowerCase()) };
    memo.set(abs, r);
    return r;
  };
}

/** Every absolute path a word may name: absolute as written, else against each of `dirs`. */
const candidates = (text, dirs) => (text.startsWith('/') ? [resolvePath(text)] : dirs.map((d) => resolvePath(d, text)));

/** True when a literal word is, on disk, a session transcript: an alias of the hook's own transcript,
 * or a *.jsonl in the projects folder outside memory/. */
function transcriptOnDisk(text, ctx) {
  const t = expandKnown(text, ctx.cwd);
  if (UNRESOLVED.test(t)) return false;
  return candidates(t, ctx.dirs).some((abs) => {
    const d = ctx.disk(abs);
    return d.alias || (d.area === 'transcripts' && abs.toLowerCase().endsWith('.jsonl'));
  });
}

/** The folders a relative path may resolve against: the hook's cwd and every literal cd / pushd target
 * of the top-level commands (a cd inside bash -c is not followed). */
function workDirs(cmds, cwd) {
  const dirs = [cwd];
  for (const c of cmds) {
    const w = unwrap(c.words);
    if (w.length > 1 && (w[0].text === 'cd' || w[0].text === 'pushd')) {
      const t = expandKnown(w[1].text, cwd);
      if (!w[1].dynamic || !UNRESOLVED.test(t)) dirs.push(resolvePath(cwd, t));
    }
  }
  return dirs;
}

// Path-like tokens of the raw text, including those inside quoted code (`open('link','a')`).
const PATH_TOKEN = /[^\s'"`;&|<>(),=]+/g;
const MAX_TOKENS = 256;
/** True when some literal token of the raw text reaches the transcripts on disk: an alias of the
 * transcript, or a path into the projects folder (a folder too: `cd` into it, a glob under it). Past
 * MAX_TOKENS distinct tokens the answer is yes (only the text heuristics are armed, nothing blocks). */
function diskMention(command, ctx) {
  // Read twice: split at quotes (code such as open('link','a')) and with quotes dropped ("$PWD"/link).
  const tokens = new Set([...(command.match(PATH_TOKEN) || []), ...(command.replace(/['"]/g, '').match(PATH_TOKEN) || [])]);
  if (tokens.size > MAX_TOKENS) return true;
  for (const tok of tokens) {
    const t = expandKnown(tok, ctx.cwd);
    if (UNRESOLVED.test(t) || t === '-' || /^-/.test(t)) continue;
    if (candidates(t, ctx.dirs).some((abs) => { const d = ctx.disk(abs); return d.alias || d.area === 'transcripts'; })) {
      return true;
    }
  }
  return false;
}

/** A link made from a word the hook cannot resolve may become an alias the disk check never sees. */
const linksUnknown = (cmds) => cmds.some((c) => {
  const [p, ...args] = unwrap(c.words);
  const links = p && (basename(p.text) === 'ln' || (basename(p.text) === 'cp' && args.some((w) => CP_LINKS.test(w.text))));
  return links && args.some((w) => w.dynamic);
});

function writesTranscript(command, transcriptPath, cwd) {
  const base = cwd || process.cwd();
  // The memory carve-out holds only while the command cannot leave memory/: no "..", at most one cd.
  const staysInMemory = !command.includes('..') && (command.match(/\b(cd|pushd|popd)\b/g) || []).length <= 1;
  const outsideMemory = staysInMemory ? command.replace(MEMORY_PATH, (m) => (inMemory(spelling(m)) ? '' : m)) : command;
  let cmds = null;
  let parseError = null;
  try { cmds = simpleCommands(command); } catch (e) { parseError = e; }
  const ctx = { transcriptPath, cwd: base, dirs: cmds ? workDirs(cmds, base) : [base], disk: diskView(transcriptPath) };
  // Text that may name a transcript. Only then do unknowable write targets (a variable, a glob, $(...)),
  // relative *.jsonl and the code heuristics count. It is armed by: the transcript path; text reaching
  // the projects folder in any spelling (`.Claude//projects`, a glob such as `.claude/proj*` or
  // `.claude/*`, a cd into `.claude`); CLAUDE_CONFIG_DIR; a literal token that is the transcript or
  // sits in the projects folder on disk (a symlink, a hard link, a relative path); or a link made from
  // a word that cannot be resolved now.
  const s = spelling(command);
  const mentions = Boolean(transcriptPath && command.includes(transcriptPath)) ||
    /\.claude\/projects\b[\s\S]*\.jsonl/.test(s) || /\.claude\/projects/.test(spelling(outsideMemory)) ||
    /\.claude\/[*?[]|\.claude\/proj[^/\s'"]*[*?[]/.test(s) ||
    /\b(cd|pushd)\s+[^\s;&|]*\.claude\/?(?=$|[\s;&|)])/.test(s) ||
    /CLAUDE_CONFIG_DIR/.test(command) || diskMention(command, ctx) || (cmds !== null && linksUnknown(cmds));
  if (!mentions) return false;
  if (parseError) {
    if (parseError instanceof ShellParseError) return WRITE_INTENT.test(command);
    process.stderr.write(`[aws-admin-guard] shell reader error (${parseError?.message || parseError}); treating the command as a write.\n`);
    return true;
  }
  try {
    return writesIn(command, ctx, 0, cmds);
  } catch (e) {
    if (e instanceof ShellParseError) return WRITE_INTENT.test(command);
    process.stderr.write(`[aws-admin-guard] shell reader error (${e?.message || e}); treating the command as a write.\n`);
    return true;
  }
}

function transcriptLike(word, ctx) {
  const t = spelling(word.text);
  return word.dynamic || (t.includes('.claude/projects') && !inMemory(t)) ||
    Boolean(ctx.transcriptPath && word.text.includes(ctx.transcriptPath)) ||
    (/\.jsonl$/.test(t) && !/^[/~]/.test(t)) || transcriptOnDisk(word.text, ctx);
}

const writingCode = (c) => WRITE_CODE.test(c) || (SPAWNS.test(c) && WRITE_INTENT.test(c));
// Value-less python flags that may precede the script path (python3 -I -u -B ...). Anything else
// before the script (-m mod, -W/-X with a value) leaves the code unknown.
const PRE_SCRIPT_FLAGS = /^-[IuBEsSOqbdvP]+$/;
const MAX_SCRIPT_BYTES = 1_000_000;
// The only programs that may share a command line with a script judged by its source. They read and
// print: none changes the shell (an assignment, PATH, an alias, a function, hash, a sourced file or a
// loader variable could change which python runs or inject code into it) or writes a file (it could
// rewrite the script after this check). An allowlist: whatever is not here leaves the script unjudged.
// Left out on purpose: printf (-v assigns), rg (--pre runs a program), xxd/tree/file (write with an
// option or a second operand), sort (-o), less/more (run commands), yq (-i).
const QUIET_NEIGHBORS = new Set(['cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'jq', 'wc', 'cut', 'tr', 'nl',
  'column', 'diff', 'cmp', 'comm', 'paste', 'fold', 'tac', 'rev', 'zcat', 'strings', 'od', 'hexdump', 'md5',
  'md5sum', 'shasum', 'sha256sum', 'cksum', 'stat', 'du', 'ls', 'echo', ':', 'true', 'false', 'test', '[',
  'realpath', 'readlink', 'dirname', 'basename']);

// Expansions that can assign a variable anywhere in the line, a heredoc or a redirection target included:
// arithmetic ($((PATH=0)), $[PATH=0]) and parameter defaults (${PATH:=0}, ${PATH=0}).
const ASSIGNING_EXPANSION = /\$\(\(|\$\[|\$\{[^}]*=/;

/** True when every simple command of the line other than `self` is quiet: a known reader, cd (only
 * while PATH has no relative entry a new cwd could resolve python from), a loop over a one-letter
 * lowercase variable, or a reserved word -- with no output other than /dev/null. A longer loop name
 * may be special: zsh ties `path` to PATH and keeps `functions`, `aliases`, `commands` (what a name
 * runs) and `fpath`/`module_path` (what it loads); no shell has a one-letter lowercase special. A
 * test/[ with a subscript (X[PATH=0]) or any expansion (a glob or $f may expand to one) is not
 * quiet: bash's test -v evaluates a subscript as arithmetic, which assigns. */
function quietNeighbors(cmds, self) {
  const absolutePath = (process.env.PATH ?? '').split(':').every((d) => d.startsWith('/'));
  return cmds.every((c) => {
    if (c === self) return true;
    if (c.outputs.some((o) => o.dynamic || o.text !== '/dev/null')) return false;
    const loopVar = loopVariable(c.words);
    if (loopVar) return !loopVar.dynamic && !loopVar.quoted && /^[a-z]$/.test(loopVar.text);
    const words = unwrap(c.words);
    if (!words.length) return onlyReserved(c.words); // not a bare assignment (PATH=...) or wrapper
    const p = words[0];
    if (p.dynamic && p.text !== '[') return false; // a lone [ is no glob: bash keeps it literal
    if ((p.text === 'test' || p.text === '[') &&
        words.slice(1).some((w) => w.dynamic || (w.text !== ']' && w.text.includes('[')))) {
      return false;
    }
    return p.text === 'cd' ? absolutePath : QUIET_NEIGHBORS.has(p.text);
  });
}
/** The source of the script python runs, when it can be known before it runs. Every condition
 * below exists because without it the file read here may not be the code that runs:
 * - a bare literal `python`, `python3` or `python3.N`: a path (./python3, /tmp/x/python3) may be any
 *   program, and nothing in the command may change what the bare name resolves to;
 * - python only: other interpreters' flags differ (perl/ruby -I takes a value) and their code can be
 *   injected through the environment (NODE_OPTIONS, PERL5OPT, RUBYOPT);
 * - isolated mode (-I): no PYTHON* variables, no user site, no script directory on sys.path;
 * - no assignment or wrapper on the command, no arithmetic or ${x:=} expansion anywhere in the line
 *   (either may assign PATH), every other command of the line quiet (quietNeighbors),
 *   and not inside a nested shell (bash -c, eval), whose environment the outer line may change;
 * - a literal absolute path (not ~/: the shell expands it from a $HOME the command may reassign),
 *   not dynamic and not transcript-like, to a regular file (not a symlink) of at most 1 MB.
 * null = unknown (the caller treats it as a write). Imported modules, and changes to the file after
 * this check, are not seen. */
function scriptSource(command, cmd, cmds, depth, hit) {
  const [program, ...args] = unwrap(cmd.words);
  if (depth > 0 || !/^python(3(\.\d+)?)?$/.test(program.text) || program.dynamic ||
      !runsUnwrapped(cmd.words) || ASSIGNING_EXPANSION.test(command) || !quietNeighbors(cmds, cmd)) return null;
  const at = args.findIndex((w) => !PRE_SCRIPT_FLAGS.test(w.text));
  if (!args.slice(0, at).some((w) => w.text.includes('I'))) return null;
  const w = args[at];
  // hit() is true for every dynamic word (a glob or expansion may name another file than the text says)
  if (!w || !w.text.startsWith('/') || hit(w)) return null;
  let fd;
  try {
    // One open, judged by its descriptor: no swap between the check and the read, and a FIFO
    // cannot hang the hook.
    fd = openSync(w.text, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_SCRIPT_BYTES) return null;
    const buf = Buffer.alloc(st.size + 1);
    let n = 0;
    for (let r; n < buf.length && (r = readSync(fd, buf, n, buf.length - n, n)) > 0;) n += r;
    if (n > st.size) return null; // grew after the fstat
    // Python also runs a zip archive (its __main__.py) or bytecode handed as the script; neither is
    // readable text and both hold NUL bytes. Only valid UTF-8 without NUL is judged as source.
    const source = new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, n));
    return source.includes('\0') ? null : source;
  } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
}

function writesIn(command, ctx, depth, parsed = null) {
  const hit = (w) => transcriptLike(w, ctx);
  const cmds = parsed ?? simpleCommands(command);
  for (const cmd of cmds) {
    if (cmd.outputs.some(hit)) return true;
    const words = unwrap(cmd.words);
    if (!words.length) continue;
    const name = basename(words[0].text);
    const args = words.slice(1);
    const operands = args.filter((w) => !w.text.startsWith('-'));
    // Code run by a nested shell: read it too, up to MAX_DEPTH; deeper than that counts as a write.
    const nested = (script) => depth + 1 >= MAX_DEPTH || writesIn(script, ctx, depth + 1);
    if (name === 'eval') {
      if (nested(args.map((w) => w.text).join(' '))) return true;
      continue;
    }
    if (SHELLS.has(name)) {
      const c = args.findIndex((w) => /^-[a-zA-Z]*c$/.test(w.text)); // -c, -xc, -ec ...
      if (c >= 0) {
        if (nested(args[c + 1]?.text ?? '')) return true;
      } else if (cmd.heredoc !== null) {
        if (nested(cmd.heredoc)) return true;
      } else if (operands.length) {
        if (args.some(hit)) return true; // a script file handed a transcript: unknown, so a write
      } else if (WRITE_INTENT.test(command)) {
        return true; // the script arrives on stdin (`... | bash`): judge the whole command broadly
      }
      continue;
    }
    if (ANY_OPERAND.has(name) && operands.some(hit)) return true;
    const targetDir = args.some((w) => /^(-t|--target-directory)/.test(w.text));
    const links = name === 'cp' && args.some((w) => CP_LINKS.test(w.text));
    if (LAST_OPERAND.has(name) && operands.length &&
        (hit(operands[operands.length - 1]) || ((targetDir || links) && operands.some(hit)))) return true;
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
      if (code.some(writingCode)) return true;
      if (!code.length && operands.length && args.some(hit)) {
        // A script file handed a transcript: judged by its code like inline code when that code can be
        // read now; otherwise unknown, so a write.
        const source = scriptSource(command, cmd, cmds, depth, hit);
        if (source === null || writingCode(source)) return true;
        continue;
      }
      if (!code.length && !operands.length && (WRITE_CODE.test(command) || WRITE_INTENT.test(command))) {
        return true; // code arrives on stdin (`echo ... | python3`): judge the whole command broadly
      }
      continue; // read-only inline code, or a script that is not handed a transcript
    }
    if (name === 'sort') {
      if (args.some((w) => /^(-o|--output)/.test(w.text)) && args.some(hit)) return true;
      continue;
    }
    if (name === 'uniq') {
      if (operands.length > 1 && hit(operands[1])) return true;
      continue;
    }
    // Shells, eval, interpreters, sort and uniq returned or continued above; these were judged above
    // without continuing. Anything else handed a transcript-like word is treated as writing it.
    const judged = READERS.has(name) || ANY_OPERAND.has(name) || LAST_OPERAND.has(name) || JUDGED_ABOVE.has(name);
    if (!judged && words.some(hit)) return true; // incl. a program name that is itself a variable
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
    // Compared as spelled (any case, `//`, `/./`, `..` collapsed) and as the file it is on disk.
    const base = input.cwd || process.cwd();
    const spelled = posix.normalize(f).toLowerCase();
    if ((transcript && f === transcript) || /\.claude\/projects\/.*\.jsonl$/.test(spelled) ||
        (f && transcriptOnDisk(f, { cwd: base, dirs: [base], disk: diskView(transcript) }))) {
      block('Session transcripts record what the human typed; they are the consent record and must not be edited.');
    }
    process.exit(0);
  }
  if (tool !== 'Bash') process.exit(0);
  const command = String(ti.command ?? '');
  if (writesTranscript(command, transcript, input.cwd)) {
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
