// Static architecture gate (no LLM, no dependency): the import graph of the plugin's production
// scripts has no cycle and respects the process-safety/ boundaries. Static imports only; tests and
// fixtures are not production and are not checked.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve, basename } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const IMPORT_RE = /^\s*(?:import|export)\s(?:[^'"]*?\sfrom\s*)?['"]([^'"]+)['"]/gm;

const SKIP_DIRS = new Set(['fixtures', 'node_modules']);
// Tests, property tests and test-only helpers are not production.
const isProductionFile = (name) => name.endsWith('.mjs') && !/\.test\.mjs$|\.prop\.mjs$|-kit\.mjs$|^hermetic-git\.mjs$/.test(name);
function productionFiles(dir) {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, ent.name);
    if (ent.isDirectory() && !SKIP_DIRS.has(ent.name)) out.push(...productionFiles(abs));
    else if (ent.isFile() && isProductionFile(ent.name)) out.push(abs);
  }
  return out;
}
// file (relative to scripts/) -> relative paths of the local modules it imports
const graph = new Map(productionFiles(root).map((abs) => {
  const deps = [...readFileSync(abs, 'utf8').matchAll(IMPORT_RE)].map((m) => m[1]).filter((s) => s.startsWith('.'));
  return [relative(root, abs), deps.map((s) => relative(root, resolve(dirname(abs), s)))];
}));

const PS = 'process-safety/';
const inPs = (f) => f.startsWith(PS);
// Entry points of process-safety/ for code outside it.
const PS_ENTRIES = new Set([`${PS}gate-session.mjs`, `${PS}proc-forward.mjs`]);
// Each module family and the facade that is its only door for the other families.
const FAMILY_FACADE = { proc: 'proc-tree.mjs', lock: 'gate-lock.mjs', mem: 'mem-guard.mjs' };
const family = (f) => Object.keys(FAMILY_FACADE).find((k) => FAMILY_FACADE[k] === basename(f)) ?? basename(f).split('-')[0];
const isInternal = (f) => inPs(f) && !PS_ENTRIES.has(f) && Object.hasOwn(FAMILY_FACADE, family(f)) && basename(f) !== FAMILY_FACADE[family(f)];

function violations(rule) {
  const out = [];
  for (const [from, deps] of graph) for (const to of deps) { const why = rule(from, to); if (why) out.push(`${from} -> ${to}: ${why}`); }
  return out;
}

test('every local import resolves to a production module that exists', () => {
  assert.deepStrictEqual(violations((_, to) => (graph.has(to) ? null : 'not a production module')), []);
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

test('no module imports a CLI entry point (referee.mjs, qk-gate.mjs)', () => {
  assert.deepStrictEqual(violations((_, to) => (['referee.mjs', 'qk-gate.mjs'].includes(to) ? 'CLI entry points are not libraries' : null)), []);
});

test('process-safety/ depends on nothing outside itself', () => {
  assert.deepStrictEqual(violations((from, to) => (inPs(from) && !inPs(to) ? 'process-safety must not depend on the verification layer' : null)), []);
});

test('code outside process-safety/ enters it only through gate-session.mjs or proc-forward.mjs', () => {
  assert.deepStrictEqual(violations((from, to) => (!inPs(from) && inPs(to) && !PS_ENTRIES.has(to) ? 'bypasses the process-safety entry points' : null)), []);
});

test('a family-internal module is imported only by its own family (lock and mem never reach the runner)', () => {
  assert.deepStrictEqual(violations((from, to) => (isInternal(to) && family(from) !== family(to) ? `internal to the ${family(to)} family; import ${FAMILY_FACADE[family(to)]}` : null)), []);
});
