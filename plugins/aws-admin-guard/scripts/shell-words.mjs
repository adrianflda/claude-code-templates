/**
 * A small shell reader for the guard: splits a Bash command into simple commands, each with its
 * words, its output redirections and the heredoc body fed to it. It knows quoting well enough to
 * tell what a command writes from text that only mentions a path; it is not a full shell parser.
 * It throws ShellParseError on input it cannot read (unbalanced quotes), so callers can fall back
 * to a broader check; any other error is a bug in this reader.
 */

export class ShellParseError extends Error {}

const OPS = ['&&', '||', '|&', ';;', '>>', '>|', '&>>', '&>', '<<<', '<<-', '<<', '<>', '>&', '<&', ';', '|', '&', '>', '<', '(', ')'];
const SEPARATORS = new Set([';', '&&', '||', '|', '&', '|&', ';;', '(', ')']);
const OUTPUT = new Set(['>', '>>', '>|', '&>', '&>>', '<>']); // <> opens its target read-write
const FD = /\d+(?=[<>])/y; // an fd number before a redirection (the 2 in 2>file): skipped, not a word
const MAX_NESTING = 16; // command substitutions inside command substitutions; deeper is unreadable

/** Index just past the backtick that closes the one at text[i]. */
function endOfBacktick(text, i) {
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === '\\') j++;
    else if (text[j] === '`') return j + 1;
  }
  throw new ShellParseError('unbalanced backtick');
}

/** Index just past the double quote that closes the one at text[i]. */
function endOfDoubleQuote(text, i) {
  for (let j = i + 1; j < text.length;) {
    if (text[j] === '\\') j += 2;
    else if (text[j] === '"') return j + 1;
    else if (text[j] === '$' && text[j + 1] === '(') j = endOfParen(text, j);
    else if (text[j] === '`') j = endOfBacktick(text, j);
    else j++;
  }
  throw new ShellParseError('unbalanced quote');
}

/** Index just past the paren that closes the $( at text[i]. The code inside is a shell of its own:
 * quotes and nested substitutions there may hold parens that do not count. */
function endOfParen(text, i) {
  let depth = 0;
  for (let j = i + 1; j < text.length;) {
    const ch = text[j];
    if (ch === '\\') { j += 2; continue; }
    if (ch === "'") {
      const end = text.indexOf("'", j + 1);
      if (end < 0) throw new ShellParseError('unbalanced quote');
      j = end + 1;
      continue;
    }
    if (ch === '"') { j = endOfDoubleQuote(text, j); continue; }
    if (ch === '`') { j = endOfBacktick(text, j); continue; }
    if (ch === '$' && text[j + 1] === '(') { j = endOfParen(text, j); continue; }
    if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return j + 1;
    j++;
  }
  throw new ShellParseError('unbalanced parenthesis');
}

/** The code of a $(...), <(...) or >(...) that spans text[from, to). A case arm's `)` may close
 * the substitution early when counting parens, so code holding `case` is not read: the broad check. */
function pushReadableCode(text, from, to, subs) {
  const code = text.slice(from, to);
  if (/(^|[\s;&|(`])case(\s|$)/.test(code)) throw new ShellParseError('case inside a substitution');
  subs.push(code);
}

/** The substitution at text[i] ($(...), $((...)) or `...`): pushes the code it runs onto `subs` and
 * returns the index just past it. Arithmetic runs no code of its own, only the substitutions in it.
 * Bash reads $(( as arithmetic only when the paren after it closes right before the last one:
 * `$((rm f);(echo))` is a command substitution that runs rm. */
function substitution(text, i, subs) {
  if (text[i] === '`') {
    const end = endOfBacktick(text, i);
    subs.push(text.slice(i + 1, end - 1).replace(/\\([`$\\])/g, '$1'));
    return end;
  }
  const end = endOfParen(text, i);
  if (text.startsWith('$((', i) && endOfParen(text, i + 1) === end - 1) {
    substitutionsIn(text.slice(i + 3, end - 2), subs);
  } else {
    pushReadableCode(text, i + 2, end - 1, subs);
  }
  return end;
}

/** Every substitution in text where quotes are literal: a heredoc body, an arithmetic expression. */
function substitutionsIn(text, subs) {
  for (let i = 0; i < text.length;) {
    if (text[i] === '\\') i += 2;
    else if ((text[i] === '$' && text[i + 1] === '(') || text[i] === '`') i = substitution(text, i, subs);
    else i++;
  }
}

/** Words and operators of one line, and the code of each command substitution in it (`subs`). A word
 * is { text, dynamic, quoted }: dynamic when it holds an expansion ($, backtick) or an unquoted glob,
 * so its final value is unknown before it runs. */
function lex(line, subs) {
  const out = [];
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    if (c === '#' ) break;
    FD.lastIndex = i;
    const fd = FD.exec(line);
    if (fd) i += fd[0].length;
    if ((line[i] === '<' || line[i] === '>') && line[i + 1] === '(') {
      // process substitution: a word whose value is a path; its code runs alongside the command
      const end = endOfParen(line, i);
      pushReadableCode(line, i + 2, end - 1, subs);
      out.push({ text: line.slice(i, end), dynamic: true, quoted: false });
      i = end;
      continue;
    }
    const op = OPS.find((o) => line.startsWith(o, i));
    if (op) { out.push({ op }); i += op.length; continue; }
    let text = '';
    let dynamic = false;
    let quoted = false; // any quote or backslash: a quoted `do` is a program name, not a reserved word
    while (i < line.length && !' \t'.includes(line[i]) && !OPS.some((o) => line.startsWith(o, i))) {
      const ch = line[i];
      if (ch === "'") {
        quoted = true;
        const end = line.indexOf("'", i + 1);
        if (end < 0) throw new ShellParseError('unbalanced quote');
        text += line.slice(i + 1, end);
        i = end + 1;
      } else if (ch === '"') {
        quoted = true;
        // Inside double quotes bash removes the backslash only before $ ` " \ and newline.
        let j = i + 1;
        while (j < line.length && line[j] !== '"') {
          if (line[j] === '\\' && '$`"\\'.includes(line[j + 1] ?? '')) {
            text += line[j + 1];
            j += 2;
            continue;
          }
          if ((line[j] === '$' && line[j + 1] === '(') || line[j] === '`') {
            const end = substitution(line, j, subs);
            text += line.slice(j, end);
            dynamic = true;
            j = end;
            continue;
          }
          if (line[j] === '$') dynamic = true;
          text += line[j];
          j++;
        }
        if (j >= line.length) throw new ShellParseError('unbalanced quote');
        i = j + 1;
      } else if (ch === '\\') {
        quoted = true;
        text += line[i + 1] ?? '';
        i += 2;
      } else if ((ch === '$' && line[i + 1] === '(') || ch === '`') {
        // a substitution stays whole in the word (its value is unknown); its code is judged apart
        const end = substitution(line, i, subs);
        text += line.slice(i, end);
        dynamic = true;
        i = end;
      } else {
        if ('$`*?['.includes(ch)) dynamic = true;
        text += ch;
        i++;
      }
    }
    out.push({ text, dynamic, quoted });
  }
  return out;
}

/** Simple commands: [{ words, outputs, heredoc: string|null }], words and outputs as lex makes them
 * ({ text, dynamic, quoted }).
 * The code of every command substitution ($(...), `...`, also inside double quotes and unquoted
 * heredocs) follows as simple commands of its own: it runs too, wherever it sits (a for or case
 * header, an argument, a redirection target). */
export function simpleCommands(command, nesting = 0) {
  if (nesting > MAX_NESTING) throw new ShellParseError('substitutions nested too deep');
  const lines = command.split('\n');
  const cmds = [];
  const subs = [];
  for (let n = 0; n < lines.length; n++) {
    let cur = { words: [], outputs: [], heredoc: null };
    let pendingOut = false;
    let pendingDup = false;
    let heredocTag = null;
    let heredocQuoted = false;
    let skipNext = false;
    for (const t of lex(lines[n], subs)) {
      if (skipNext) {
        skipNext = false;
        if (heredocTag === '') {
          heredocTag = t.text ?? '';
          heredocQuoted = Boolean(t.quoted);
        }
        continue;
      }
      if (pendingOut) {
        pendingOut = false;
        if (t.text !== undefined) { cur.outputs.push(t); continue; }
      }
      if (pendingDup) {
        // `>& 2` duplicates an fd; `>& file` is bash's other spelling of `&> file`, a write
        pendingDup = false;
        if (t.text !== undefined) {
          if (!/^(\d+|-)$/.test(t.text)) cur.outputs.push(t);
          continue;
        }
      }
      if (t.op) {
        if (SEPARATORS.has(t.op)) {
          if (cur.words.length || cur.outputs.length) cmds.push(cur);
          cur = { words: [], outputs: [], heredoc: null };
        } else if (OUTPUT.has(t.op)) {
          pendingOut = true;
        } else if (t.op === '>&') {
          pendingDup = true;
        } else if (t.op === '<<' || t.op === '<<-') {
          heredocTag = '';
          skipNext = true;
        } else {
          skipNext = true; // input redirection or fd duplication: its target is not written
        }
        continue;
      }
      cur.words.push(t);
    }
    if (heredocTag) {
      const body = [];
      while (++n < lines.length && lines[n].trim() !== heredocTag) body.push(lines[n]);
      cur.heredoc = body.join('\n');
      // an unquoted tag (<<EOF, not <<'EOF') expands the body: its substitutions run
      if (!heredocQuoted) substitutionsIn(cur.heredoc, subs);
    }
    if (cur.words.length || cur.outputs.length) cmds.push(cur);
  }
  for (const code of subs) cmds.push(...simpleCommands(code, nesting + 1));
  return cmds;
}

// Each wrapper's options that take a separate value (`sudo -u root tee`, `xargs -I {} cp`). Per wrapper,
// because the same letter differs: sudo -n / -s take none, xargs -n / -s take one.
const WRAPPER_VALUE_OPTS = {
  sudo: new Set(['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U', '-T']),
  env: new Set(['-u', '-C', '-S', '-P']),
  nice: new Set(['-n']),
  xargs: new Set(['-I', '-n', '-L', '-P', '-d', '-E', '-s', '-a']),
  exec: new Set(['-a']),
  command: new Set(),
  nohup: new Set(),
  time: new Set(),
};

// Reserved words that only introduce the command after them (`do rm x`, `if grep ...`, `! test`).
const PREFIX_WORDS = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', '{']);
// Reserved words whose simple command runs no program: loop and case headers (their words are only
// expanded, never executed) and closers. Redirections on them are still read by the caller.
const NO_PROGRAM = new Set(['for', 'select', 'case', 'done', 'fi', 'esac', '}']);

/** The words of the program that actually runs (drops sudo/env/xargs/VAR=value prefixes and their
 * options, and shell reserved words); [] when the simple command runs no program. */
export function unwrap(words) {
  const i = programIndex(words);
  return i < 0 ? [] : words.slice(i);
}

/** Index of the program's word in `words` (words.length when none follows); -1 when the simple
 * command runs no program. */
function programIndex(words) {
  let i = skipReserved(words);
  if (i < 0) return -1;
  while (i < words.length) {
    const t = words[i].text;
    if (/^\w+=/.test(t)) { i++; continue; }
    const valueOpts = WRAPPER_VALUE_OPTS[t];
    if (!valueOpts) break;
    i++;
    while (i < words.length && words[i].text.startsWith('-')) {
      i += valueOpts.has(words[i].text) ? 2 : 1;
    }
  }
  return i;
}

/** Index of the first word after the leading reserved words; -1 when the simple command runs no
 * program. Reserved words count only in command position: before any assignment or wrapper
 * (`env do` runs a program named do) and unquoted. */
function skipReserved(words) {
  let i = 0;
  while (i < words.length && !words[i].quoted) {
    if (NO_PROGRAM.has(words[i].text)) return -1;
    if (!PREFIX_WORDS.has(words[i].text)) break;
    i++;
  }
  return i;
}

/** True when the program runs with nothing but reserved words before it: no VAR=value and no
 * wrapper (env, sudo, xargs ...) that could change the environment it runs with. */
export function runsUnwrapped(words) {
  const i = skipReserved(words);
  return i >= 0 && i < words.length && programIndex(words) === i;
}

/** True when the simple command is nothing but reserved words, or a header or closer that runs no
 * program (`done`, `case x in a`): no assignment, no wrapper, no program. */
export function onlyReserved(words) {
  const i = skipReserved(words);
  return i < 0 || i === words.length;
}

/** For a loop header (`for v in ...`, `select v in ...`), the loop variable's word; null otherwise. */
export function loopVariable(words) {
  let i = 0;
  while (i < words.length && !words[i].quoted && PREFIX_WORDS.has(words[i].text)) i++;
  const head = words[i];
  return head && !head.quoted && (head.text === 'for' || head.text === 'select') ? (words[i + 1] ?? null) : null;
}

export const basename = (p) => p.split('/').pop();
