// RED canary for the referee (`--canary`): a gate never seen RED is theater.
//
// After a green run, the referee re-runs the verify command on a throwaway copy of the head tree in
// which every test file raises on load. A command that really executes tests must then exit non-zero.
// If it still exits 0, it runs no tests (a no-op such as `npx --no true`, `MAKEFLAGS=n make test`,
// `cross-env` with no command, or `... || true`) and the green result proves nothing.
//
// What it proves: the command executes at least one sabotaged file AND propagates its failure to the
// exit status. What it does not prove: that the command runs EVERY test (a suite narrowed to one file
// still passes the canary). That residual is the human approval of the command.

import { globToRegExp, TEST_GLOBS } from './route.mjs';

// Test-file conventions, deliberately wider than any repo's declared testGlobs: the command must fail
// if it runs ANY of them, so a proposal cannot dodge the canary by declaring narrow testGlobs.
export const CANARY_GLOBS = [
  '**/*.test.*', '**/*.spec.*', '**/__tests__/**', 'tests/**', 'test/**',
  '**/test_*.py', '**/*_test.py', '**/tests.py', '**/tests/**/*.py',
];
const JS = /\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/;
const PY = /\.py$/;
const MARK = 'quality-kernel canary: this run must fail';

export function canaryMatcher(extraGlobs = []) {
  const res = [...new Set([...CANARY_GLOBS, ...TEST_GLOBS, ...extraGlobs.filter((g) => typeof g === 'string')])].map(globToRegExp);
  return (p) => (JS.test(p) || PY.test(p)) && res.some((re) => re.test(p));
}

// The sabotaged bytes of one test file, or null when it is not a JS/TS/Python file. The raise goes
// right after a shebang / encoding line so the file still parses as far as the first statement; a
// file that then fails to parse (e.g. a Python `from __future__` import after it) fails too, which is
// all the canary needs.
export function sabotage(path, body) {
  const text = Buffer.isBuffer(body) ? body.toString('utf8') : String(body);
  const line = JS.test(path) ? `throw new Error(${JSON.stringify(MARK)});\n`
    : PY.test(path) ? `raise RuntimeError(${JSON.stringify(MARK)})\n` : null;
  if (!line) return null;
  const lines = text.split('\n');
  let keep = 0;
  if (lines[0] && lines[0].startsWith('#!')) keep = 1;
  if (PY.test(path) && lines[keep] !== undefined && /^#.*coding[:=]/.test(lines[keep])) keep += 1;
  return Buffer.from([...lines.slice(0, keep), line + lines.slice(keep).join('\n')].join('\n'));
}
