/**
 * A small, dependency-free shell reader: turns a Bash command line into the list of
 * simple commands it runs, each as an argv array. It is not a full shell parser; it
 * knows what a guard needs to tell "a command" from "text that mentions a command":
 * quotes, escapes, separators (; & | && || newlines, ( ) { } $( ` ), comments and
 * heredoc bodies (skipped, they are data).
 */

const SEPARATORS = new Set([';', '&', '|', '(', ')', '`']);
const WRAPPERS = new Set(['command', 'builtin', 'exec', 'nohup', 'time', 'nice', 'caffeinate']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);

/** Split raw text into simple commands (argv arrays), skipping heredoc bodies. */
export function readCommands(src) {
  const cmds = [];
  let words = [];
  let cur = null;
  let heredocs = [];
  let i = 0;
  const endWord = () => {
    if (cur !== null) words.push(cur);
    cur = null;
  };
  const endCmd = () => {
    endWord();
    if (words.length) cmds.push(words);
    words = [];
  };
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') {
      endCmd();
      i++;
      for (const { delim, strip } of heredocs) {
        while (i < src.length) {
          const nl = src.indexOf('\n', i);
          const line = src.slice(i, nl === -1 ? src.length : nl);
          i = nl === -1 ? src.length : nl + 1;
          if ((strip ? line.replace(/^\t+/, '') : line) === delim) break;
        }
      }
      heredocs = [];
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') { endWord(); i++; continue; }
    if (c === '#' && cur === null) {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '\\') {
      if (src[i + 1] === '\n') { i += 2; continue; }
      cur = (cur ?? '') + (src[i + 1] ?? '');
      i += 2;
      continue;
    }
    if (c === "'" || (c === '$' && src[i + 1] === "'")) {
      if (c === '$') i++;
      const end = src.indexOf("'", i + 1);
      cur = (cur ?? '') + src.slice(i + 1, end === -1 ? src.length : end);
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) { s += src[j + 1]; j += 2; } else { s += src[j]; j++; }
      }
      cur = (cur ?? '') + s;
      i = j + 1;
      continue;
    }
    if (c === '$' && src[i + 1] === '{') {
      const end = src.indexOf('}', i);
      cur = (cur ?? '') + src.slice(i, end === -1 ? src.length : end + 1);
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    if (c === '$' && src[i + 1] === '(') { endCmd(); i += 2; continue; }
    if ((c === '{' || c === '}') && cur === null && /[\s;]|$/.test(src[i + 1] ?? '')) { endCmd(); i++; continue; }
    if (SEPARATORS.has(c)) {
      if (c === '&' && (src[i - 1] === '>' || src[i + 1] === '>')) { cur = (cur ?? '') + c; i++; continue; }
      endCmd();
      i++;
      continue;
    }
    if (c === '<' && src[i + 1] === '<' && src[i + 2] !== '<') {
      endWord();
      i += 2;
      const strip = src[i] === '-';
      if (strip) i++;
      while (src[i] === ' ' || src[i] === '\t') i++;
      let delim = '';
      while (i < src.length && !/[\s;&|<>()]/.test(src[i])) {
        if (src[i] !== "'" && src[i] !== '"' && src[i] !== '\\') delim += src[i];
        i++;
      }
      if (delim) heredocs.push({ delim, strip });
      continue;
    }
    cur = (cur ?? '') + c;
    i++;
  }
  endCmd();
  return cmds;
}

/**
 * Normalise one argv: peel off leading VAR=value assignments and wrapper programs
 * (env, command, sudo, timeout, ...). Returns { assigns, argv } where argv[0] is the
 * real program (basename), or expands `bash -c "<script>"` / `eval` into the commands
 * they run (returned as { nested }).
 */
export function normalise(argv) {
  const assigns = {};
  let a = [...argv];
  for (;;) {
    while (a.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(a[0])) {
      const k = a[0].slice(0, a[0].indexOf('='));
      assigns[k] = a[0].slice(k.length + 1);
      a.shift();
    }
    if (!a.length) return { assigns, argv: a };
    const prog = a[0].split('/').pop();
    if (prog === 'env') {
      a.shift();
      while (a.length && a[0].startsWith('-')) {
        const opt = a.shift();
        if (opt === '-u' || opt === '-C' || opt === '-S') a.shift();
      }
      continue;
    }
    if (prog === 'sudo' || prog === 'xargs') {
      a.shift();
      while (a.length && a[0].startsWith('-')) {
        const opt = a.shift();
        if (/^-[ugCDhnIL]$/.test(opt)) a.shift();
      }
      continue;
    }
    if (prog === 'timeout' || prog === 'gtimeout') {
      a.shift();
      while (a.length && a[0].startsWith('-')) {
        const opt = a.shift();
        if (opt === '-s' || opt === '-k' || opt === '--signal' || opt === '--kill-after') a.shift();
      }
      a.shift();
      continue;
    }
    if (WRAPPERS.has(prog)) {
      a.shift();
      while (a.length && a[0].startsWith('-')) a.shift();
      continue;
    }
    if (SHELLS.has(prog)) {
      const ci = a.findIndex((w, k) => k > 0 && /^-[a-z]*c[a-z]*$/.test(w));
      if (ci !== -1 && a[ci + 1] !== undefined) return { assigns, nested: a[ci + 1] };
    }
    if (prog === 'eval') return { assigns, nested: a.slice(1).join(' ') };
    a[0] = prog;
    return { assigns, argv: a };
  }
}

/** Every simple command the line runs, nested shells expanded, depth-limited. */
export function simpleCommands(src, depth = 0) {
  const out = [];
  for (const argv of readCommands(src)) {
    const n = normalise(argv);
    if (n.nested !== undefined) {
      if (depth < 4) out.push(...simpleCommands(n.nested, depth + 1));
      continue;
    }
    if (n.argv.length) out.push({ assigns: n.assigns, argv: n.argv });
  }
  return out;
}
