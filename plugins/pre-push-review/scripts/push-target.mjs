/**
 * pre-push-review — find where each `git push` in a shell command line will run.
 *
 * The PreToolUse payload carries the session's working directory, but the command itself can
 * move before it pushes: `cd ../other-worktree && git push`, or `git -C ../other push`. The
 * gate must review the repository the push leaves from, so this follows `cd` and `-C` through
 * the command and returns one directory per push.
 *
 * Nothing is expanded or executed. When the directory cannot be known statically (a variable,
 * a command substitution, `cd -`, `--git-dir`, `GIT_DIR=`, `xargs git push`), the push is
 * reported with `known: false` and the gate refuses to guess.
 *
 * A push with an environment prefix (`GIT_SSH_COMMAND=... git push`) or behind a wrapper
 * (`env`, `command`, `sudo`, `bash -c '...'`) is still a push. The only prefix that turns the
 * review off is the documented skip switch, reported as `skip: true`.
 *
 * This is a reading of the command, not a shell, so it errs toward reporting a push. Any
 * command whose words contain `git ... push` outside quotes and that the rules above cannot
 * place is reported with `known: false`: a blocked push can be rewritten, a missed one is
 * not reviewed. Aliases, functions and scripts that push are outside what a command line
 * can show.
 *
 * Each push also says whether a git command that creates commits (`commit`, `merge`,
 * `cherry-pick`, `revert`, `rebase`, `am`, `pull`) comes before it in the same command line
 * (`afterCommit: true`). The gate runs before the command does, so that commit does not exist
 * yet when the review runs: the push would leave unreviewed.
 */
import { homedir } from 'os';
import { basename, isAbsolute, resolve } from 'path';

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|`[^`]*`|\$\((?:[^()]|\([^()]*\))*\)|\S*)\s+/;
const SKIP_VARS = ['PREPUSH_REVIEW_SKIP', 'AI_REVIEW_SKIP'];
// Environment that points git at another repository.
const REPO_VARS = ['GIT_DIR', 'GIT_WORK_TREE'];

// Global git options that take a separate value, so the value is not mistaken for the verb.
const VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);
const REPO_OPTION = /^--(git-dir|work-tree)(=|$)/;

// Words that run the command that follows them, when they take no arguments of their own.
const WRAPPERS = new Set(['env', 'command', 'builtin', 'exec', 'sudo', 'nohup', 'time', 'nice']);
// Shell keywords that can stand in front of a command.
const KEYWORDS = new Set(['then', 'do', 'else', 'elif', 'if', 'while', 'until', '!', '{']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash']);
// git verbs that create (or rewrite) the commits a later push would send. `pull` can make a
// merge commit or rebase local commits.
const COMMIT_VERBS = new Set(['commit', 'merge', 'cherry-pick', 'revert', 'rebase', 'am', 'pull']);
// Commands that only print or search their arguments: `echo git push` pushes nothing.
const INERT = new Set(['echo', 'printf', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'man', 'which', 'type', 'alias']);

function unquote(value) {
  return /^(".*"|'.*')$/s.test(value) ? value.slice(1, -1) : value;
}

/** Tokens of a simple command; quotes group, nothing is expanded. */
function tokenize(text) {
  return (text.match(/"(?:\\.|[^"\\])*"|'[^']*'|\S+/g) ?? []).map((raw) => ({ raw, value: unquote(raw) }));
}

/** A path the shell would expand or compute: not knowable without running it. */
function isDynamic(token) {
  if (token.raw.startsWith("'")) return false; // single quotes: literal
  return /[$`*?]/.test(token.value) || token.value === '-';
}

/** `git`, `/usr/bin/git`, `\git`: the git program, however it is spelled. */
function isGit(token) {
  return basename(token.value.replace(/^\\/, '')) === 'git';
}

function resolveDir(from, target) {
  if (target === '~') return homedir();
  if (target.startsWith('~/')) return resolve(homedir(), target.slice(2));
  return isAbsolute(target) ? target : resolve(from, target);
}

/**
 * Split a command line into simple commands. Separators and here-document markers count only
 * outside quotes. Here-document bodies are kept apart from the command text: they are data
 * (a commit message, a file being written), so "git push" inside one is not a command,
 * unless the command that receives the body is a shell.
 *
 * @returns {{text: string, heredocs: string[]}[]}
 */
function splitWithHeredocs(command) {
  const segments = [];
  const pending = []; // here-documents opened on the current line
  let current = { text: '', heredocs: [] };
  let quote = null;
  let nested = 0; // depth of `$( ... )`: its separators belong to the substitution
  let backtick = false;
  let i = 0;

  const close = () => {
    segments.push(current);
    current = { text: '', heredocs: [] };
  };
  const readHeredocBodies = () => {
    for (const { terminator, stripTabs, owner } of pending.splice(0)) {
      const body = [];
      while (i < command.length) {
        const end = command.indexOf('\n', i);
        const line = command.slice(i, end === -1 ? command.length : end);
        i = end === -1 ? command.length : end + 1;
        if ((stripTabs ? line.replace(/^\t+/, '') : line) === terminator) break;
        body.push(line);
      }
      owner.heredocs.push(body.join('\n'));
    }
  };

  while (i < command.length) {
    const ch = command[i];

    if (quote) {
      current.text += ch;
      if (ch === '\\' && quote === '"' && i + 1 < command.length) current.text += command[++i];
      else if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current.text += ch;
      i += 1;
      continue;
    }
    if (ch === '\\' && i + 1 < command.length) {
      // An escaped newline joins two lines; any other escaped character is literal.
      if (command[i + 1] !== '\n') current.text += ch + command[i + 1];
      i += 2;
      continue;
    }

    const rest = command.slice(i);
    if (rest.startsWith('$(')) {
      nested += 1;
      current.text += '$(';
      i += 2;
      continue;
    }
    if (ch === '`') backtick = !backtick;
    else if (ch === '(' && nested) nested += 1;
    else if (ch === ')' && nested) nested -= 1;
    if ((nested || backtick) && ch !== '\n') {
      current.text += ch;
      i += 1;
      continue;
    }
    if (rest.startsWith('<<<')) {
      // A here-string: take the operator whole, so its tail is not read as `<<`.
      current.text += '<<<';
      i += 3;
      continue;
    }
    const heredoc = rest.match(/^<<(-?)\s*(?:'([^']+)'|"([^"]+)"|\\?([A-Za-z_][A-Za-z0-9_]*))/);
    if (heredoc) {
      pending.push({
        terminator: heredoc[2] ?? heredoc[3] ?? heredoc[4],
        stripTabs: heredoc[1] === '-',
        owner: current,
      });
      i += heredoc[0].length;
      continue;
    }
    if (ch === '\n') {
      close();
      i += 1;
      readHeredocBodies();
      continue;
    }
    const separator = rest.match(/^(&&|\|\||;|\||&)/);
    if (separator && !/^&>|^&\d/.test(rest) && !/[<>]$/.test(current.text)) {
      close();
      i += separator[0].length;
      continue;
    }
    current.text += ch;
    i += 1;
  }
  close();
  return segments.map((s) => ({ ...s, text: s.text.trim() })).filter((s) => s.text);
}

/** The simple commands of a command line, as text. */
export function splitCommands(command) {
  return splitWithHeredocs(String(command ?? '')).map((s) => s.text);
}

/** Text of `$( ... )` and backtick substitutions that sit outside single quotes. */
function substitutions(text) {
  const bare = text.replace(/'[^']*'/g, "''");
  const found = [...bare.matchAll(/`([^`]*)`/g)].map((m) => m[1]);
  for (let start = bare.indexOf('$('); start !== -1; ) {
    let depth = 1;
    let end = start + 2;
    while (end < bare.length && depth) {
      if (bare[end] === '(') depth += 1;
      else if (bare[end] === ')') depth -= 1;
      end += 1;
    }
    found.push(bare.slice(start + 2, depth ? end : end - 1));
    start = bare.indexOf('$(', end);
  }
  return found;
}

/** Index of `push` when tokens[at] is git and its verb is push; otherwise -1. */
function pushVerb(tokens, at) {
  let i = at + 1;
  while (i < tokens.length && tokens[i].value.startsWith('-')) {
    i += VALUE_OPTIONS.has(tokens[i].value) ? 2 : 1;
  }
  return tokens[i]?.value === 'push' ? i : -1;
}

/**
 * @param {string} command  the Bash command line
 * @param {string} baseCwd  the working directory the command starts in
 * @returns {{dir: string, known: boolean, skip: boolean, afterCommit: boolean}[]} one entry per
 *   `git push`, in order
 */
export function findPushTargets(command, baseCwd) {
  return scan(command, baseCwd, 0, false).targets;
}

/**
 * @param {boolean} committed  a commit-creating git command ran earlier in the enclosing line
 * @returns {{targets: object[], committed: boolean}} the pushes, and whether a commit-creating
 *   git command appears anywhere in this command (so a push after it in the caller is flagged)
 */
function scan(command, baseCwd, depth, committed) {
  const targets = [];
  if (depth > 3) return { targets, committed };
  let cwd = baseCwd;
  let known = true;
  let exported = false; // GIT_DIR or GIT_WORK_TREE set for the rest of the command
  const saved = []; // directory to return to when a `( ... )` subshell closes

  for (const segment of splitWithHeredocs(String(command ?? ''))) {
    let text = segment.text;
    // A subshell keeps its `cd` to itself: remember where to come back to.
    while (text.startsWith('(')) {
      saved.push({ cwd, known });
      text = text.slice(1).trimStart();
    }
    let closing = 0;
    while (/\)\s*$/.test(text) && !/\$\([^)]*\)\s*$/.test(text)) {
      closing += 1;
      text = text.replace(/\)\s*$/, '');
    }

    // Leading keywords, `NAME=value` assignments and bare wrappers belong to the command
    // that follows them.
    const env = {};
    let tokens = [];
    for (;;) {
      for (let m = `${text} `.match(ASSIGNMENT); m; m = `${text} `.match(ASSIGNMENT)) {
        env[m[1]] = unquote(m[2]);
        text = text.slice(m[0].length).trimStart();
      }
      tokens = tokenize(text);
      const head = tokens[0]?.value;
      const bareWrapper = WRAPPERS.has(head) && tokens[1] && !tokens[1].value.startsWith('-');
      if (!KEYWORDS.has(head) && !bareWrapper) break;
      text = tokens.slice(1).map((t) => t.raw).join(' ');
    }

    const head = tokens[0]?.value;
    // `GIT_DIR=x` on its own, `export GIT_DIR=x`, `declare -x GIT_DIR=x`: it stays set.
    const names = tokens.map((t) => t.value.split('=')[0]);
    if (
      (!tokens.length && REPO_VARS.some((name) => name in env)) ||
      (['export', 'declare', 'typeset'].includes(head) && REPO_VARS.some((name) => names.includes(name)))
    ) {
      exported = true;
    }
    const skip = SKIP_VARS.some((name) => env[name] === '1');
    const redirected = exported || REPO_VARS.some((name) => name in env);
    const found = targets.length;

    // A substitution runs its own command, wherever it sits in the line.
    for (const inner of substitutions(segment.text)) {
      const nested = scan(inner, cwd, depth + 1, committed);
      for (const t of nested.targets) {
        targets.push({ ...t, known: t.known && known && !redirected, skip: t.skip || skip });
      }
      committed = nested.committed;
    }

    if (head === 'cd' || head === 'pushd') {
      const target = tokens.slice(1).find((t) => !t.value.startsWith('-') || t.value === '-');
      if (!target) cwd = head === 'cd' ? homedir() : cwd;
      else if (isDynamic(target)) known = false;
      else cwd = resolveDir(cwd, target.value);
    } else if (head === 'popd') {
      known = false;
    } else if (SHELLS.has(head) || head === 'eval') {
      // `bash -c '<script>'`, `eval '<script>'`, `bash <<EOF`, `bash <<< '<script>'`: read the
      // script the same way.
      const flag = tokens.findIndex((t) => /^-[a-z]*c$/.test(t.value));
      const hereString = tokens.findIndex((t) => t.value === '<<<');
      const scripts = [
        head === 'eval' ? tokens[1] : flag > 0 ? tokens[flag + 1] : null,
        hereString > 0 ? tokens[hereString + 1] : null,
        ...segment.heredocs.map((body) => ({ raw: `'${body}'`, value: body })),
      ].filter(Boolean);
      for (const script of scripts) {
        const dynamic = !script.raw.startsWith("'") && /[$`]/.test(script.value);
        const nested = scan(script.value, cwd, depth + 1, committed);
        for (const t of nested.targets) {
          targets.push({ ...t, known: t.known && known && !dynamic && !redirected, skip: t.skip || skip });
        }
        committed = nested.committed;
        if (head === 'eval' && /(^|[;&|\s])(cd|pushd|popd)\s/.test(script.value)) known = false;
      }
    } else if (tokens[0] && isGit(tokens[0]) && !tokens[0].raw.startsWith('$')) {
      let dir = cwd;
      let dirKnown = known && !redirected;
      let i = 1;
      while (i < tokens.length && tokens[i].value.startsWith('-')) {
        const option = tokens[i].value;
        if (REPO_OPTION.test(option)) dirKnown = false;
        if (option === '-C' && tokens[i + 1]) {
          if (isDynamic(tokens[i + 1])) dirKnown = false;
          else dir = resolveDir(dir, tokens[i + 1].value);
        }
        i += VALUE_OPTIONS.has(option) ? 2 : 1;
      }
      if (tokens[i]?.value === 'push') targets.push({ dir, known: dirKnown, skip, afterCommit: committed });
      else if (COMMIT_VERBS.has(tokens[i]?.value)) committed = true;
    }

    // Safety net: the words say `git ... push`, and nothing above placed it. It may run
    // through a wrapper with its own arguments (`sudo -u x`, `xargs`, `find -exec`), so the
    // directory is not known. Blocked rather than missed.
    if (targets.length === found && !INERT.has(head)) {
      const unplaced = tokens.some(
        (t, at) => at > 0 && !/^["']/.test(t.raw) && isGit(t) && pushVerb(tokens, at) !== -1,
      );
      if (unplaced) targets.push({ dir: cwd, known: false, skip, afterCommit: committed });
    }

    while (closing-- > 0 && saved.length) ({ cwd, known } = saved.pop());
  }
  return { targets, committed };
}
