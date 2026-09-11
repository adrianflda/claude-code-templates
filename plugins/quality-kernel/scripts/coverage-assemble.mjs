#!/usr/bin/env node
// Stage B (assemble + hybrid verify) — requirements-coverage skill.
// Takes the canonical requirements + the coverage analysts' per-requirement results, and for each
// result that carries a runnable `check`, VERIFIES BY EXECUTION (constitution P2) — read-only: the
// analyzed repo is hashed before and after the check and must be byte-identical (COV-5). Assembles the
// per-requirement coverage.json + a summary, and flags any structural / consistency problem.
//
// Inputs: --requirements <canonical.json> --results <results.json>
//   results: [{ id, verdict:"cumple"|"parcial"|"falta", confidence?, evidence?:[{repo,path,symbol}],
//               check?:{command, cwd?}, actions?:[] }]
// Exit: 0 = assembled clean · 1 = structural/consistency problem or a read-only violation.

import { readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const VERDICTS = new Set(['cumple', 'parcial', 'falta']);

export function hashDir(root) {
  if (!root) return null;
  const skip = new Set(['.git', 'node_modules', '.venv', 'coverage', 'dist']);
  const parts = [];
  const walk = (d, rel) => {
    let ents; try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
      if (skip.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name, abs = join(d, e.name);
      // Symlinks are hashed by their TARGET, not followed. Skipping them entirely (as before) left a
      // hole in the read-only proof: a check could create or repoint a symlink and the before/after
      // hashes still matched, so the write violation went unreported.
      if (e.isSymbolicLink()) { try { parts.push(`${r}:symlink:${readlinkSync(abs)}`); } catch { parts.push(`${r}:symlink:<unreadable>`); } continue; }
      if (e.isDirectory()) walk(abs, r);
      else if (e.isFile()) { try { parts.push(`${r}:${createHash('sha256').update(readFileSync(abs)).digest('hex')}`); } catch { /* skip */ } }
    }
  };
  walk(root, '');
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}
const defaultRun = (command, cwd) => {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; // a check may itself be `node --test`
  return spawnSync(command, { cwd: cwd || undefined, shell: true, encoding: 'utf8', timeout: 300000, env });
};
const base = (req) => ({ id: req.id, requirement: req.text, sources: req.sources || [], category: req.category || 'general', priority: req.priority || 'normal' });

export function assemble(requirements, results, { run = defaultRun } = {}) {
  const byId = new Map(results.map((r) => [r.id, r]));
  const coverage = []; const problems = [];
  for (const req of requirements) {
    const r = byId.get(req.id);
    if (!r) { problems.push(`no coverage result for ${req.id}`); coverage.push({ ...base(req), verdict: 'falta', confidence: null, evidence: [], verified: null, actions: ['sin análisis de cobertura'] }); continue; }
    if (!VERDICTS.has(r.verdict)) problems.push(`invalid verdict "${r.verdict}" for ${req.id}`);
    let verified = null;
    if (r.check && r.check.command) {
      const cwd = r.check.cwd || null;
      const before = hashDir(cwd);
      const res = run(r.check.command, cwd);
      const after = hashDir(cwd);
      const readOnly = before === after;
      verified = { method: 'execution', command: r.check.command, exit: res.status, result: res.status === 0 ? 'pass' : 'fail', readOnly };
      if (!readOnly) problems.push(`${req.id} check WROTE to the analyzed repo (read-only violation)`);
    }
    if (r.verdict === 'cumple' && verified && verified.result !== 'pass') problems.push(`${req.id} verdict "cumple" but its check failed — contradiction`);
    coverage.push({ ...base(req), verdict: VERDICTS.has(r.verdict) ? r.verdict : 'falta', confidence: r.confidence ?? null, evidence: r.evidence || [], verified, actions: r.actions || [] });
  }
  const summary = coverage.reduce((s, c) => { s.total++; s[c.verdict]++; c.verified ? s.verified++ : s.analytical++; return s; },
    { total: 0, cumple: 0, parcial: 0, falta: 0, verified: 0, analytical: 0 });
  return { summary, problems, coverage };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const opt = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : null; };
  const reqs = JSON.parse(readFileSync(opt('--requirements'), 'utf8'));
  const results = JSON.parse(readFileSync(opt('--results'), 'utf8'));
  const out = assemble(reqs, results);
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  process.exit(out.problems.length ? 1 : 0);
}
