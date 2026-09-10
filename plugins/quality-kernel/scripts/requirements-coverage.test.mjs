// Acceptance suite for the requirements-coverage skill's deterministic core (the Contract COV-0..8).
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalize } from './req-normalize.mjs';
import { assemble, hashDir } from './coverage-assemble.mjs';
import { report } from './coverage-report.mjs';

// 6 candidates from 3 "documents", one a duplicate (trailing dot) of "suma".
const CANDIDATES = [
  { text: 'El sistema suma dos enteros', source: { doc: 'reqs-a.md', location: 'L1' }, priority: 'high' },
  { text: 'El sistema resta dos enteros', source: { doc: 'reqs-a.md', location: 'L2' } },
  { text: 'El sistema multiplica dos enteros', source: { doc: 'reqs-b.md', location: 'L1' } },
  { text: 'El sistema suma dos enteros.', source: { doc: 'reqs-b.md', location: 'L3' } }, // dup of #1
  { text: 'El sistema expone un endpoint de salud', source: { doc: 'reqs-c.md', location: 'L1' } },
  { text: 'El sistema registra auditoría entre servicios', source: { doc: 'reqs-c.md', location: 'L2' }, category: 'integration' },
];
const idOf = (reqs, needle) => reqs.find((r) => r.text.toLowerCase().startsWith(needle)).id;

// a tiny target repo: add works (its test passes), sub is buggy (its test fails); read-only checks.
function targetRepo() {
  const tmp = mkdtempSync(join(tmpdir(), 'reqcov-repo-'));
  writeFileSync(join(tmp, 'add.mjs'), 'export const add = (a,b) => a+b;');
  writeFileSync(join(tmp, 'add.test.mjs'), "import {test} from 'node:test'; import a from 'node:assert'; import {add} from './add.mjs'; test('add', ()=>a.strictEqual(add(2,3),5));");
  writeFileSync(join(tmp, 'sub.mjs'), 'export const sub = (a,b) => a+b;'); // BUG: should subtract
  writeFileSync(join(tmp, 'sub.test.mjs'), "import {test} from 'node:test'; import a from 'node:assert'; import {sub} from './sub.mjs'; test('sub', ()=>a.strictEqual(sub(5,3),2));");
  return tmp;
}

test('COV-0 — extraction: 6 candidates from 3 docs → 5 canonical, deduped, sources merged', () => {
  const reqs = normalize(CANDIDATES);
  assert.strictEqual(reqs.length, 5, 'the trailing-dot duplicate of "suma" is merged');
  const suma = reqs.find((r) => r.text.toLowerCase().startsWith('el sistema suma'));
  assert.strictEqual(suma.sources.length, 2, 'the duplicate contributed its source');
  assert.strictEqual(suma.priority, 'high', 'a high flag from any analyst wins');
  assert.ok(reqs.every((r) => /^REQ-\d{3}$/.test(r.id)), 'stable ids assigned');
});

test('COV-1..8 — assemble across the requirement set with hybrid verification', () => {
  const reqs = normalize(CANDIDATES);
  const repo = targetRepo();
  const before = hashDir(repo);
  try {
    const results = [
      { id: idOf(reqs, 'el sistema suma'), verdict: 'cumple', evidence: [{ repo: 'calc', path: 'add.mjs', symbol: 'add' }], check: { command: 'node --test add.test.mjs', cwd: repo } },
      { id: idOf(reqs, 'el sistema resta'), verdict: 'parcial', evidence: [{ repo: 'calc', path: 'sub.mjs', symbol: 'sub' }], check: { command: 'node --test sub.test.mjs', cwd: repo }, actions: ['corregir sub(): resta, no suma'] },
      { id: idOf(reqs, 'el sistema multiplica'), verdict: 'falta', actions: ['implementar mul() + su test'] },
      { id: idOf(reqs, 'el sistema expone'), verdict: 'falta', actions: ['añadir endpoint /health'] },
      { id: idOf(reqs, 'el sistema registra'), verdict: 'parcial', evidence: [{ repo: 'web', path: 'log.ts' }, { repo: 'api', path: 'audit.ts' }], actions: ['propagar trace-id entre web y api'] },
    ];
    const { summary, problems, coverage } = assemble(reqs, results);

    assert.strictEqual(problems.length, 0, `no structural/consistency problems: ${problems.join('; ')}`);            // COV-8
    assert.strictEqual(coverage.length, reqs.length);                                                                // COV-1
    assert.deepStrictEqual(coverage.map((c) => c.id).sort(), reqs.map((r) => r.id).sort());                          // COV-8 (none dropped)

    const suma = coverage.find((c) => c.id === idOf(reqs, 'el sistema suma'));
    assert.strictEqual(suma.verdict, 'cumple'); assert.strictEqual(suma.verified.result, 'pass'); assert.strictEqual(suma.verified.readOnly, true); // COV-2

    const mul = coverage.find((c) => c.id === idOf(reqs, 'el sistema multiplica'));
    assert.strictEqual(mul.verdict, 'falta'); assert.ok(mul.actions.length); assert.strictEqual(mul.verified, null); // COV-3 + COV-6 (no check → analytical)

    const resta = coverage.find((c) => c.id === idOf(reqs, 'el sistema resta'));
    assert.strictEqual(resta.verdict, 'parcial'); assert.strictEqual(resta.verified.result, 'fail');                 // COV-4 (buggy sub → check fails)

    const audit = coverage.find((c) => c.id === idOf(reqs, 'el sistema registra'));
    assert.strictEqual(new Set(audit.evidence.map((e) => e.repo)).size, 2);                                          // COV-7 (cross-repo evidence)

    assert.strictEqual(hashDir(repo), before, 'the analyzed repo is byte-identical after the run');                  // COV-5 (read-only)
    assert.strictEqual(summary.total, 5); assert.strictEqual(summary.cumple, 1); assert.strictEqual(summary.falta, 2); assert.strictEqual(summary.parcial, 2);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('assemble — a "cumple" whose check FAILS is a flagged contradiction (exit non-zero)', () => {
  const reqs = normalize([{ text: 'x', source: { doc: 'd' } }]);
  const repo = targetRepo();
  try {
    const { problems } = assemble(reqs, [{ id: reqs[0].id, verdict: 'cumple', check: { command: 'node --test sub.test.mjs', cwd: repo } }]);
    assert.ok(problems.some((p) => /contradiction/.test(p)));
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('report — renders the summary and one row per requirement', () => {
  const reqs = normalize(CANDIDATES);
  const out = assemble(reqs, reqs.map((r) => ({ id: r.id, verdict: 'falta', actions: ['x'] })));
  const md = report(out);
  assert.match(md, /cumple.*parcial.*falta/);
  for (const r of reqs) assert.ok(md.includes(r.id), `report includes ${r.id}`);
  assert.match(md, /## Backlog/);
});
