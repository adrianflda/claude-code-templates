/**
 * A small shell reader for the guard: splits a Bash command into simple commands, each with its
 * words, its output redirections and the heredoc body fed to it. It knows quoting well enough to
 * tell what a command writes from text that only mentions a path; it is not a full shell parser.
 * It throws ShellParseError on input it cannot read (unbalanced quotes), so callers can fall back
 * to a broader check; any other error is a bug in this reader.
 */

export class ShellParseError extends Error {}

const OPS = ['&&', '||', '|&', ';;', '>>', '>|', '&>>', '&>', '<<<', '<<-', '<<', '>&', '<&', ';', '|', '&', '>', '<', '(', ')'];
const SEPARATORS = new Set([';', '&&', '||', '|', '&', '|&', ';;', '(', ')']);
const OUTPUT = new Set(['>', '>>', '>|', '&>', '&>>']);
const FD = /\d+(?=[<>])/y; // an fd number before a redirection (the 2 in 2>file): skipped, not a word

/** Words and operators of one line. A word is { text, dynamic }: dynamic when it holds an
 * expansion ($, backtick) or an unquoted glob, so its final value is unknown before it runs. */
function lex(line) {
  const out = [];
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    if (c === '#' ) break;
    FD.lastIndex = i;
    const fd = FD.exec(line);
    if (fd) i += fd[0].length;
    const op = OPS.find((o) => line.startsWith(o, i));
    if (op) { out.push({ op }); i += op.length; continue; }
    let text = '';
    let dynamic = false;
    while (i < line.length && !' \t'.includes(line[i]) && !OPS.some((o) => line.startsWith(o, i))) {
      const ch = line[i];
      if (ch === "'") {
        const end = line.indexOf("'", i + 1);
        if (end < 0) throw new ShellParseError('unbalanced quote');
        text += line.slice(i + 1, end);
        i = end + 1;
      } else if (ch === '"') {
        // Inside double quotes bash removes the backslash only before $ ` " \ and newline.
        let j = i + 1;
        while (j < line.length && line[j] !== '"') {
          if (line[j] === '\\' && '$`"\\'.includes(line[j + 1] ?? '')) {
            text += line[j + 1];
            j += 2;
            continue;
          }
          if (line[j] === '$' || line[j] === '`') dynamic = true;
          text += line[j];
          j++;
        }
        if (j >= line.length) throw new ShellParseError('unbalanced quote');
        i = j + 1;
      } else if (ch === '\\') {
        text += line[i + 1] ?? '';
        i += 2;
      } else if (ch === '$' && line[i + 1] === '(') {
        // $( ... ): keep it whole, it is an expansion
        let depth = 0;
        let j = i + 1;
        for (; j < line.length; j++) {
          if (line[j] === '(') depth++;
          else if (line[j] === ')' && --depth === 0) break;
        }
        text += line.slice(i, j + 1);
        dynamic = true;
        i = j + 1;
      } else {
        if ('$`*?['.includes(ch)) dynamic = true;
        text += ch;
        i++;
      }
    }
    out.push({ text, dynamic });
  }
  return out;
}

/** Simple commands: [{ words: [{text, dynamic}], outputs: [{text, dynamic}], heredoc: string|null }]. */
export function simpleCommands(command) {
  const lines = command.split('\n');
  const cmds = [];
  for (let n = 0; n < lines.length; n++) {
    let cur = { words: [], outputs: [], heredoc: null };
    let pendingOut = false;
    let pendingDup = false;
    let heredocTag = null;
    let skipNext = false;
    for (const t of lex(lines[n])) {
      if (skipNext) {
        skipNext = false;
        if (heredocTag === '') heredocTag = t.text ?? '';
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
    }
    if (cur.words.length || cur.outputs.length) cmds.push(cur);
  }
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

/** The words of the program that actually runs (drops sudo/env/xargs/VAR=value prefixes and their options). */
export function unwrap(words) {
  let i = 0;
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
  return words.slice(i);
}

export const basename = (p) => p.split('/').pop();
