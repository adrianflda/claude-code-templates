// Static architecture gate: diff-budget.mjs is a leaf the panel depends on, never the other way.
// It imports nothing (no git, no child processes, no fs), so it stays importable and unit-testable
// without the panel's side effects; the panel is its only production importer.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const scripts = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
const IMPORT_RE = /^\s*(?:import|export)\s(?:[^'"]*?\sfrom\s*)?['"]([^'"]+)['"]|\bimport\s*\(/gm;
const importsOf = (f) => [...readFileSync(join(scripts, f), 'utf8').matchAll(IMPORT_RE)].map((m) => m[1] ?? 'dynamic import()');

test('diff-budget.mjs imports nothing (pure leaf)', () => {
  assert.deepStrictEqual(importsOf('diff-budget.mjs'), []);
});

test('only ai-review-panel.mjs imports diff-budget.mjs among the production scripts', () => {
  const importers = readdirSync(scripts).filter((f) => /\.m?js$/.test(f) && f !== 'diff-budget.mjs')
    .filter((f) => importsOf(f).some((s) => s === './diff-budget.mjs'));
  assert.deepStrictEqual(importers, ['ai-review-panel.mjs']);
});
