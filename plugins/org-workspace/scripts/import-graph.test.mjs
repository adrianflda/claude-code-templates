// Static architecture gate (no LLM, no dependency): the import graph of org-workspace's production
// scripts has no cycle and every import points DOWN the layer order below — low-level, IO-near
// helpers never depend on the guide/map/discovery tools built on top of them. Static imports only;
// tests, property tests and test-only helpers are not production and are not checked.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const IMPORT_RE = /^\s*(?:import|export)\s(?:[^'"]*?\sfrom\s*)?['"]([^'"]+)['"]/gm;
const isProductionFile = (name) => name.endsWith('.mjs') && !/\.test\.mjs$|\.prop\.mjs$|-kit\.mjs$|^hermetic-git\.mjs$/.test(name);

// Layer of each production module; a module may import only modules of a strictly LOWER layer.
//   0  leaves: shared policy, entrypoint detection, the git wrapper (import nothing local)
//   1  org-profile      one repo's profile (git facts, redaction)
//   2  org-integrations one repo's integration extraction (+ the secret predicates)
//   3  org-map          the integration-map schema and its SYSTEM-MAP.md rendering
//   4  org-guide        guide.json (sole owner of reading/writing it) and the CLAUDE.md block
//   5  org-discover     candidate-repo discovery for /org-init (reads guide.json's forbidden list)
const LAYER = {
  'org-policy.mjs': 0, 'entrypoint.mjs': 0, 'safe-git.mjs': 0,
  'org-profile.mjs': 1,
  'org-integrations.mjs': 2,
  'org-map.mjs': 3,
  'org-guide.mjs': 4,
  'org-discover.mjs': 5,
};

const files = readdirSync(root).filter(isProductionFile);
// file -> the local modules it imports (all of org-workspace's scripts live in one flat directory)
const graph = new Map(files.map((f) => [f, [...readFileSync(`${root}/${f}`, 'utf8').matchAll(IMPORT_RE)]
  .map((m) => m[1]).filter((s) => s.startsWith('./')).map((s) => s.slice(2))]));

function violations(rule) {
  const out = [];
  for (const [from, deps] of graph) for (const to of deps) { const why = rule(from, to); if (why) out.push(`${from} -> ${to}: ${why}`); }
  return out;
}

test('every production module has a declared layer (a new module must be placed deliberately)', () => {
  assert.deepStrictEqual(files.filter((f) => !(f in LAYER)), []);
});

test('every local import resolves to a production module', () => {
  assert.deepStrictEqual(violations((_, to) => (graph.has(to) ? null : 'not a production module (test-only helpers stay out of production code)')), []);
});

test('the production import graph has no cycle', () => {
  const state = new Map(); const cycles = [];
  const visit = (f, path) => {
    if (state.get(f) === 'done') return;
    if (state.get(f) === 'open') { cycles.push([...path.slice(path.indexOf(f)), f].join(' -> ')); return; }
    state.set(f, 'open');
    for (const d of graph.get(f) || []) visit(d, [...path, f]);
    state.set(f, 'done');
  };
  for (const f of graph.keys()) visit(f, []);
  assert.deepStrictEqual(cycles, []);
});

test('dependency rule: every import points to a strictly lower layer', () => {
  assert.deepStrictEqual(violations((from, to) => (LAYER[to] < LAYER[from] ? null : `layer ${LAYER[from]} must not import layer ${LAYER[to]}`)), []);
});
