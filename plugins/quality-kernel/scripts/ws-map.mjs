// /init-workspace phase 2 output — the integration map (M2, report only: no seams, nothing executed).
//
// The integration-mapper agent matches the signals of ws-integrations.mjs across the selected repos
// and returns { edges, unmatched }. This module validates that JSON deterministically and renders
// SYSTEM-MAP.md from it (never the agent's prose):
//   - every repo named is one of the selected, profiled repos, and an edge joins two different repos;
//   - every cited `path:line` is a NON-BLANK line of a committed, non-sensitive file of the repo it
//     belongs to (the caller side in `from`, the served side in `to`) — otherwise the map is refused;
//   - each side is then labelled: `matches` when the cited line contains a token of the endpoint
//     (e.g. `spaces` for `GET /spaces/`), `exists` when it does not (an indirect citation such as a
//     Django `include('')`, a DRF `@action`, a call through a variable). What the check proves is
//     stated in the report: a line that exists is not proof that it is the right line;
//   - kinds, confidence and guardable come from fixed lists; strings are single-line, bounded and
//     secret-free; `file:line` references inside free text lose their line number (only evidence
//     citations are checked, so nothing else may look checked).
// Spec: docs/agentic-harness/spec-init-workspace.v1.md §4 phase 2, §8 (guardable seam types).

import { readVerifiedBlob } from './safe-git.mjs';
import { isSensitive } from './ws-profile.mjs';
import { hasValueSecret } from './ws-integrations.mjs';

export const KINDS = ['http', 'ws', 'webhook', 'queue', 'shared-db', 'doc'];
const CONFIDENCE = ['high', 'medium', 'low'];
const GUARDABLE = ['fields', 'route-exists'];
const EDGE_KEYS = new Set(['from', 'to', 'kind', 'endpoint', 'evidence', 'confidence', 'guardable', 'note']);
const UNMATCHED_KEYS = new Set(['from', 'endpoint', 'evidence', 'reason']);
const MAX_EDGES = 500;
const MAX_TEXT = 300;
const AT = /^([A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+ -]+)*):([1-9][0-9]{0,6})$/;
// C0/C1 controls and bidi overrides (a U+202E can make a rendered path read differently).
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
// A `file.ext:12` reference in free text would read like a checked citation: its line number is
// stripped (`views.py:497` -> `views.py`), deterministically, when the map is normalized.
const PATH_LINE = /([A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,6}):\d+(?:-\d+)?/g;
const unciteText = (v) => (typeof v === 'string' ? v.replace(PATH_LINE, '$1') : v);
const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'any', 'head', 'options']);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// The endpoint's distinctive tokens: `GET /v1/events/get/{eventId}` -> events, get, eventid.
const endpointTokens = (endpoint) => [...new Set(String(endpoint).toLowerCase().split(/[^a-z0-9_-]+/))]
  .filter((t) => t.length >= 3 && !METHODS.has(t) && !/^v\d+$/.test(t));
// Free text an agent wrote: the shared secret scan, plus quoted values next to key/token/secret
// names, Bearer tokens and long high-entropy literals (a header NAME such as X-Api-Key is fine).
const textHasSecret = (v, secretIn) => secretIn(v) || hasValueSecret(v);

// repos: name -> { dir, sha } (the selected repos at the commit they were profiled at).
// Returns { errors, checks } — checks: one { from, to } per edge, each 'matches' | 'exists'.
export function validateIntegrations(integrations, { repos, secretIn = () => false } = {}) {
  const errs = [];
  const fail = (list) => ({ errors: list, checks: [] });
  if (!integrations || typeof integrations !== 'object' || Array.isArray(integrations)) return fail(['integrations must be an object { edges, unmatched }']);
  const extra = Object.keys(integrations).filter((k) => k !== 'edges' && k !== 'unmatched');
  if (extra.length) errs.push(`integrations: unknown key(s) ${extra.join(', ')}`);
  const { edges = [], unmatched = [] } = integrations;
  if (!Array.isArray(edges) || !Array.isArray(unmatched)) return fail([...errs, 'integrations.edges and .unmatched must be arrays']);
  if (edges.length > MAX_EDGES || unmatched.length > MAX_EDGES) errs.push(`at most ${MAX_EDGES} edges and ${MAX_EDGES} unmatched entries`);
  const blobs = new Map(); // `${repo}\0${path}` -> array of lines | null (absent / unreadable / sensitive)
  const fileLines = (repo, path) => {
    const k = `${repo}\0${path}`;
    if (!blobs.has(k)) {
      const r = isSensitive(path) ? { absent: true } : readVerifiedBlob(repos[repo].dir, repos[repo].sha, path);
      const t = typeof r.text === 'string' ? r.text : null;
      // an empty file has 0 lines; a final newline does not start another line
      blobs.set(k, t === null ? null : t === '' ? [] : (t.endsWith('\n') ? t.slice(0, -1) : t).split('\n'));
    }
    return blobs.get(k);
  };
  // Checks one citation; returns its line text, or null after recording the problem.
  const cite = (e, repo, at, side) => {
    const m = typeof at === 'string' && at.length <= MAX_TEXT ? AT.exec(at) : null;
    if (!m || m[1].split('/').some((s) => s === '..' || s === '.')) { e(`evidence.${side} must be "path:line" (got ${JSON.stringify(at)})`); return null; }
    const L = fileLines(repo, m[1]);
    if (L === null) { e(`evidence.${side} "${at}": ${m[1]} is not a committed, readable file of ${repo} at ${repos[repo].sha.slice(0, 12)}`); return null; }
    const n = Number(m[2]);
    if (n > L.length) { e(`evidence.${side} "${at}": ${m[1]} has ${L.length} line(s) at ${repos[repo].sha.slice(0, 12)}`); return null; }
    if (!L[n - 1].trim()) { e(`evidence.${side} "${at}": that line is blank — cite the line that makes or serves the call`); return null; }
    return L[n - 1];
  };
  const text = (e, v, name, { optional = false } = {}) => {
    if (v === undefined && optional) return;
    if (typeof v !== 'string' || !v.trim() || v.length > MAX_TEXT || CONTROL.test(v)) e(`${name} must be a single-line string of 1..${MAX_TEXT} characters`);
    else if (textHasSecret(v, secretIn)) e(`${name} contains a secret-looking value`);
  };
  const repo = (e, v, name) => { if (typeof v !== 'string' || !own(repos, v)) { e(`${name} "${v}" is not a selected repo`); return false; } return true; };
  const label = (line, endpoint) => (line !== null && endpointTokens(endpoint).some((t) => line.toLowerCase().includes(t)) ? 'matches' : 'exists');

  const checks = [];
  const seen = new Set();
  edges.forEach((x, i) => {
    const e = (m) => errs.push(`edge #${i}${x && x.from && x.to ? ` (${x.from} -> ${x.to})` : ''}: ${m}`);
    checks.push({ from: 'exists', to: 'exists' });
    if (!x || typeof x !== 'object' || Array.isArray(x)) return e('must be an object');
    for (const k of Object.keys(x)) if (!EDGE_KEYS.has(k)) e(`unknown key "${k}"`);
    const okFrom = repo(e, x.from, 'from'); const okTo = repo(e, x.to, 'to');
    if (okFrom && okTo && x.from === x.to) e('an edge joins two different repos');
    if (!KINDS.includes(x.kind)) e(`kind must be one of ${KINDS.join('/')}`);
    text(e, x.endpoint, 'endpoint');
    const key = `${x.from}\0${x.to}\0${x.kind}\0${x.endpoint}`;
    if (seen.has(key)) e('duplicate edge (same from, to, kind and endpoint) — group them into one'); else seen.add(key);
    if (!CONFIDENCE.includes(x.confidence)) e(`confidence must be one of ${CONFIDENCE.join('/')}`);
    if (x.guardable !== null && x.guardable !== undefined && !GUARDABLE.includes(x.guardable)) e(`guardable must be ${GUARDABLE.join(' / ')} or null`);
    text(e, x.note, 'note', { optional: true });
    const ev = x.evidence;
    if (!ev || typeof ev !== 'object' || Array.isArray(ev) || Object.keys(ev).some((k) => k !== 'from' && k !== 'to')) return e('evidence must be { from: "path:line", to: "path:line" }');
    if (okFrom) checks[i].from = label(cite(e, x.from, ev.from, 'from'), x.endpoint);
    if (okTo) checks[i].to = label(cite(e, x.to, ev.to, 'to'), x.endpoint);
  });
  unmatched.forEach((x, i) => {
    const e = (m) => errs.push(`unmatched #${i}: ${m}`);
    if (!x || typeof x !== 'object' || Array.isArray(x)) return e('must be an object');
    for (const k of Object.keys(x)) if (!UNMATCHED_KEYS.has(k)) e(`unknown key "${k}"`);
    const ok = repo(e, x.from, 'from');
    text(e, x.endpoint, 'endpoint');
    text(e, x.reason, 'reason');
    if (ok) cite(e, x.from, x.evidence, 'from');
  });
  return { errors: errs, checks };
}

// Deterministic order (code-point, not locale), so a re-run with the same findings renders the same file.
const by = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const cmp = (a, b) => by(a.from, b.from) || by(a.to || '', b.to || '') || by(a.kind || '', b.kind || '') || by(a.endpoint, b.endpoint);
// checks: from validateIntegrations, aligned with integrations.edges.
export const normalize = ({ edges = [], unmatched = [] }, checks = []) => ({
  edges: edges.map((x, i) => ({
    from: x.from, to: x.to, kind: x.kind, endpoint: x.endpoint, confidence: x.confidence, guardable: x.guardable ?? null,
    evidence: { from: x.evidence.from, to: x.evidence.to }, check: checks[i] || { from: 'exists', to: 'exists' }, ...(x.note ? { note: unciteText(x.note) } : {}),
  })).sort(cmp),
  unmatched: unmatched.map((x) => ({ from: x.from, endpoint: x.endpoint, evidence: x.evidence, reason: unciteText(x.reason) })).sort(cmp),
});

// Agent text is rendered as plain text: no markdown links/images/HTML, no table or code-span breaks.
const tick = (s) => String(s).replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/`/g, "'");
// plain text in a table cell: escape markdown links/images, HTML and the cell separator
const cell = (s) => tick(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
// inside a code span (inert: no HTML, no links) only the cell separator needs escaping
const code = (s) => `\`${tick(s).replace(/\|/g, '\\|')}\``;
// Mermaid node ids: a stable, collision-free id per repo (not a lossy character mapping).
const nodeIds = (names) => new Map([...names].sort(by).map((n, i) => [n, `r${i}`]));
const mark = (c) => (c === 'matches' ? '✓' : '~');

// data: { date, branch, repos: { name: { base, sha } }, edges, unmatched } (normalized).
export function renderSystemMap({ date, branch, repos, edges, unmatched }) {
  const pairs = new Map();
  for (const x of edges) {
    const k = `${x.from}\0${x.to}`;
    if (!pairs.has(k)) pairs.set(k, { from: x.from, to: x.to, kinds: new Map(), n: 0 });
    const p = pairs.get(k); p.n++; p.kinds.set(x.kind, (p.kinds.get(x.kind) || 0) + 1);
  }
  const kinds = (p) => [...p.kinds].map(([k, n]) => `${k} ${n}`).join(', ');
  const ids = nodeIds(new Set([...Object.keys(repos), ...edges.flatMap((x) => [x.from, x.to])]));
  const both = edges.filter((x) => x.check && x.check.from === 'matches' && x.check.to === 'matches').length;
  const L = [
    `# System map — ${date}`, '',
    `Proposed by \`/init-workspace\` on branch \`${tick(branch)}\` — NOT merged. Report only: nothing here is`,
    'enforced yet (seams are M3).', '',
    'How far each connection is checked: both cited lines exist (non-blank) in the committed code of the',
    'right repo. `✓` = the cited line also contains a token of the endpoint; `~` = the line exists but is',
    'an indirect citation (an `include()`, a decorator, a call through a variable) — read it before relying',
    `on it. ${both} of ${edges.length} connections are ✓ on both sides.`, '',
    '## Repos (as read)', '', '| Repo | Base | Commit |', '|---|---|---|',
    ...Object.entries(repos).sort(([a], [b]) => by(a, b)).map(([n, r]) => `| ${cell(n)} | ${cell(r.base)} | ${code(r.sha.slice(0, 12))} |`), '',
    '## Who calls whom', '',
  ];
  if (!edges.length) L.push('No connection between the selected repos was found.', '');
  else {
    L.push('```mermaid', 'graph LR');
    for (const p of pairs.values()) L.push(`  ${ids.get(p.from)}["${tick(p.from)}"] -->|"${kinds(p)}"| ${ids.get(p.to)}["${tick(p.to)}"]`);
    L.push('```', '', '| Caller | Provider | Connections | Guardable now |', '|---|---|---|---|');
    for (const p of pairs.values()) {
      const g = edges.filter((x) => x.from === p.from && x.to === p.to && x.guardable).length;
      L.push(`| ${cell(p.from)} | ${cell(p.to)} | ${p.n} (${kinds(p)}) | ${g} |`);
    }
    L.push('');
    for (const p of pairs.values()) {
      L.push(`### ${tick(p.from)} → ${tick(p.to)}`, '', '| Kind | Endpoint | Confidence | Guardable | Caller | Provider |', '|---|---|---|---|---|---|');
      for (const x of edges.filter((e) => e.from === p.from && e.to === p.to)) {
        L.push(`| ${x.kind} | ${code(x.endpoint)} | ${x.confidence} | ${x.guardable || '—'} | ${mark(x.check.from)} ${code(x.evidence.from)} | ${mark(x.check.to)} ${code(x.evidence.to)} |`);
      }
      const notes = edges.filter((e) => e.from === p.from && e.to === p.to && e.note);
      if (notes.length) { L.push(''); for (const x of notes) L.push(`- ${code(x.endpoint)}: ${cell(x.note)}`); }
      L.push('');
    }
  }
  if (unmatched.length) {
    L.push('## Calls without a matching provider among the selected repos', '', '| Caller | Endpoint | Where | Why |', '|---|---|---|---|');
    for (const x of unmatched) L.push(`| ${cell(x.from)} | ${code(x.endpoint)} | ${code(x.evidence)} | ${cell(x.reason)} |`);
    L.push('');
  }
  return L.join('\n');
}
