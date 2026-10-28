#!/usr/bin/env node
/**
 * pre-push-review — what the run log says (see ./run-log.mjs).
 *
 *   node stats.mjs [--days N] [--json]     default: the last 30 days
 *
 * It answers the questions the review setup is judged on: how often each reviewer runs, is
 * skipped or fails; what each one reports, by severity; how many pushes pass, are blocked or go
 * unreviewed; and what a push costs in dollars, time and model calls (median and p95).
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROLE_TITLES } from './roles.mjs';
import { readRuns, runLogPath } from './run-log.mjs';

const SEVERITIES = ['critical', 'high', 'medium', 'low'];
const OUTCOMES = ['passed', 'blocked', 'not-reviewed', 'nothing-to-review', 'skipped'];

/** Numbers sorted; p is 0..1. */
export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

/** Totals over rows of the run log. Only rows where the panel ran reviewers count toward cost, time and calls. */
export function aggregate(rows) {
  const outcomes = Object.fromEntries(OUTCOMES.map((o) => [o, 0]));
  const roles = {};
  const roleStat = (key) => (roles[key] ??= { run: 0, skipped: 0, failed: 0, ...Object.fromEntries(SEVERITIES.map((s) => [s, 0])) });
  const reviewed = rows.filter((r) => r.roles);
  for (const r of rows) {
    outcomes[r.outcome in outcomes ? r.outcome : 'not-reviewed']++;
    if (!r.roles) continue;
    for (const key of r.roles.run ?? []) roleStat(key).run++;
    for (const key of r.roles.skipped ?? []) roleStat(key).skipped++;
    for (const key of r.roles.failed ?? []) roleStat(key).failed++;
    for (const [key, counts] of Object.entries(r.findings ?? {})) {
      for (const s of SEVERITIES) roleStat(key)[s] += counts?.[s] ?? 0;
    }
  }
  const of = (field) => reviewed.map((r) => Number(r[field]) || 0);
  const costs = of('costUsd');
  const times = reviewed.map((r) => Number(r.durationMs) || 0);
  const calls = of('calls');
  // The ticket reviewer's table: how often it ran, what it contradicted and what was confirmed.
  const fits = rows.map((r) => r.ticketFit).filter((f) => f && typeof f === 'object');
  const sum = (pick) => fits.reduce((a, f) => a + (Number(pick(f)) || 0), 0);
  // The verifier: what it was asked, what it refuted (and how much of that would have blocked),
  // and what it adds to a push in time and money.
  const verifiers = rows.map((r) => r.verifier).filter((v) => v && typeof v === 'object');
  const vsum = (field) => verifiers.reduce((a, v) => a + (Number(v[field]) || 0), 0);
  const vtimes = verifiers.map((v) => Number(v.durationMs) || 0);
  return {
    runs: rows.length,
    outcomes,
    roles,
    costUsd: { total: costs.reduce((a, b) => a + b, 0), p50: percentile(costs, 0.5), p95: percentile(costs, 0.95) },
    durationMs: { p50: percentile(times, 0.5), p95: percentile(times, 0.95) },
    calls: { total: calls.reduce((a, b) => a + b, 0), p50: percentile(calls, 0.5), p95: percentile(calls, 0.95) },
    ticketFit: {
      runs: fits.length,
      contradicted: sum((f) => f.rows?.contradicted),
      confirmed: sum((f) => f.confirmed),
      noCriteria: fits.filter((f) => f.noCriteria).length,
    },
    verifier: {
      runs: verifiers.length,
      claims: vsum('claims'),
      confirmed: vsum('confirmed'),
      refuted: vsum('refuted'),
      refutedBlocking: vsum('refutedBlocking') + vsum('ticketRefuted'),
      unverifiable: vsum('unverifiable'),
      unverified: vsum('unverified'),
      failed: verifiers.filter((v) => v.failed).length,
      durationMs: { p50: percentile(vtimes, 0.5), p95: percentile(vtimes, 0.95) },
      costUsd: vsum('costUsd'),
    },
  };
}

const money = (n) => (n == null ? '-' : `$${n.toFixed(2)}`);
const secs = (ms) => (ms == null ? '-' : `${Math.round(ms / 1000)}s`);

/** The human-readable report. */
export function render(days, a) {
  const o = a.outcomes;
  const lines = [
    `pre-push-review, last ${days} day(s): ${a.runs} run(s)`,
    `  outcome   ${o.passed} passed · ${o.blocked} blocked · ${o['not-reviewed']} not reviewed · ${o['nothing-to-review']} nothing to review · ${o.skipped} skipped`,
    `  cost      ${money(a.costUsd.total)} total · p50 ${money(a.costUsd.p50)} · p95 ${money(a.costUsd.p95)} per run`,
    `  time      p50 ${secs(a.durationMs.p50)} · p95 ${secs(a.durationMs.p95)} per run`,
    `  calls     ${a.calls.total} model call(s) · p50 ${a.calls.p50 ?? '-'} · p95 ${a.calls.p95 ?? '-'} per run`,
  ];
  const t = a.ticketFit;
  if (t?.runs) {
    lines.push(`  ticket    ${t.runs} table(s) · ${t.contradicted} contradicted line(s), ${t.confirmed} confirmed · ${t.noCriteria} ticket(s) without acceptance criteria`);
  }
  const v = a.verifier;
  if (v?.runs) {
    lines.push(
      `  verifier  ${v.runs} run(s) · ${v.claims} claim(s): ${v.confirmed} confirmed · ${v.refuted} refuted (${v.refutedBlocking} that would have blocked) · ${v.unverifiable} unverifiable · ${v.unverified} not verified · ${v.failed} failed run(s) · p50 ${secs(v.durationMs.p50)} · p95 ${secs(v.durationMs.p95)} added · ${money(v.costUsd)}`,
    );
  }
  const keys = Object.keys(a.roles);
  if (keys.length) {
    lines.push('', `  ${'role'.padEnd(30)} ${'run'.padStart(5)} ${'skip'.padStart(5)} ${'fail'.padStart(5)} ${'crit'.padStart(5)} ${'high'.padStart(5)} ${'med'.padStart(5)} ${'low'.padStart(5)}`);
    for (const key of keys) {
      const r = a.roles[key];
      const cells = [r.run, r.skipped, r.failed, r.critical, r.high, r.medium, r.low].map((n) => String(n).padStart(5));
      lines.push(`  ${(ROLE_TITLES[key] || key).padEnd(30)} ${cells.join(' ')}`);
    }
  }
  if (!a.runs) lines.push(`  (no runs in ${runLogPath()})`);
  return lines.join('\n');
}

function main(argv) {
  let days = 30;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--days' && argv[i + 1]) days = Number(argv[++i]);
    else if (argv[i] === '--json') json = true;
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('Usage: node stats.mjs [--days N] [--json]');
      return 0;
    }
  }
  if (!Number.isFinite(days) || days <= 0) {
    console.error('[pre-push-review] --days must be a positive number');
    return 2;
  }
  const since = Date.now() - days * 86_400_000;
  const rows = readRuns().filter((r) => Date.parse(r.ts) >= since);
  const a = aggregate(rows);
  console.log(json ? JSON.stringify({ days, ...a }, null, 2) : render(days, a));
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
