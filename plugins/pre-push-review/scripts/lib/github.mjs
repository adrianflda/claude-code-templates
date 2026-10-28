// Publishing a review to a GitHub pull request: one summary comment plus inline comments
// anchored to the changed lines. Everything here is outward-facing, so it only runs when the
// caller explicitly asked to post.
//
// Planning (what would be posted) is separated from posting, and is pure: `planReview` can be
// inspected or printed with --dry-run before anything reaches GitHub.

import { execFileSync } from 'node:child_process';
import { rangeInSingleHunk } from './diff.mjs';
import { renderFindingMarkdown, renderMarkdown, SUMMARY_MARKER } from './report.mjs';

const MARKER_RE = /<!-- pre-push-review:finding fp=([0-9a-f]+) cat=([\w-]+) -->/;

export function findingMarker(f) {
  return `<!-- pre-push-review:finding fp=${f.fingerprint} cat=${f.category} -->`;
}

/** Markers of the comments this harness already left on the pull request. */
export function parseExistingComments(comments) {
  const out = [];
  for (const c of comments) {
    const m = String(c.body ?? '').match(MARKER_RE);
    if (m) out.push({ fingerprint: m[1], category: m[2], path: c.path ?? null, line: c.line ?? null });
  }
  return out;
}

function alreadyPosted(f, existing) {
  return existing.some(
    (e) =>
      e.fingerprint === f.fingerprint ||
      (e.path === f.file && e.category === f.category && e.line != null && f.line != null && Math.abs(e.line - f.line) <= 2),
  );
}

/**
 * Where a finding can be anchored. GitHub accepts a comment only on a line present on the new
 * side of the pull request diff, and a multi-line range only inside a single hunk.
 */
export function anchorFor(f, anchorByPath) {
  const file = anchorByPath.get(f.file);
  if (!file || f.line == null || !file.commentableLines.has(f.line)) return null;
  const end = f.endLine ?? f.line;
  if (end > f.line && rangeInSingleHunk(file, f.line, end)) return { start: f.line, end, exactRange: true };
  return { start: f.line, end: f.line, exactRange: end === f.line };
}

/**
 * Decide what to post. Returns { body, comments, inlineIds, skipped }, where `comments` is the
 * `comments` array of the GitHub "create a review" request and `skipped` lists findings that
 * were already posted by an earlier run.
 */
export function planReview(result, anchorByPath, existing = []) {
  const comments = [];
  const inlineIds = new Set();
  const skipped = [];

  for (const f of result.findings) {
    const anchor = anchorFor(f, anchorByPath);
    if (!anchor) continue;
    inlineIds.add(f.id);
    if (alreadyPosted(f, existing)) {
      skipped.push(f.id);
      continue;
    }
    // A suggestion block replaces exactly the commented range, so it is only offered when the
    // range GitHub will anchor is the range the replacement was written for.
    const body = `${renderFindingMarkdown(f, { withSuggestionBlock: anchor.exactRange })}\n\n${findingMarker(f)}`;
    const comment = { path: f.file, line: anchor.end, side: 'RIGHT', body };
    if (anchor.end > anchor.start) Object.assign(comment, { start_line: anchor.start, start_side: 'RIGHT' });
    comments.push(comment);
  }

  return { body: renderMarkdown(result, { inlineIds }), comments, inlineIds, skipped };
}

// --- gh access --------------------------------------------------------------------------------

function ghApi(args, { cwd, input } = {}) {
  return execFileSync('gh', ['api', ...args], {
    cwd,
    input,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
}

function ghError(e) {
  return String(e.stderr || e.stdout || e.message || '').trim().split('\n').slice(0, 3).join(' ').slice(0, 400);
}

/** `gh api --paginate --jq` prints one compact JSON value per line. */
function listAll(endpoint, jq, cwd) {
  const out = ghApi([endpoint, '--paginate', '--jq', jq], { cwd });
  return out.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

export function fetchExistingComments(pr, cwd) {
  return parseExistingComments(
    listAll(`repos/${pr.repo}/pulls/${pr.number}/comments`, '.[] | {body, path, line}', cwd),
  );
}

function findSummaryComment(pr, cwd) {
  const login = ghApi(['user', '--jq', '.login'], { cwd }).trim();
  const mine = listAll(`repos/${pr.repo}/issues/${pr.number}/comments`, '.[] | {id, body, user: .user.login}', cwd)
    .filter((c) => c.user === login && String(c.body ?? '').includes(SUMMARY_MARKER));
  return mine.length ? mine[mine.length - 1] : null;
}

/**
 * Post the planned review. A full review edits the harness's previous summary comment in
 * place; an incremental one adds a new comment, so the record of earlier rounds stays intact.
 * Returns { ok, summaryUrl, inlinePosted, inlineFailed, error }.
 */
export function postReview({ plan, result, cwd }) {
  const pr = result.scope.pr;
  const outcome = { ok: true, summaryUrl: null, inlinePosted: 0, inlineFailed: null, error: null };

  if (plan.comments.length) {
    const payload = { commit_id: pr.headSha, event: 'COMMENT', body: '', comments: plan.comments };
    try {
      ghApi([`repos/${pr.repo}/pulls/${pr.number}/reviews`, '--method', 'POST', '--input', '-'], { cwd, input: JSON.stringify(payload) });
      outcome.inlinePosted = plan.comments.length;
    } catch (e) {
      // GitHub rejects the whole review when one anchor is invalid. The findings are not lost:
      // the summary is rebuilt to list every finding in full.
      outcome.inlineFailed = ghError(e);
      plan = { ...plan, body: renderMarkdown(result, { inlineIds: new Set() }) };
    }
  }

  try {
    const previous = result.scope.incremental ? null : findSummaryComment(pr, cwd);
    const response = previous
      ? ghApi([`repos/${pr.repo}/issues/comments/${previous.id}`, '--method', 'PATCH', '--input', '-'], { cwd, input: JSON.stringify({ body: plan.body }) })
      : ghApi([`repos/${pr.repo}/issues/${pr.number}/comments`, '--method', 'POST', '--input', '-'], { cwd, input: JSON.stringify({ body: plan.body }) });
    outcome.summaryUrl = JSON.parse(response).html_url ?? null;
  } catch (e) {
    outcome.ok = false;
    outcome.error = ghError(e);
  }
  return outcome;
}
