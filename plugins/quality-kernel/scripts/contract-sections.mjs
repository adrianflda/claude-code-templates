// Shared contract-section parser — EARS-H1/H2/H2b/H3/H4/H4b/H5 (specs/qk-breaker-robust-input/spec.md).
//
// One mechanism, consumed by breaker-invoke.mjs, contract-lint.mjs and gstack-breaker.mjs, so the
// "QA procedure" / "Invariants" heading match and the invariant-table row scan can never drift
// between the places that parse a contract (spec.md §0's blocker: two independent copies silently
// diverging on the SAME real contract shape). This module only recognizes sections and rows — it
// never decides what to DO when a section is empty (that is EARS-H6/H9, left to each caller via
// emptySectionReason).

const HEADING_LINE_RE = /^(#{2,3})\s+(.*)$/;

function headingText(line) {
  const m = line.match(HEADING_LINE_RE);
  return m ? { level: m[1].length, text: m[2].trim() } : null;
}

// EARS-H1: "QA procedure" anywhere in the heading text, case-insensitive, any prefix/suffix.
export function isQaProcedureHeading(text) {
  return /qa procedure/i.test(text);
}
// EARS-H2: "External Observable Invariants" OR the bare word "Invariants", case-insensitive.
export function isInvariantsHeading(text) {
  return /external observable invariants/i.test(text) || /\binvariants\b/i.test(text);
}

// EARS-H5: split a table row into cells. `|` is a cell boundary only when it is NOT immediately
// preceded by `\` (escaped pipe = literal content) AND NOT inside an open inline-code (`` ` ``) span.
export function splitRow(line) {
  const cells = [];
  let cur = '';
  let backtickOpen = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '`') {
      backtickOpen = !backtickOpen;
      cur += c;
      continue;
    }
    if (c === '|' && line[i - 1] !== '\\' && !backtickOpen) {
      cells.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  cells.push(cur);
  return cells;
}

function rowCells(line) {
  const raw = splitRow(line.trim());
  if (raw.length && raw[0].trim() === '') raw.shift(); // leading cell from the row's own leading "|"
  if (raw.length && raw[raw.length - 1].trim() === '') raw.pop(); // trailing cell from the closing "|"
  return raw;
}

// EARS-H4: id grammar — one or more letters/digits, a hyphen, then more letters/digits/hyphens.
const ID_TOKEN_RE = /^[A-Za-z0-9]+-[A-Za-z0-9-]+$/;

// EARS-H4: normalize a table row's first cell to the bare id. Strip a MATCHING pair of leading/
// trailing `**`; if only one side carries `**` (malformed), leave both stray markers in place. Then
// strip every trailing " (...)" parenthetical, repeating until none remain.
export function normalizeId(rawCell) {
  let cell = rawCell.trim();
  if (cell.length >= 4 && cell.startsWith('**') && cell.endsWith('**')) {
    cell = cell.slice(2, -2).trim();
  }
  let stripped = true;
  while (stripped) {
    stripped = false;
    const next = cell.replace(/\s+\([^()]*\)$/, '');
    if (next !== cell) {
      cell = next.trim();
      stripped = true;
    }
  }
  return cell;
}

// EARS-H4/H4b: parse an invariants table out of a section's already-extracted body text. First row
// wins on a duplicate id within the SAME table (Map preserves first-insertion order).
export function parseInvariantsTable(sectionText) {
  const byId = new Map();
  for (const line of sectionText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    const cells = rowCells(trimmed);
    if (cells.length < 2) continue;
    const id = normalizeId(cells[0]);
    if (!ID_TOKEN_RE.test(id)) continue; // not an id row (header row, separator row, prose)
    if (byId.has(id)) continue;
    // EARS-H5: expected = the LAST cell, trimmed, regardless of how many cells are in between.
    byId.set(id, cells[cells.length - 1].trim());
  }
  return [...byId.entries()].map(([id, expected]) => ({ id, expected }));
}

// EARS-H1/H2/H2b/H3: a single pass that finds the FIRST top-level heading matching each of the QA
// and Invariants matchers, and ends each section at the next heading whose level is <= the opener's
// (a DEEPER heading, and its content — including one that itself lexically matches the OTHER
// matcher — stays swallowed inside the currently open section: EARS-H3 outranks EARS-H2/H2b).
export function scanSections(md) {
  const lines = md.split('\n');
  let open = null; // { kind: 'qa' | 'inv', level }
  let qaFound = false;
  let invFound = false;
  const qaLines = [];
  const invLines = [];
  const headingLines = [];
  for (const line of lines) {
    const h = headingText(line);
    if (h) {
      headingLines.push(line);
      if (open && h.level <= open.level) open = null; // same/shallower heading ends the open section
      if (open) {
        (open.kind === 'qa' ? qaLines : invLines).push(line);
        continue;
      }
      if (!qaFound && isQaProcedureHeading(h.text)) {
        open = { kind: 'qa', level: h.level };
        qaFound = true;
        continue;
      }
      if (!invFound && isInvariantsHeading(h.text)) {
        open = { kind: 'inv', level: h.level };
        invFound = true;
        continue;
      }
      continue; // an unrecognized top-level heading: not content of either section
    }
    if (open) (open.kind === 'qa' ? qaLines : invLines).push(line);
  }
  return {
    qaProcedure: qaLines.join('\n').trim(),
    invariants: parseInvariantsTable(invLines.join('\n')),
    headingLines,
  };
}

// EARS-H6/H9: null when both sections are non-empty; else a reason naming which is empty (both,
// named together, when both are) and listing every ##/### heading line found, verbatim, in order.
export function emptySectionReason({ qaProcedure, invariants, headingLines }) {
  const qaEmpty = !qaProcedure || qaProcedure.trim() === '';
  const invEmpty = !invariants || invariants.length === 0;
  if (!qaEmpty && !invEmpty) return null;
  const names = [qaEmpty ? 'qaProcedure' : null, invEmpty ? 'invariants' : null].filter(Boolean);
  const which = names.length === 2 ? `${names[0]} and ${names[1]} are both empty` : `${names[0]} is empty`;
  return `${which} — headings found: ${headingLines.join(' | ')}`;
}
