/**
 * A small shell reader for the guard: splits a Bash command into simple commands, each with its
 * words, its output redirections and the heredoc body fed to it. It knows quoting well enough to
 * tell what a command writes from text that only mentions a path; it is not a full shell parser.
 * It throws on input it cannot read (unbalanced quotes), so callers can fall back to a broader check.
 */

const OPS = ['&&', '||', '|&', ';;', '>>', '>|', '&>>', '&>', '<<<', '<<-', '<<', '>&', '<&', ';', '|', '&', '>', '<', '(', ')'];
const SEPARATORS = new Set([';', '&&', '||', '|', '&', '|&', ';;', '(', ')']);
const OUTPUT = new Set(['>', '>>', '>|', '&>', '&>>']);

/** Words and operators of one line. A word is { text, dynamic }: dynamic when it holds an
 * expansion ($, backtick) or an unquoted glob, so its final value is unknown before it runs. */
function lex(line) {
  const out = [];
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    if (c === '#' ) break;
    const fd = /^\d+(?=[<>])/.exec(line.slice(i));
    if (fd) i += fd[0].length;
    const op = OPS.find((o) => line.startsWith(o, i));
    if (op) { out.push({ op }); i += op.length; continue; }
    let text = '';
    let dynamic = false;
    while (i < line.length && !' \t'.includes(line[i]) && !OPS.some((o) => line.startsWith(o, i))) {
      const ch = line[i];
      if (ch === "'") {
        const end = line.indexOf("'", i + 1);
        if (end < 0) throw new Error('unbalanced quote');
        text += line.slice(i + 1, end);
        i = end + 1;
      } else if (ch === '"') {
        let j = i + 1;
        while (j < line.length && line[j] !== '"') {
          if (line[j] === '\\') j++;
          else if (line[j] === '$' || line[j] === '`') dynamic = true;
          j++;
        }
        if (j >= line.length) throw new Error('unbalanced quote');
        text += line.slice(i + 1, j);
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
      if (t.op) {
        if (SEPARATORS.has(t.op)) {
          if (cur.words.length || cur.outputs.length) cmds.push(cur);
          cur = { words: [], outputs: [], heredoc: null };
        } else if (OUTPUT.has(t.op)) {
          pendingOut = true;
        } else if (t.op === '<<' || t.op === '<<-') {
          heredocTag = '';
          skipNext = true;
          cur.heredocOwner = true;
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

const WRAPPERS = new Set(['sudo', 'command', 'nohup', 'time', 'nice', 'env', 'xargs', 'exec']);
// Wrapper options that take a value: `xargs -I {} cp`, `sudo -u root tee`, `nice -n 5 cp`.
const WRAPPER_VALUE_OPTS = new Set(['-I', '-n', '-L', '-P', '-d', '-E', '-s', '-u', '-g', '-C', '-D', '-a']);

/** The words of the program that actually runs (drops sudo/env/xargs/VAR=value prefixes and their options). */
export function unwrap(words) {
  let i = 0;
  while (i < words.length) {
    const t = words[i].text;
    if (/^\w+=/.test(t)) { i++; continue; }
    if (!WRAPPERS.has(t)) break;
    i++;
    while (i < words.length && words[i].text.startsWith('-')) {
      i += WRAPPER_VALUE_OPTS.has(words[i].text) ? 2 : 1;
    }
  }
  return words.slice(i);
}

export const basename = (p) => p.split('/').pop();
