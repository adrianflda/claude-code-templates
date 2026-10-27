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
import { isMain } from './entrypoint.mjs';
import { profile } from './org-profile.mjs';
import { hasSecret } from './org-integrations.mjs';
import { validateIntegrations, normalize, renderSystemMap } from './org-map.mjs';
import { isRepoName, isBoundedSingleLineText, TEXT_MAX_LENGTH } from './org-policy.mjs';

// OG-1/OG-6: this block is GENERATED output — every apply re-renders it fresh from guide.json and
// overwrites whatever currently sits between the markers, including a hand edit. The marker text says
// so, and tells the reader /org-learn is the way to make a change stick.
export const BEGIN = '<!-- org-workspace:begin — generated from guide.json by /org-init and /org-learn; this block is OVERWRITTEN on every apply, so make changes through /org-learn, not by editing it directly -->';
export const END = '<!-- org-workspace:end -->';
export const BLOCK_BUDGET = 4096;
// OG-10: isRepoName and the per-field text rule are shared with org-map.mjs via org-policy.mjs
// (the budget there is unified at 300 — org-map.mjs's existing limit, the larger of the two, so
// widening is non-breaking: no text the live guide/map already carries becomes invalid).
// Re-exported here so existing importers of isRepoName from this module keep working unchanged.
export { isRepoName };
const ROLES = ['app', 'harness', 'library', 'docs', 'other'];
const KEYS = { repos: ['name', 'role', 'base', 'harnessOf', 'note'], truth: ['topic', 'where', 'note'], conventions: ['rule', 'source'], threads: ['text', 'source'] };
const MARKER_TEXT = /org-workspace:(begin|end)/;

// OG-1/OG-2/OG-3: `guide.json` is the sole authoritative record of the guide — the rendered CLAUDE.md
// block is a derived view, never parsed back. Absent guide.json (no /org-init has ever run) returns
// `null` (a normal case, not an error); a guide.json that exists but cannot be trusted (a symlink
// anywhere on its path, invalid JSON, or the wrong shape) fails closed instead. Shared by
// readGuideForbidden and buildGuide's OG-4 who-calls-whom carry-forward — the same read, same rules.
function readGuideFileRaw(org) {
  let p = org;
  for (const part of ['.claude', 'org-workspace', 'guide.json']) {
    p = join(p, part);
    let st;
    try { st = lstatSync(p); } catch { return null; } // nothing written yet at this point: not an error
    if (st.isSymbolicLink()) throw new Error(`${p} is a symlink — refusing to read through it`);
  }
  let raw;
  try { raw = readFileSync(p, 'utf8'); } catch (e) { throw new Error(`cannot read ${p}: ${e.message}`); }
  let g;
  try { g = JSON.parse(raw); } catch (e) { throw new Error(`${p} is not valid JSON: ${e.message}`); }
  if (!g || typeof g !== 'object' || Array.isArray(g)) throw new Error(`${p} has an unexpected shape (expected an object)`);
  return g;
}

export function readGuideForbidden(org) {
  const g = readGuideFileRaw(org);
  if (g === null) return [];
  if (g.forbidden !== undefined && !Array.isArray(g.forbidden)) throw new Error('guide.json: "forbidden" must be an array');
  return (g.forbidden || []).filter(isRepoName);
}

// OG-7/OG-4: `version` and `summary` (the who-calls-whom carry-forward, OG-4) are tool-stamped fields
// written back into the same guide.json a human/agent may hand the tool again as the next --guide
// input (e.g. a straight re-apply) — optional on the way in, not required, but well-formed when
// present. OG-1: there is deliberately NO render-hash/hand-edit-detection field in this schema.
const KNOWN_TOP_KEYS = ['org', 'repos', 'forbidden', 'truth', 'conventions', 'threads', 'version', 'summary'];
const validSummary = (s) => Array.isArray(s) && s.every((p) => p && isRepoName(p.from) && isRepoName(p.to) && Number.isInteger(p.n) && p.n >= 0);
export function validateGuide(g) {
  const errs = [];
  if (!g || typeof g !== 'object' || Array.isArray(g)) return ['guide must be an object'];
  for (const k of Object.keys(g)) if (!KNOWN_TOP_KEYS.includes(k)) errs.push(`unknown key "${k}"`);
  if (g.version !== undefined && g.version !== 1) errs.push(`version must be 1 (got ${JSON.stringify(g.version)})`);
  if (g.summary !== undefined && !validSummary(g.summary)) errs.push('summary must be an array of {from, to, n} (n a non-negative integer)');
  const text = (v, name, optional = false) => {
    if (v === undefined && optional) return;
    if (!isBoundedSingleLineText(v)) errs.push(`${name} must be a single-line string of 1..${TEXT_MAX_LENGTH} characters`);
    else if (hasSecret(v)) errs.push(`${name} contains a secret-looking value`);
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
  // j === i means the END sits immediately before the BEGIN with nothing in between — a stray END,
  // not a valid closed block before this one; left unchecked it keeps the stray END (prefix) AND
  // inserts the new block (which itself contains a BEGIN), producing two BEGIN markers (F15).
  if (j <= i) throw new Error('CLAUDE.md has the org-workspace end marker before the begin marker');
  return current.slice(0, i) + block + current.slice(j);
}

// OG-4: the who-calls-whom summary carried forward from guide.json's OWN `summary` field — the same
// symlink/parse refusal as any other read of guide.json (OG-2). Returns `undefined` when no /org-init
// or /org-learn has ever recorded a `summary` field at all (the caller then falls back to the legacy
// file); `null` when the field is present but malformed (a warning is printed, the legacy file is
// never consulted in that case — a recorded-but-bad summary does not resurrect an older one); the
// carried array otherwise.
function carriedSummaryFromGuideFile(org) {
  const onDisk = readGuideFileRaw(org); // throws on symlink/corrupt — fails the whole build (OG-2)
  if (!onDisk || !Object.prototype.hasOwnProperty.call(onDisk, 'summary')) return undefined;
  if (validSummary(onDisk.summary)) return onDisk.summary;
  process.stderr.write('warning: guide.json\'s "summary" field is not shaped as {from,to,n}[] — no "Who calls whom" section this run (re-run with --integrations to rebuild it)\n');
  return null;
}

// OG-4: the one-time fold-in of the legacy map-summary.json, consulted only while guide.json has never
// recorded a `summary` field (carriedSummaryFromGuideFile returned `undefined`). From the next apply
// on, guide.json's own field is authoritative and this file is never read again.
function carriedSummaryFromLegacyFile(org) {
  const legacyPath = join(org, '.claude', 'org-workspace', 'map-summary.json');
  let legacySt;
  try { legacySt = lstatSync(legacyPath); } catch { legacySt = null; }
  if (!legacySt) return null;
  if (legacySt.isSymbolicLink()) throw new Error(`${legacyPath} is a symlink — refusing to read through it`);
  try {
    const legacy = JSON.parse(readFileSync(legacyPath, 'utf8'));
    if (validSummary(legacy)) return legacy; // one-time fold-in; from now on guide.json.summary is authoritative
    process.stderr.write('warning: legacy map-summary.json is not shaped as {from,to,n}[] — not folded in; no "Who calls whom" section this run\n');
    return null;
  } catch (e) {
    process.stderr.write(`warning: legacy map-summary.json could not be parsed (${e.message}) — not folded in; no "Who calls whom" section this run\n`);
    return null;
  }
}

// buildGuide's steps, in the order it runs them. Each one owns one concern, so the orchestrator below
// reads as the sequence of checks the contract requires (inputs, guide, map, summary, block, target).

function assertBuildInputs(org, date) {
  if (!org || !existsSync(org)) throw new Error(`org folder not found: ${org}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('date must be YYYY-MM-DD');
}

// Every repo named by the map must be one of the guide's repos; each is profiled at its base.
// OG-15/F18: a repo that cannot be profiled is recorded (name + the actual error), not silently
// dropped from `repos` — a later "X is not a selected repo" error used to hide why.
function profileGuideRepos(org, guide) {
  const repos = {};
  const profilingProblems = [];
  for (const r of guide.repos || []) {
    if (!isRepoName(r.name)) continue;
    const dir = join(org, r.name);
    try { const p = profile({ dir, base: r.base }); repos[r.name] = { dir, sha: p.sha, base: p.base }; }
    catch (e) { profilingProblems.push({ repo: r.name, error: e.message }); }
  }
  return { repos, profilingProblems };
}

// The who-calls-whom summary of a map: one { from, to, n } per caller/provider pair, n = its edge
// count, pairs in order of first appearance.
export function summarizeEdges(edges) {
  const count = new Map();
  for (const e of edges) { const k = `${e.from}\0${e.to}`; count.set(k, (count.get(k) || 0) + 1); }
  return [...count].map(([k, n]) => { const [from, to] = k.split('\0'); return { from, to, n }; });
}

const noIntegrationMap = () => ({ errors: [], map: null, pairs: null, profilingProblems: [] });

// The integration map step: profile the guide's repos, validate the proposed map against them, and,
// when it is valid, normalize it and summarize its edges. `errors` are reported, not thrown, so the
// caller can list them together with the guide's own problems.
function buildIntegrationMap(org, guide, integrations) {
  const { repos, profilingProblems } = profileGuideRepos(org, guide);
  // OG-10/F3: the map path is checked against the SAME secret rule as the guide path (hasSecret),
  // not just hasValueSecret's narrower, quoted-value-only subset.
  const { errors, checks } = validateIntegrations(integrations, { repos, secretIn: hasSecret });
  if (errors.length) return { errors, map: null, pairs: null, profilingProblems };
  const map = { repos: Object.fromEntries(Object.entries(repos).map(([n, r]) => [n, { base: r.base, sha: r.sha }])), ...normalize(integrations, checks) };
  return { errors, map, pairs: summarizeEdges(map.edges), profilingProblems };
}

// OG-4: without a new map, the who-calls-whom summary is carried forward — first from guide.json's
// own `summary` field (carriedSummaryFromGuideFile), and only when that field has never been
// recorded at all, from the legacy map-summary.json (carriedSummaryFromLegacyFile), folded in
// exactly once.
function carriedSummary(org) {
  const fromGuide = carriedSummaryFromGuideFile(org);
  return fromGuide !== undefined ? fromGuide : carriedSummaryFromLegacyFile(org);
}

function renderBudgetedBlock(guide, { date, pairs }) {
  const block = renderBlock(guide, { date, pairs });
  if (Buffer.byteLength(block) > BLOCK_BUDGET) throw new Error(`the guide block is ${Buffer.byteLength(block)} bytes; the budget is ${BLOCK_BUDGET} (~1k tokens) — shorten it: point to sources, do not copy them`);
  return block;
}

// The current <org>/CLAUDE.md ('' when absent); refuses to go through a symlink.
function readClaudeMd(org) {
  const claudePath = join(org, 'CLAUDE.md');
  if (existsSync(claudePath) && lstatSync(claudePath).isSymbolicLink()) throw new Error(`${claudePath} is a symlink — refusing to write through it`);
  return { claudePath, current: existsSync(claudePath) ? readFileSync(claudePath, 'utf8') : '' };
}

// OG-7: every persisted guide.json carries "version": 1, whether or not the proposal supplied one.
// OG-4: `summary` is stamped from the computed `pairs` (fresh, carried-forward, or folded-in from
// the legacy file) — never whatever stray value the input proposal happened to carry — and is
// omitted entirely when there is nothing to record (no map has ever run for this guide).
export function stampGuide(guide, pairs) {
  const stamped = { ...guide, version: 1 };
  if (pairs !== null) stamped.summary = pairs; else delete stamped.summary;
  return stamped;
}

export function buildGuide({ org, guide, integrations = null, date }) {
  assertBuildInputs(org, date);
  const problems = validateGuide(guide);
  const integration = integrations === null ? noIntegrationMap() : buildIntegrationMap(org, guide, integrations);
  problems.push(...integration.errors.map((m) => `integrations: ${m}`));
  if (problems.length) throw new Error(`invalid guide:\n- ${problems.join('\n- ')}`);
  const { map, profilingProblems } = integration;
  const pairs = integration.pairs !== null ? integration.pairs : carriedSummary(org);
  const block = renderBudgetedBlock(guide, { date, pairs });
  const { claudePath, current } = readClaudeMd(org);
  return { claudePath, current, next: spliceBlock(current, block), block, guide: stampGuide(guide, pairs), map: map ? renderSystemMap({ date, branch: '(org folder, not versioned)', ...map }) : null, mapPath: join(org, 'SYSTEM-MAP.md'), profilingProblems };
}

function diff(a, b, label) {
  const tmp = mkdtempSync(join(tmpdir(), 'org-guide-'));
  try {
    writeFileSync(join(tmp, 'a'), a); writeFileSync(join(tmp, 'b'), b);
    return spawnSync('diff', ['-u', '--label', `${label} (now)`, '--label', `${label} (proposed)`, join(tmp, 'a'), join(tmp, 'b')], { encoding: 'utf8' }).stdout;
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

// OG-12/F5/F7/F10: EVERY write-target precondition is checked before writing ANY of them — CLAUDE.md
// is no longer written first and left standing when a later check (guide.json's, SYSTEM-MAP.md's)
// throws. (CLAUDE.md's own symlink-ness was already checked in buildGuide, before `built` existed.)
function assertWriteTargetsAreSafe(built, guidePath) {
  if (existsSync(guidePath) && lstatSync(guidePath).isSymbolicLink()) throw new Error(`${guidePath} is a symlink — refusing to write through it`);
  if (built.map && existsSync(built.mapPath) && lstatSync(built.mapPath).isSymbolicLink()) throw new Error(`${built.mapPath} is a symlink — refusing to write through it`);
}

export function applyGuide(built, { org, stamp = new Date().toISOString().replace(/[:.]/g, '-') } = {}) {
  const guidePath = join(org, '.claude', 'org-workspace', 'guide.json');
  assertWriteTargetsAreSafe(built, guidePath);
  const backups = join(org, '.claude', 'org-workspace', 'backups');
  mkdirSync(backups, { recursive: true });
  if (built.current) writeFileSync(join(backups, `CLAUDE.md.${stamp}`), built.current);
  writeFileSync(built.claudePath, built.next);
  writeFileSync(guidePath, JSON.stringify(built.guide, null, 2) + '\n');
  // OG-4: map-summary.json is retired — guide.json's own "summary" field is the only store, written
  // above as part of built.guide. Nothing else is written for it, not even transitionally.
  if (built.map) {
    if (existsSync(built.mapPath)) writeFileSync(join(backups, `SYSTEM-MAP.md.${stamp}`), readFileSync(built.mapPath));
    writeFileSync(built.mapPath, built.map);
  }
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n) => { const i = args.indexOf(n); return i === -1 ? undefined : args[i + 1]; };
  try {
    const org = opt('--org');
    const guide = JSON.parse(readFileSync(opt('--guide'), 'utf8'));
    const integrations = opt('--integrations') ? JSON.parse(readFileSync(opt('--integrations'), 'utf8')) : null;
    const built = buildGuide({ org, guide, integrations, date: opt('--date') || new Date().toISOString().slice(0, 10) });
    // OG-15: a repo that could not be profiled is reported, not silently dropped.
    for (const p of built.profilingProblems) process.stderr.write(`warning: "${p.repo}" could not be profiled and is not in the integration map: ${p.error}\n`);
    const changes = [diff(built.current, built.next, 'CLAUDE.md')];
    if (built.map) changes.push(diff(existsSync(built.mapPath) ? readFileSync(built.mapPath, 'utf8') : '', built.map, 'SYSTEM-MAP.md').split('\n').slice(0, 12).join('\n') + '\n... (SYSTEM-MAP.md diff truncated)\n');
    if (args.includes('--apply')) { applyGuide(built, { org }); process.stdout.write(`written: ${built.claudePath}${built.map ? `, ${built.mapPath}` : ''} (block ${Buffer.byteLength(built.block)} bytes)\n`); }
    else process.stdout.write(`${changes.join('\n')}\nblock: ${Buffer.byteLength(built.block)} / ${BLOCK_BUDGET} bytes. Nothing written — re-run with --apply after the user approves.\n`);
  } catch (e) { process.stderr.write(`${e.message}\n`); process.exit(2); }
}
