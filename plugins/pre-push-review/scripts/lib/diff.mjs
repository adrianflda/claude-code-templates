// Unified-diff parser. Turns `git diff` output into per-file records with exact new-side line
// numbers, so a finding can be checked against what the change really touched and an inline
// pull-request comment can be anchored to a line GitHub will accept.

import { normalizePath } from './glob.mjs';

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** Undo git's C-style quoting of unusual paths ("a/caf\303\251.txt"). */
export function unquotePath(raw) {
  let s = String(raw).trim();
  if (!(s.startsWith('"') && s.endsWith('"'))) return s;
  s = s.slice(1, -1);
  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch !== '\\') {
      bytes.push(...Buffer.from(ch, 'utf8'));
      continue;
    }
    const next = s[++i];
    if (/[0-7]/.test(next ?? '')) {
      let oct = next;
      while (oct.length < 3 && /[0-7]/.test(s[i + 1] ?? '')) oct += s[++i];
      bytes.push(parseInt(oct, 8));
    } else {
      const map = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\' };
      bytes.push(...Buffer.from(map[next] ?? next ?? '', 'utf8'));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

function stripPrefix(path, prefix) {
  const p = unquotePath(path);
  if (p === '/dev/null') return null;
  return normalizePath(p.startsWith(prefix) ? p.slice(prefix.length) : p);
}

function newFile() {
  return {
    path: null,
    oldPath: null,
    status: 'modified',
    binary: false,
    hunks: [],
    additions: 0,
    deletions: 0,
    addedLines: new Set(),
    commentableLines: new Set(),
    patch: '',
  };
}

/** Paths from a `diff --git a/x b/y` header; only trusted when no ---/+++ or rename line follows. */
function pathsFromHeader(line) {
  const rest = line.slice('diff --git '.length);
  const quoted = rest.match(/^("(?:[^"\\]|\\.)*")\s+("(?:[^"\\]|\\.)*")$/);
  if (quoted) return { a: stripPrefix(quoted[1], 'a/'), b: stripPrefix(quoted[2], 'b/') };
  // Unquoted: for an unrenamed file both halves are identical, so split at the midpoint.
  const mid = rest.indexOf(' b/');
  if (rest.startsWith('a/') && (rest.length - 1) % 2 === 0) {
    const half = (rest.length - 1) / 2;
    const a = rest.slice(0, half);
    const b = rest.slice(half + 1);
    if (a.slice(2) === b.slice(2)) return { a: stripPrefix(a, 'a/'), b: stripPrefix(b, 'b/') };
  }
  if (mid > 0) return { a: stripPrefix(rest.slice(0, mid), 'a/'), b: stripPrefix(rest.slice(mid + 1), 'b/') };
  return { a: null, b: null };
}

export function parseDiff(text) {
  const files = [];
  if (typeof text !== 'string' || text === '') return files;

  const lines = text.split('\n');
  let file = null;
  let hunk = null;
  let patchLines = [];
  let oldLine = 0;
  let newLine = 0;
  let remainingOld = 0;
  let remainingNew = 0;

  const flush = () => {
    if (!file) return;
    file.patch = patchLines.join('\n');
    if (!file.path) file.path = file.oldPath;
    files.push(file);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('diff --git ')) {
      flush();
      file = newFile();
      hunk = null;
      patchLines = [line];
      const { a, b } = pathsFromHeader(line);
      file.oldPath = a;
      file.path = b;
      continue;
    }
    if (!file) continue;
    // The trailing empty element produced by a final newline is not part of any patch.
    if (i === lines.length - 1 && line === '') break;
    patchLines.push(line);

    if (line.startsWith('\\')) continue; // "\ No newline at end of file"

    // Inside a hunk the declared line counts decide what is content. Classifying by prefix
    // alone would misread a deleted SQL comment ("--- old note") as a file header.
    if (hunk && (remainingOld > 0 || remainingNew > 0)) {
      const tag = line[0];
      if (tag === '+') {
        hunk.lines.push({ type: 'add', oldLine: null, newLine, text: line.slice(1) });
        file.addedLines.add(newLine);
        file.commentableLines.add(newLine);
        file.additions += 1;
        newLine += 1;
        remainingNew -= 1;
        continue;
      }
      if (tag === '-') {
        hunk.lines.push({ type: 'del', oldLine, newLine: null, text: line.slice(1) });
        file.deletions += 1;
        oldLine += 1;
        remainingOld -= 1;
        continue;
      }
      // A context line; some tools strip the single leading space from blank lines.
      hunk.lines.push({ type: 'ctx', oldLine, newLine, text: line.slice(1) });
      file.commentableLines.add(newLine);
      oldLine += 1;
      newLine += 1;
      remainingOld -= 1;
      remainingNew -= 1;
      continue;
    }

    const m = line.match(HUNK_RE);
    if (m) {
      oldLine = Number(m[1]);
      newLine = Number(m[3]);
      hunk = {
        oldStart: oldLine,
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: newLine,
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        header: m[5].trim(),
        lines: [],
      };
      remainingOld = hunk.oldLines;
      remainingNew = hunk.newLines;
      file.hunks.push(hunk);
      continue;
    }

    hunk = null;
    if (line.startsWith('new file mode')) file.status = 'added';
    else if (line.startsWith('deleted file mode')) file.status = 'deleted';
    else if (line.startsWith('rename from ')) {
      file.status = 'renamed';
      file.oldPath = normalizePath(unquotePath(line.slice('rename from '.length)));
    } else if (line.startsWith('rename to ')) {
      file.status = 'renamed';
      file.path = normalizePath(unquotePath(line.slice('rename to '.length)));
    } else if (line.startsWith('--- ')) {
      const p = stripPrefix(line.slice(4), 'a/');
      if (p) file.oldPath = p;
    } else if (line.startsWith('+++ ')) {
      const p = stripPrefix(line.slice(4), 'b/');
      if (p) file.path = p;
    } else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      file.binary = true;
    }
  }
  flush();
  return files;
}

/** The hunk of `file` whose new-side range contains `line`, or null. */
export function hunkContaining(file, line) {
  if (!file || !Number.isInteger(line)) return null;
  return (
    file.hunks.find((h) => h.lines.some((l) => l.newLine === line && l.type !== 'del')) ?? null
  );
}

/**
 * True when every line of start..end sits on the new side of ONE hunk. GitHub rejects a
 * multi-line comment or suggestion that spans hunks, so callers check this before posting.
 */
export function rangeInSingleHunk(file, start, end) {
  const hunk = hunkContaining(file, start);
  if (!hunk) return false;
  const present = new Set(hunk.lines.filter((l) => l.type !== 'del').map((l) => l.newLine));
  for (let n = start; n <= end; n++) if (!present.has(n)) return false;
  return true;
}

export function diffStats(files) {
  return files.reduce(
    (acc, f) => ({
      files: acc.files + 1,
      additions: acc.additions + f.additions,
      deletions: acc.deletions + f.deletions,
    }),
    { files: 0, additions: 0, deletions: 0 },
  );
}
