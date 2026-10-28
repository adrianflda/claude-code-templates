// Finding normalization, de-duplication and ranking.
//
// Reviewer output is model output: every field is validated before it is trusted. A finding
// that points at a file the change did not touch, or at a line that does not exist, is kept
// only in a form that makes that visible — it is never silently "fixed up" to look anchored.

import { createHash } from 'node:crypto';
import { SEVERITIES } from './config.mjs';
import { normalizePath } from './glob.mjs';

export const RANK = Object.freeze({ critical: 0, high: 1, medium: 2, low: 3 });
export const VERDICTS = ['confirmed', 'refuted', 'unverifiable', 'unverified', 'deterministic'];

const SEVERITY_ALIASES = { blocker: 'critical', major: 'high', error: 'high', moderate: 'medium', warning: 'medium', minor: 'low', info: 'low', trivial: 'low', note: 'low' };

export function coerceSeverity(value) {
  const s = String(value ?? '').trim().toLowerCase();
  if (SEVERITIES.includes(s)) return s;
  return SEVERITY_ALIASES[s] ?? null;
}

function text(value, max) {
  if (typeof value !== 'string') return '';
  const t = value.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function cleanPath(value) {
  let p = normalizePath(String(value ?? '').trim());
  // Reviewers sometimes echo the diff prefixes.
  if (/^[ab]\//.test(p)) p = p.slice(2);
  return p;
}

function intOrNull(value) {
  const n = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value;
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Words of a title, for similarity; digits and punctuation carry no meaning here. */
function tokens(s) {
  return new Set(
    String(s ?? '')
      .toLowerCase()
      .replace(/[^a-z\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
}

export function similarity(a, b) {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const w of ta) if (tb.has(w)) shared += 1;
  return shared / (ta.size + tb.size - shared);
}

/** Stable across runs only as far as the title wording is; used to de-duplicate PR comments. */
export function fingerprint(f) {
  const title = [...tokens(f.title)].sort().join(' ');
  return createHash('sha256').update(`${f.file}\n${f.category}\n${title}`).digest('hex').slice(0, 16);
}

/**
 * Validate one raw finding against the diff. Returns { finding } or { rejected: reason }.
 * @param raw     object produced by a reviewer or a tool parser
 * @param source  { kind: 'reviewer'|'tool', name, category }
 * @param byPath  Map of changed path -> parsed diff file
 */
export function normalizeFinding(raw, source, byPath) {
  if (raw == null || typeof raw !== 'object') return { rejected: 'not an object' };
  const severity = coerceSeverity(raw.severity);
  if (!severity) return { rejected: `unknown severity "${raw.severity}"` };
  const file = cleanPath(raw.file);
  if (!file) return { rejected: 'no file' };
  const title = text(raw.title, 160) || text(raw.issue, 160);
  const issue = text(raw.issue, 2000) || title;
  if (!title) return { rejected: 'no description' };

  const diffFile = byPath.get(file) ?? null;
  let line = intOrNull(raw.line);
  let endLine = intOrNull(raw.endLine);
  if (endLine != null && (line == null || endLine < line)) endLine = null;

  const inDiff = diffFile != null;
  const lineInDiff = inDiff && line != null && diffFile.commentableLines.has(line);
  const lineAdded = inDiff && line != null && diffFile.addedLines.has(line);

  let confidence = Number(raw.confidence);
  if (!Number.isFinite(confidence)) confidence = null;
  else confidence = Math.min(1, Math.max(0, confidence));

  const replacement = typeof raw.replacement === 'string' && raw.replacement !== '' ? raw.replacement : null;

  const finding = {
    id: null,
    severity,
    category: source.category,
    source: source.kind,
    reportedBy: [source.name],
    file,
    line,
    endLine,
    title,
    issue,
    evidence: text(raw.evidence, 2000),
    suggestion: text(raw.suggestion, 2000),
    replacement,
    rule: text(raw.rule, 120) || null,
    confidence,
    inDiff,
    lineInDiff,
    lineAdded,
    verdict: source.kind === 'tool' ? 'deterministic' : 'unverified',
    verification: null,
  };
  finding.fingerprint = fingerprint(finding);
  return { finding };
}

const SAME_WORDING = 0.5;

function sameIssue(a, b) {
  if (a.file !== b.file) return false;
  if (a.source === 'tool' || b.source === 'tool') {
    return a.source === b.source && a.line === b.line && a.rule === b.rule && a.title === b.title;
  }
  if (a.line == null || b.line == null) return a.line === b.line && similarity(a.title, b.title) >= SAME_WORDING;
  // Similar wording a couple of lines apart is one issue, whoever reported it.
  if (Math.abs(a.line - b.line) <= 2 && similarity(a.title, b.title) >= SAME_WORDING) return true;
  // Different reviewers pointing at the very same line are treated as one issue seen from two
  // angles. One reviewer listing two things on a line means two things.
  return a.line === b.line && !a.reportedBy.some((r) => b.reportedBy.includes(r));
}

/**
 * Merge findings that describe the same issue. The most severe one becomes the finding, every
 * reporter is remembered — independent reviewers agreeing is itself a signal — and a merged
 * finding that was worded differently is kept in `alsoReported`, so merging loses nothing.
 */
export function dedupe(findings) {
  const out = [];
  for (const f of findings) {
    const hit = out.find((o) => sameIssue(o, f));
    if (!hit) {
      out.push({ ...f, reportedBy: [...f.reportedBy], alsoReported: [] });
      continue;
    }
    const reporters = [...new Set([...hit.reportedBy, ...f.reportedBy])];
    const also = [...hit.alsoReported];
    const [primary, secondary] = RANK[f.severity] < RANK[hit.severity] ? [f, hit] : [hit, f];
    if (similarity(primary.title, secondary.title) < SAME_WORDING) {
      also.push({ by: secondary.reportedBy[0], severity: secondary.severity, title: secondary.title });
    }
    Object.assign(hit, { ...primary, reportedBy: reporters, alsoReported: also });
  }
  return out;
}

const VERDICT_ORDER = { confirmed: 0, deterministic: 0, unverified: 1, unverifiable: 2, refuted: 3 };

export function rank(findings) {
  return [...findings].sort(
    (a, b) =>
      RANK[a.severity] - RANK[b.severity] ||
      (VERDICT_ORDER[a.verdict] ?? 9) - (VERDICT_ORDER[b.verdict] ?? 9) ||
      (b.confidence ?? 0) - (a.confidence ?? 0) ||
      a.file.localeCompare(b.file) ||
      (a.line ?? 0) - (b.line ?? 0),
  );
}

export function assignIds(findings) {
  return findings.map((f, i) => ({ ...f, id: `F${i + 1}` }));
}

export function countBySeverity(findings) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) counts[f.severity] += 1;
  return counts;
}

/**
 * A finding blocks when it is at or above the blocking severity AND nothing has cast doubt on
 * it: confirmed by the verifier, produced by a deterministic tool, or never verified because
 * verification did not run. `unverifiable` means the verifier looked and could not establish
 * the defect, so it is reported for a human but does not block.
 */
export function isBlocking(f, blockOn) {
  const threshold = blockOn === 'high' ? RANK.high : RANK.critical;
  if (RANK[f.severity] > threshold) return false;
  return f.verdict === 'confirmed' || f.verdict === 'deterministic' || f.verdict === 'unverified';
}
