#!/usr/bin/env node
// Stage B rendering — requirements-coverage skill. coverage.json -> a readable Markdown report:
// a summary line, the coverage table, and a priority-ordered backlog of what's missing/partial.
// Deterministic (pure). Usage: coverage-report.mjs --coverage <assemble-output.json>  (or stdin)

import { readFileSync } from 'node:fs';

const ICON = { cumple: '✅', parcial: '🟡', falta: '❌' };
const prio = (c) => ({ high: 3, normal: 2, low: 1 }[c.priority] || 2);

export function report({ summary, coverage }) {
  const L = ['# Requirements coverage', ''];
  L.push(`**${summary.cumple}/${summary.total} cumple** · ${summary.parcial} parcial · ${summary.falta} falta · verified-by-execution: ${summary.verified} · analytical: ${summary.analytical}`);
  L.push('', '| id | requirement | verdict | verified | evidence | action |', '|---|---|---|---|---|---|');
  for (const c of coverage) {
    const ev = (c.evidence || []).map((e) => `${e.repo || ''}:${e.path || ''}${e.symbol ? '#' + e.symbol : ''}`).join('; ') || '—';
    const v = c.verified ? `${c.verified.result} \`${c.verified.command}\`` : 'analytical (unverified)';
    const act = (c.actions || []).join('; ') || '—';
    L.push(`| ${c.id} | ${c.requirement} | ${ICON[c.verdict] || ''} ${c.verdict} | ${v} | ${ev} | ${act} |`);
  }
  const backlog = coverage.filter((c) => c.verdict !== 'cumple').sort((a, b) => prio(b) - prio(a));
  if (backlog.length) {
    L.push('', '## Backlog (priorizado)');
    for (const c of backlog) L.push(`- **${c.id}** (${c.verdict}, ${c.priority}) — ${c.requirement} → ${(c.actions || []).join('; ') || 'definir acción'}`);
  }
  return L.join('\n') + '\n';
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const opt = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : null; };
  const data = JSON.parse(readFileSync(opt('--coverage') || 0, 'utf8'));
  process.stdout.write(report(data));
}
