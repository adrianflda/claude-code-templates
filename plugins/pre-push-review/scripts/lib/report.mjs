// Renderers for a review result: terminal text, Markdown, JSON, and NDJSON for coding agents.
// They only format what the result already holds; no renderer decides anything.

import { shortSha } from './git.mjs';

export const FORMATS = ['text', 'markdown', 'json', 'ndjson'];

const VERDICT_LABEL = {
  confirmed: 'verified',
  deterministic: 'tool',
  unverified: 'not verified',
  unverifiable: 'could not be verified',
  refuted: 'refuted',
};

function location(f) {
  if (f.line == null) return f.file;
  return f.endLine && f.endLine !== f.line ? `${f.file}:${f.line}-${f.endLine}` : `${f.file}:${f.line}`;
}

function usd(n) {
  return typeof n === 'number' && Number.isFinite(n) ? `$${n.toFixed(2)}` : 'n/a';
}

function seconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function countsLine(counts) {
  return `${counts.critical} critical, ${counts.high} high, ${counts.medium} medium, ${counts.low} low`;
}

/** Whether every stage that was supposed to run did run; a partial review must say so. */
export function completeness(result) {
  const gaps = [];
  const failedReviewers = result.reviewers.filter((r) => !r.ok);
  if (failedReviewers.length) gaps.push(`${failedReviewers.length} of ${result.reviewers.length} reviewer(s) failed: ${failedReviewers.map((r) => r.title).join(', ')}`);
  if (result.verification.ran && !result.verification.ok) gaps.push(`verification failed for ${result.verification.failedBatches} of ${result.verification.batches} batch(es)`);
  if (!result.verification.ran && result.verification.skipped) gaps.push(`verification was skipped (${result.verification.skipped})`);
  for (const t of result.tools) {
    if (t.status === 'error' || t.status === 'timeout') gaps.push(`${t.name} did not complete: ${t.reason}`);
  }
  return gaps;
}

/**
 * The instruction block a coding agent needs to fix one finding. It carries the verification
 * status so the agent knows how much to trust the claim before changing code.
 */
export function fixPrompt(f) {
  const lines = [
    `In ${location(f)}: ${f.title}`,
    '',
    f.issue,
  ];
  if (f.suggestion) lines.push('', `Suggested fix: ${f.suggestion}`);
  if (f.replacement) lines.push('', 'Proposed replacement for the cited lines:', '```', f.replacement, '```');
  lines.push(
    '',
    f.verdict === 'confirmed' || f.verdict === 'deterministic'
      ? 'This finding was verified. Read the code, apply the fix, and keep the change minimal.'
      : 'This finding was NOT verified. Read the code first and confirm the defect exists before changing anything.',
  );
  return lines.join('\n');
}

// --- text -------------------------------------------------------------------------------------

export function renderText(result) {
  const out = [];
  const { scope } = result;
  out.push('==================================');
  out.push('  pre-push-review');
  out.push('==================================');
  out.push(`Scope: ${scope.description}`);
  out.push(`       ${shortSha(scope.baseSha) || '(none)'} → ${scope.headSha ? shortSha(scope.headSha) : scope.headKind} · ${scope.stats.files} file(s), +${scope.stats.additions} / -${scope.stats.deletions}`);
  for (const note of scope.notes) out.push(`Note:  ${note}`);
  if (scope.excluded.length) out.push(`Excluded: ${scope.excluded.length} file(s) matched an exclude pattern`);

  if (result.summary) {
    out.push('', result.summary.text);
    if (result.summary.effort) out.push(`Review effort: ${result.summary.effort}/5`);
  }

  if (result.tools.length) {
    out.push('', 'Deterministic tools');
    for (const t of result.tools) {
      const detail = t.status === 'findings' ? `${t.findings} finding(s)` : t.reason ? `${t.status}: ${t.reason}` : t.status;
      const extra = t.outsideChange ? ` (${t.outsideChange} outside the change, not reported)` : '';
      out.push(`  • ${t.name.padEnd(28)} ${detail}${extra}`);
    }
  }

  if (result.reviewers.length) {
    out.push('', 'Reviewers');
    for (const r of result.reviewers) {
      out.push(`  • ${r.title.padEnd(28)} ${r.ok ? `${r.findings} finding(s)` : `FAILED: ${r.error}`}`);
    }
  }

  const v = result.verification;
  if (v.ran) out.push('', `Verification: ${v.confirmed} confirmed, ${v.refuted} refuted, ${v.unverifiable} could not be verified${v.ok ? '' : `, ${v.unverified} not verified (verifier failed)`}`);
  else if (v.skipped) out.push('', `Verification: skipped (${v.skipped})`);

  out.push('');
  if (result.findings.length === 0) out.push('No findings.');
  for (const f of result.findings) {
    out.push(`[${f.severity.toUpperCase()}] ${f.id} ${location(f)} — ${f.title}  (${f.reportedBy.join(', ')} · ${VERDICT_LABEL[f.verdict] ?? f.verdict})`);
    if (f.issue && f.issue !== f.title) out.push(`        ${f.issue}`);
    if (f.suggestion) out.push(`        ↳ ${f.suggestion}`);
    for (const a of f.alsoReported ?? []) out.push(`        + ${a.by} on the same line: ${a.title}`);
    if (f.verification?.reason) out.push(`        ✓ ${f.verification.reason}`);
  }

  if (result.dropped.length) {
    out.push('', `Dropped: ${result.dropped.length} finding(s) — ${summarizeDropped(result.dropped)}`);
  }

  const gaps = completeness(result);
  if (gaps.length) {
    out.push('', 'This review is PARTIAL:');
    for (const g of gaps) out.push(`  - ${g}`);
  }

  out.push('', `SUMMARY: ${countsLine(result.counts)}`);
  out.push(`Cost ${usd(result.costUsd)} · ${seconds(result.durationMs)}`);
  if (result.blocking.length) {
    out.push('', '==================================');
    out.push(`  BLOCKED: ${result.blocking.length} blocking finding(s): ${result.blocking.join(', ')}`);
    out.push('==================================');
  }
  return out.join('\n');
}

function summarizeDropped(dropped) {
  const by = {};
  for (const d of dropped) by[d.droppedReason] = (by[d.droppedReason] ?? 0) + 1;
  return Object.entries(by).map(([k, n]) => `${n} ${k}`).join(', ');
}

// --- markdown ---------------------------------------------------------------------------------

export const SUMMARY_MARKER = '<!-- pre-push-review:summary -->';

function mdEscape(s) {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

export function renderFindingMarkdown(f, { withSuggestionBlock = false } = {}) {
  const out = [];
  out.push(`**[${f.severity.toUpperCase()}] ${f.title}**`);
  out.push('');
  if (f.issue && f.issue !== f.title) out.push(f.issue, '');
  if (f.suggestion) out.push(`**Suggested fix:** ${f.suggestion}`, '');
  if (withSuggestionBlock && f.replacement) out.push('```suggestion', f.replacement, '```', '');
  for (const a of f.alsoReported ?? []) out.push(`Also on this line (${a.by}): ${a.title}`, '');
  const meta = [`${f.reportedBy.join(', ')}`, VERDICT_LABEL[f.verdict] ?? f.verdict];
  if (f.verification?.reason) meta.push(f.verification.reason);
  out.push(`<sub>${meta.map(mdEscape).join(' · ')}</sub>`);
  return out.join('\n');
}

export function renderMarkdown(result, { inlineIds = new Set() } = {}) {
  const out = [SUMMARY_MARKER, '## Code review — pre-push-review', ''];
  const { scope } = result;
  out.push(`Reviewed **${scope.description}** at \`${scope.headSha ? shortSha(scope.headSha) : scope.headKind}\`: ${scope.stats.files} file(s), +${scope.stats.additions} / -${scope.stats.deletions}.`);
  out.push('');

  if (result.summary) {
    out.push(result.summary.text, '');
    if (result.summary.effort) out.push(`**Review effort:** ${result.summary.effort}/5`, '');
    if (result.summary.risks.length) {
      out.push('**Look closely at:**');
      for (const r of result.summary.risks) out.push(`- ${r}`);
      out.push('');
    }
    if (result.summary.walkthrough.length) {
      out.push('<details><summary>Walkthrough</summary>', '', '| File | Change |', '|---|---|');
      for (const w of result.summary.walkthrough) out.push(`| \`${mdEscape(w.file)}\` | ${mdEscape(w.change)} |`);
      out.push('', '</details>', '');
    }
  }

  out.push(`**Findings:** ${countsLine(result.counts)}`, '');
  const general = result.findings.filter((f) => !inlineIds.has(f.id));
  const inline = result.findings.filter((f) => inlineIds.has(f.id));
  if (inline.length) out.push(`${inline.length} finding(s) are posted as inline comments on the changed lines.`, '');
  if (result.findings.length === 0) out.push('No findings.', '');
  for (const f of general) {
    out.push(`- \`${location(f)}\` — ${renderFindingMarkdown(f).split('\n').join('\n  ')}`);
  }
  if (general.length) out.push('');

  const checks = [
    ...result.tools.map((t) => `| ${mdEscape(t.name)} | ${t.status === 'findings' ? `${t.findings} finding(s)` : mdEscape(t.reason ? `${t.status}: ${t.reason}` : t.status)} |`),
    ...result.reviewers.map((r) => `| ${mdEscape(r.title)} | ${r.ok ? `${r.findings} finding(s)` : `failed: ${mdEscape(r.error)}`} |`),
  ];
  if (checks.length) {
    out.push('<details><summary>What ran</summary>', '', '| Check | Result |', '|---|---|', ...checks, '');
    const v = result.verification;
    if (v.ran) out.push(`Verification: ${v.confirmed} confirmed, ${v.refuted} refuted and dropped, ${v.unverifiable} could not be verified.`, '');
    out.push('</details>', '');
  }

  const gaps = completeness(result);
  if (gaps.length) {
    out.push('> **This review is partial.**');
    for (const g of gaps) out.push(`> - ${g}`);
    out.push('');
  }
  out.push('<sub>Automated review. Findings marked "verified" were checked against the code by an independent pass; the rest need a human look.</sub>');
  return out.join('\n');
}

// --- machine formats --------------------------------------------------------------------------

/** The result without the parsed diff, which is large and reproducible from the SHAs. */
export function toSerializable(result) {
  const { scope } = result;
  return {
    ...result,
    scope: {
      mode: scope.mode,
      description: scope.description,
      root: scope.root,
      baseSha: scope.baseSha,
      headSha: scope.headSha,
      headKind: scope.headKind,
      key: scope.key,
      incremental: scope.incremental,
      notes: scope.notes,
      pr: scope.pr,
      stats: scope.stats,
      excluded: scope.excluded,
      files: scope.files.map((f) => ({ path: f.path, status: f.status, additions: f.additions, deletions: f.deletions, binary: f.binary })),
    },
  };
}

export function renderJson(result) {
  return JSON.stringify(toSerializable(result), null, 2);
}

export function renderNdjson(result) {
  const rows = [
    { type: 'review', scope: result.scope.description, baseSha: result.scope.baseSha, headSha: result.scope.headSha, files: result.scope.stats.files },
    ...result.findings.map((f) => ({
      type: 'finding',
      id: f.id,
      severity: f.severity,
      category: f.category,
      verdict: f.verdict,
      file: f.file,
      line: f.line,
      endLine: f.endLine,
      title: f.title,
      issue: f.issue,
      suggestion: f.suggestion || null,
      replacement: f.replacement,
      blocking: result.blocking.includes(f.id),
      fixPrompt: fixPrompt(f),
    })),
    { type: 'complete', counts: result.counts, blocking: result.blocking, partial: completeness(result).length > 0, costUsd: result.costUsd },
  ];
  return rows.map((r) => JSON.stringify(r)).join('\n');
}

export function render(result, format) {
  if (format === 'json') return renderJson(result);
  if (format === 'ndjson') return renderNdjson(result);
  if (format === 'markdown') return renderMarkdown(result);
  return renderText(result);
}
