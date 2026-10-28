// Detecting `git push` in a shell command line, for the PreToolUse gate.
//
// The gate must not be fooled in either direction: the word "push" inside a commit message is
// not a push, and a push with an environment prefix (`GIT_SSH_COMMAND=... git push`) still is
// one. The only prefix that turns the gate off is the documented skip switch, written out.

const SEPARATORS = /&&|\|\||;|\||\n/;
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S*)\s+/;
const SKIP_VARS = new Set(['PREPUSH_REVIEW_SKIP', 'AI_REVIEW_SKIP']);

function unquote(value) {
  return /^(".*"|'.*')$/.test(value) ? value.slice(1, -1) : value;
}

/** Split leading `NAME=value` assignments off a command segment. */
function stripAssignments(segment) {
  const env = {};
  let rest = segment.trimStart();
  for (let m = rest.match(ASSIGNMENT); m; m = rest.match(ASSIGNMENT)) {
    env[m[1]] = unquote(m[2]);
    rest = rest.slice(m[0].length);
  }
  return { env, rest };
}

/** Tokens of a simple command; quotes group, nothing is expanded. */
function tokenize(text) {
  return (text.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(unquote);
}

// Global git options that take a separate value, so the value is not mistaken for the verb.
const VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);

/**
 * Find the pushes in a command line.
 * Returns [{ dir, skip }] — one entry per `git push`, with the `-C` directory (or null) and
 * whether that push carries the skip switch.
 */
export function findPushes(command) {
  const pushes = [];
  for (const segment of String(command ?? '').split(SEPARATORS)) {
    const { env, rest } = stripAssignments(segment);
    const tokens = tokenize(rest);
    if (tokens[0] !== 'git') continue;

    let dir = null;
    let i = 1;
    while (i < tokens.length && tokens[i].startsWith('-')) {
      if (tokens[i] === '-C') dir = tokens[i + 1] ?? null;
      i += VALUE_OPTIONS.has(tokens[i]) ? 2 : 1;
    }
    if (tokens[i] !== 'push') continue;

    const args = tokens.slice(i + 1);
    // `--dry-run` sends nothing; `--help` prints usage.
    if (args.some((a) => a === '--dry-run' || a === '-n' || a === '--help' || a === '-h')) continue;
    pushes.push({ dir, skip: [...SKIP_VARS].some((name) => env[name] === '1') });
  }
  return pushes;
}
