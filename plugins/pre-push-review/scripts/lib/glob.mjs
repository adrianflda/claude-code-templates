// Minimal glob matcher (zero dependencies) used for excludes, path instructions and learnings.
//
// Supported: `**` (any depth, including none), `*` (within one segment), `?` (one character),
// and a trailing `/` meaning "everything under this directory". A pattern without a slash is
// matched against the basename at any depth, like a .gitignore entry (`*.lock` matches
// `a/b/yarn.lock`). Everything else is literal.

const cache = new Map();

function escapeLiteral(ch) {
  return /[\\^$.*+?()[\]{}|/]/.test(ch) ? `\\${ch}` : ch;
}

export function globToRegExp(pattern) {
  const cached = cache.get(pattern);
  if (cached) return cached;

  let p = String(pattern).trim().replace(/^\.\//, '').replace(/^\/+/, '');
  if (p.endsWith('/')) p += '**';
  const anyDepth = !p.includes('/');

  let re = '';
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === '*') {
      if (p[i + 1] === '*') {
        // `**/` matches zero or more directories; a bare `**` matches anything.
        if (p[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else {
      re += escapeLiteral(ch);
    }
  }

  const compiled = new RegExp(`^${anyDepth ? '(?:.*/)?' : ''}${re}$`);
  cache.set(pattern, compiled);
  return compiled;
}

export function matchesGlob(path, pattern) {
  if (typeof pattern !== 'string' || pattern.trim() === '') return false;
  return globToRegExp(pattern).test(normalizePath(path));
}

export function matchesAny(path, patterns) {
  if (!Array.isArray(patterns)) return false;
  return patterns.some((p) => matchesGlob(path, p));
}

/** Repo-relative, forward-slash path without a leading `./`. */
export function normalizePath(path) {
  return String(path ?? '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
}
