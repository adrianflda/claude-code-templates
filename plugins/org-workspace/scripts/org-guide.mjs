#!/usr/bin/env node
// The org guide: a short, managed block inside the CLAUDE.md at the root of the org folder — the
// file Claude Code already loads in every session under that folder. It records WHERE the truth of
// each thing lives (repos, forbidden repos, sources of truth, who calls whom, conventions, open
// threads); it never copies the content. The full integration map goes to SYSTEM-MAP.md next to it,
// referenced by path (not imported), so it is read only when a task needs it.
//
//   - The block is the only part this tool writes: text outside the markers is never touched.
//   - The block has a size budget (BLOCK_BUDGET bytes, ~1k tokens); a bigger guide is refused.
//   - Every string is single-line, bounded and secret-free; repo names are plain names.
//   - Without --apply it only prints the diff; --apply writes, after a backup of the previous file.
//   - The same validated guide is also written to <org>/.claude/org-workspace/guide.json, the
//     machine copy other tools read (quality-kernel's org mode takes the repo list from it).
//
// Usage: org-guide.mjs --org <dir> --guide guide.json [--integrations integrations.json]
//                      [--date YYYY-MM-DD] [--apply]

import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isEntrypoint } from './entrypoint.mjs';
import { profile } from './org-profile.mjs';
import { redactLine } from './org-integrations.mjs';
import { validateIntegrations, normalize, renderSystemMap } from './org-map.mjs';

export const BEGIN = '<!-- org-workspace:begin — managed by /org-init and /org-learn; edit with them (or by hand, inside these markers) -->';
export const END = '<!-- org-workspace:end -->';
export const BLOCK_BUDGET = 4096;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
export const isRepoName = (n) => typeof n === 'string' && NAME.test(n) && n !== '.' && n !== '..';
const ROLES = ['app', 'harness', 'library', 'docs', 'other'];
const MAX_TEXT = 200;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const KEYS = { repos: ['name', 'role', 'base', 'harnessOf', 'note'], truth: ['topic', 'where', 'note'], conventions: ['rule', 'source'], threads: ['text', 'source'] };
const MARKER_TEXT = /org-workspace:(begin|end)/;

// The forbidden repos recorded in the guide block of <org>/CLAUDE.md (empty when there is none).
export function readGuideForbidden(org) {
  const p = join(org, 'CLAUDE.md');
  if (!existsSync(p) || lstatSync(p).isSymbolicLink()) return [];
  const s = readFileSync(p, 'utf8');
  const i = s.indexOf(BEGIN); const j = s.indexOf(END);
  if (i === -1 || j < i) return [];
  const m = /^- Forbidden \(never open, run or write\): (.+)$/m.exec(s.slice(i, j));
  return m ? m[1].split(',').map((x) => x.trim().replace(/^`|`$/g, '')).filter(isRepoName) : [];
}

export function validateGuide(g) {
  const errs = [];
  if (!g || typeof g !== 'object' || Array.isArray(g)) return ['guide must be an object'];
  for (const k of Object.keys(g)) if (!['org', 'repos', 'forbidden', 'truth', 'conventions', 'threads'].includes(k)) errs.push(`unknown key "${k}"`);
  const text = (v, name, optional = false) => {
    if (v === undefined && optional) return;
    if (typeof v !== 'string' || !v.trim() || v.length > MAX_TEXT || CONTROL.test(v)) errs.push(`${name} must be a single-line string of 1..${MAX_TEXT} characters`);
    else if (redactLine(v) !== v.slice(0, 400)) errs.push(`${name} contains a secret-looking value`);
    else if (MARKER_TEXT.test(v)) errs.push(`${name} must not contain the block markers`);
  };
  text(g.org, 'org');
  const list = (k) => {
    const v = g[k] ?? [];
    if (!Array.isArray(v)) { errs.push(`${k} must be an array`); return []; }
    return v;
  };
  const names = new Set();
  list('repos').forEach((r, i) => {
    const at = `repos[${i}]`;
    if (!r || typeof r !== 'object') return errs.push(`${at} must be an object`);
    for (const k of Object.keys(r)) if (!KEYS.repos.includes(k)) errs.push(`${at}: unknown key "${k}"`);
    if (!isRepoName(r.name)) errs.push(`${at}: invalid repo name`);
    else if (names.has(r.name)) errs.push(`${at}: duplicate repo ${r.name}`); else names.add(r.name);
    if (!ROLES.includes(r.role)) errs.push(`${at}: role must be one of ${ROLES.join('/')}`);
    text(r.base, `${at}.base`);
    if (r.harnessOf !== undefined && !isRepoName(r.harnessOf)) errs.push(`${at}: harnessOf must be a repo name`);
    text(r.note, `${at}.note`, true);
  });
  const forbidden = list('forbidden');
  forbidden.forEach((n, i) => { if (!isRepoName(n)) errs.push(`forbidden[${i}] must be a repo name`); else if (names.has(n)) errs.push(`forbidden[${i}]: ${n} is also listed in repos`); });
  for (const k of ['truth', 'conventions', 'threads']) {
    list(k).forEach((x, i) => {
      const at = `${k}[${i}]`;
      if (!x || typeof x !== 'object') return errs.push(`${at} must be an object`);
      for (const kk of Object.keys(x)) if (!KEYS[k].includes(kk)) errs.push(`${at}: unknown key "${kk}"`);
      for (const kk of KEYS[k]) text(x[kk], `${at}.${kk}`, kk === 'note');
    });
  }
  if ((g.threads || []).length > 12) errs.push('threads: at most 12 — the guide is a compass, not a backlog');
  return errs;
}

const esc = (s) => String(s).replace(/\|/g, '\\|').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const code = (s) => `\`${String(s).replace(/`/g, "'")}\``;

// pairs: [{ from, to, n }] from the integration map (optional).
export function renderBlock(g, { date, pairs = null, mapFile = 'SYSTEM-MAP.md' } = {}) {
  const L = [BEGIN, `## Org guide — ${esc(g.org)} (updated ${date})`, '',
    'Where the truth of each thing lives in this organisation. Follow a pointer only when the task needs it.', ''];
  const repos = g.repos || [];
  if (repos.length) {
    L.push('### Repos', '', '| Repo | Role | Base | Note |', '|---|---|---|---|');
    for (const r of repos) L.push(`| ${code(r.name)} | ${r.role}${r.harnessOf ? ` of ${code(r.harnessOf)}` : ''} | ${code(r.base)} | ${r.note ? esc(r.note) : ''} |`);
    L.push('');
  }
  if ((g.forbidden || []).length) L.push(`- Forbidden (never open, run or write): ${g.forbidden.map(code).join(', ')}`, '');
  if ((g.truth || []).length) {
    L.push('### Where the truth lives', '');
    for (const t of g.truth) L.push(`- **${esc(t.topic)}** → ${esc(t.where)}${t.note ? ` — ${esc(t.note)}` : ''}`);
    L.push('');
  }
  if (pairs && pairs.length) {
    L.push(`### Who calls whom (full map with file:line citations: \`${mapFile}\` — read only the section you need)`, '');
    for (const p of pairs) L.push(`- ${code(p.from)} → ${code(p.to)}: ${p.n}`);
    L.push('');
  }
  if ((g.conventions || []).length) {
    L.push('### Cross-repo conventions', '');
    for (const c of g.conventions) L.push(`- ${esc(c.rule)} (${esc(c.source)})`);
    L.push('');
  }
  if ((g.threads || []).length) {
    L.push('### Open threads', '');
    for (const t of g.threads) L.push(`- ${esc(t.text)} (${esc(t.source)})`);
    L.push('');
  }
  L.push(END);
  return L.join('\n');
}

// The CLAUDE.md with the block replaced (or appended); refuses ambiguous markers.
export function spliceBlock(current, block) {
  const count = (m) => current.split(m).length - 1;
  if (count(BEGIN) > 1 || count(END) > 1 || count(BEGIN) !== count(END)) throw new Error('CLAUDE.md has unbalanced or repeated org-workspace markers — fix them by hand first');
  if (!current.includes(BEGIN)) return `${current}${current && !current.endsWith('\n') ? '\n' : ''}${current ? '\n' : ''}${block}\n`;
  const i = current.indexOf(BEGIN); const j = current.indexOf(END) + END.length;
  if (j < i) throw new Error('CLAUDE.md has the org-workspace end marker before the begin marker');
  return current.slice(0, i) + block + current.slice(j);
}

export function buildGuide({ org, guide, integrations = null, date }) {
  if (!org || !existsSync(org)) throw new Error(`org folder not found: ${org}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('date must be YYYY-MM-DD');
  const problems = validateGuide(guide);
  let map = null, pairs = null;
  if (integrations !== null) {
    // Every repo named by the map must be one of the guide's repos; each is profiled at its base.
    const repos = {};
    for (const r of guide.repos || []) {
      if (!isRepoName(r.name)) continue;
      const dir = join(org, r.name);
      try { const p = profile({ dir, base: r.base }); repos[r.name] = { dir, sha: p.sha, base: p.base }; } catch { /* not a profilable repo: not citable */ }
    }
    const { errors, checks } = validateIntegrations(integrations, { repos });
    problems.push(...errors.map((m) => `integrations: ${m}`));
    if (!errors.length) {
      map = { repos: Object.fromEntries(Object.entries(repos).map(([n, r]) => [n, { base: r.base, sha: r.sha }])), ...normalize(integrations, checks) };
      const count = new Map();
      for (const e of map.edges) { const k = `${e.from}\0${e.to}`; count.set(k, (count.get(k) || 0) + 1); }
      pairs = [...count].map(([k, n]) => { const [from, to] = k.split('\0'); return { from, to, n }; });
    }
  }
  if (problems.length) throw new Error(`invalid guide:\n- ${problems.join('\n- ')}`);
  // Without a new map, keep the last one's summary (an /org-learn update must not drop it).
  const summaryPath = join(org, '.claude', 'org-workspace', 'map-summary.json');
  if (pairs === null && existsSync(summaryPath) && !lstatSync(summaryPath).isSymbolicLink()) {
    try {
      const prev = JSON.parse(readFileSync(summaryPath, 'utf8'));
      if (Array.isArray(prev) && prev.every((p) => p && isRepoName(p.from) && isRepoName(p.to) && Number.isInteger(p.n))) pairs = prev;
    } catch { /* an unreadable summary is dropped; re-run with --integrations to restore it */ }
  }
  const block = renderBlock(guide, { date, pairs });
  if (Buffer.byteLength(block) > BLOCK_BUDGET) throw new Error(`the guide block is ${Buffer.byteLength(block)} bytes; the budget is ${BLOCK_BUDGET} (~1k tokens) — shorten it: point to sources, do not copy them`);
  const claudePath = join(org, 'CLAUDE.md');
  if (existsSync(claudePath) && lstatSync(claudePath).isSymbolicLink()) throw new Error(`${claudePath} is a symlink — refusing to write through it`);
  const current = existsSync(claudePath) ? readFileSync(claudePath, 'utf8') : '';
  return { claudePath, current, next: spliceBlock(current, block), block, guide, pairs: map ? pairs : null, summaryPath, map: map ? renderSystemMap({ date, branch: '(org folder, not versioned)', ...map }) : null, mapPath: join(org, 'SYSTEM-MAP.md') };
}

function diff(a, b, label) {
  const tmp = mkdtempSync(join(tmpdir(), 'org-guide-'));
  try {
    writeFileSync(join(tmp, 'a'), a); writeFileSync(join(tmp, 'b'), b);
    return spawnSync('diff', ['-u', '--label', `${label} (now)`, '--label', `${label} (proposed)`, join(tmp, 'a'), join(tmp, 'b')], { encoding: 'utf8' }).stdout;
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

export function applyGuide(built, { org, stamp = new Date().toISOString().replace(/[:.]/g, '-') } = {}) {
  const backups = join(org, '.claude', 'org-workspace', 'backups');
  mkdirSync(backups, { recursive: true });
  if (built.current) writeFileSync(join(backups, `CLAUDE.md.${stamp}`), built.current);
  writeFileSync(built.claudePath, built.next);
  const guidePath = join(org, '.claude', 'org-workspace', 'guide.json');
  if (existsSync(guidePath) && lstatSync(guidePath).isSymbolicLink()) throw new Error(`${guidePath} is a symlink — refusing to write through it`);
  writeFileSync(guidePath, JSON.stringify(built.guide, null, 2) + '\n');
  if (built.pairs) {
    if (existsSync(built.summaryPath) && lstatSync(built.summaryPath).isSymbolicLink()) throw new Error(`${built.summaryPath} is a symlink — refusing to write through it`);
    writeFileSync(built.summaryPath, JSON.stringify(built.pairs, null, 2) + '\n');
  }
  if (built.map) {
    if (existsSync(built.mapPath) && lstatSync(built.mapPath).isSymbolicLink()) throw new Error(`${built.mapPath} is a symlink — refusing to write through it`);
    if (existsSync(built.mapPath)) writeFileSync(join(backups, `SYSTEM-MAP.md.${stamp}`), readFileSync(built.mapPath));
    writeFileSync(built.mapPath, built.map);
  }
}

if (isEntrypoint(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n) => { const i = args.indexOf(n); return i === -1 ? undefined : args[i + 1]; };
  try {
    const org = opt('--org');
    const guide = JSON.parse(readFileSync(opt('--guide'), 'utf8'));
    const integrations = opt('--integrations') ? JSON.parse(readFileSync(opt('--integrations'), 'utf8')) : null;
    const built = buildGuide({ org, guide, integrations, date: opt('--date') || new Date().toISOString().slice(0, 10) });
    const changes = [diff(built.current, built.next, 'CLAUDE.md')];
    if (built.map) changes.push(diff(existsSync(built.mapPath) ? readFileSync(built.mapPath, 'utf8') : '', built.map, 'SYSTEM-MAP.md').split('\n').slice(0, 12).join('\n') + '\n... (SYSTEM-MAP.md diff truncated)\n');
    if (args.includes('--apply')) { applyGuide(built, { org }); process.stdout.write(`written: ${built.claudePath}${built.map ? `, ${built.mapPath}` : ''} (block ${Buffer.byteLength(built.block)} bytes)\n`); }
    else process.stdout.write(`${changes.join('\n')}\nblock: ${Buffer.byteLength(built.block)} / ${BLOCK_BUDGET} bytes. Nothing written — re-run with --apply after the user approves.\n`);
  } catch (e) { process.stderr.write(`${e.message}\n`); process.exit(2); }
}
