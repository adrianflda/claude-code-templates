/**
 * The diff-budgeting logic for the pre-push review panel, extracted into its own module so it is
 * importable and unit-testable in isolation (ai-review-panel.mjs otherwise runs real git/agent calls
 * at import time — OG-19/INV-OG-13, residual risk #4 of docs/contracts/org-guide-v1.md).
 *
 * OG-17/F17: the previous version reserved a FIXED 50-line budget for the skipped-files footer
 * ("MAX_DIFF_LINES - 50"), independent of how many files actually ended up skipped. Once more than
 * ~48 files were skipped, the footer itself grew past 50 lines, pushing the total output over
 * MAX_DIFF_LINES; the separate, later line-count truncation step then cut the footer itself,
 * silently dropping some of the names it had just claimed to list (one file using 2940 of the
 * 2950-line budget plus 60 skipped tiny files: the footer claimed "60 file(s) not reviewed" but only
 * 54 names survived the later truncation).
 *
 * The fix: pack files first against the FULL line/byte budget (no blind reservation), then compute
 * the footer's EXACT size for whatever ended up skipped, and if kept + that exact footer would still
 * exceed the budget, move files from the end of `kept` into `skipped` (growing the footer by one line
 * each time) until it fits. The later line-count truncation in ai-review-panel.mjs is kept as a
 * defense-in-depth safety net for cases outside this function's control (e.g. text appended after
 * this runs) — F23 found removing it would delete the only cap left for a related pathological case —
 * but with this fix it should not normally fire for the footer itself anymore.
 */

export const MAX_DIFF_LINES = 3000;
const envInt = (name, fallback) => {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
export const MAX_DIFF_BYTES = envInt('AI_REVIEW_MAX_DIFF_BYTES', 400_000);
export const MAX_FILE_BYTES = envInt('AI_REVIEW_MAX_FILE_BYTES', 100_000);
export const MAX_LINE_CHARS = envInt('AI_REVIEW_MAX_LINE_CHARS', 2_000);

// Lines in the rendered footer for N skipped files: a blank separator line, the "N file(s) not
// reviewed" header line, and one line per name.
const footerLines = (n) => (n === 0 ? 0 : 2 + n);

/**
 * Bound a git diff by bytes and lines, file by file. A file whose diff has a line over
 * MAX_LINE_CHARS or is over MAX_FILE_BYTES (generated, minified, data) keeps only its header plus a
 * note. Files are then packed in diff order while they fit both MAX_DIFF_BYTES and MAX_DIFF_LINES
 * (whole files only, so the line cap never cuts a file in half); files that do not fit — including
 * any moved out afterward to make exact room for the footer — are listed by name, and every name
 * listed is guaranteed present in the returned text (OG-17).
 *
 * opts.log: an optional function(message) for progress/diagnostic logging (defaults to a no-op, so
 * importing this module for a unit test has no side effects).
 */
export function boundDiffBytes(text, opts = {}) {
  const log = opts.log || (() => {});
  const chunks = text.split(/^(?=diff --git )/m).filter(Boolean);
  const entries = chunks.map((chunk, idx) => {
    const name = (chunk.match(/^diff --git a\/.+? b\/(.+)$/m) || [])[1] || '(unknown file)';
    const bytes = Buffer.byteLength(chunk);
    const longest = chunk.split('\n').reduce((m, l) => Math.max(m, l.length), 0);
    let piece = chunk;
    if (longest > MAX_LINE_CHARS || bytes > MAX_FILE_BYTES) {
      const body = chunk.search(/^(@@|Binary files )/m);
      const header = body === -1 ? chunk.split('\n').slice(0, 6).join('\n') : chunk.slice(0, body);
      piece = `${header.trimEnd()}\n# [pre-push-review] content omitted: ${bytes} bytes, longest line ${longest} chars (generated, minified or data).\n`;
      log(`[pre-push-review] ${name}: content omitted (${bytes} bytes, longest line ${longest} chars).`);
    }
    return { idx, name, piece, size: Buffer.byteLength(piece), lines: piece.split('\n').length };
  });

  const kept = [];
  const skipped = [];
  let usedBytes = 0;
  let usedLines = 0;
  for (const e of entries) {
    if (usedBytes + e.size > MAX_DIFF_BYTES || usedLines + e.lines > MAX_DIFF_LINES) { skipped.push(e); continue; }
    kept.push(e);
    usedBytes += e.size;
    usedLines += e.lines;
  }
  // The footer itself costs lines; make exact room for it instead of a blind fixed reservation
  // (OG-17/F17) — shrink kept, growing the footer by exactly one line per file moved, until it fits.
  while (skipped.length && usedLines + footerLines(skipped.length) > MAX_DIFF_LINES) {
    const moved = kept.pop();
    usedLines -= moved.lines;
    usedBytes -= moved.size;
    skipped.push(moved);
  }
  if (!skipped.length) return kept.map((e) => e.piece).join('');
  kept.sort((a, b) => a.idx - b.idx);
  skipped.sort((a, b) => a.idx - b.idx);
  log(`[pre-push-review] Diff is over the ${MAX_DIFF_BYTES}-byte / ${MAX_DIFF_LINES}-line budget: ${skipped.length} file(s) not sent (review is partial).`);
  return `${kept.map((e) => e.piece).join('')}\n# [pre-push-review] ${skipped.length} file(s) not reviewed (over the diff budget):\n${skipped.map((e) => `#   ${e.name}`).join('\n')}\n`;
}
