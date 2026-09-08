import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, existsSync, rmSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const referee = join(here, 'referee.mjs');

// Run the referee against a fixture; return its exit code + parsed verdict.
function runOn(fixture) {
  const r = spawnSync('node', [referee, '--repo', join(here, 'fixtures', fixture)], { encoding: 'utf8' });
  let verdict = null;
  const lastLine = (r.stdout || '').trim().split('\n').filter(Boolean).pop();
  try { verdict = JSON.parse(lastLine); } catch { /* leave null */ }
  return { code: r.status, verdict };
}

test('INV2 — a genuine pass yields PASS (exit 0, real exit_code 0)', () => {
  const { code, verdict } = runOn('green');
  assert.strictEqual(code, 0);
  assert.strictEqual(verdict.pass, true);
  assert.strictEqual(verdict.evidence.exit_code, 0);
});

test('INV1 — a forged pass (red suite) is BLOCKED (exit 1)', () => {
  const { code, verdict } = runOn('red');
  assert.strictEqual(code, 1);
  assert.strictEqual(verdict.pass, false);
});

test('INV3 — scope cannot be gamed: a trivial passing test does not rescue a red suite (exit 1)', () => {
  const { code, verdict } = runOn('trivial-scope');
  assert.strictEqual(code, 1);
  assert.strictEqual(verdict.pass, false);
});

test('INV4 — indeterminate fails closed (exit 2)', () => {
  const { code, verdict } = runOn('indeterminate');
  assert.strictEqual(code, 2);
  assert.strictEqual(verdict.pass, false);
  assert.strictEqual(verdict.indeterminate, true);
});

test('INV5a — the referee appends a REAL exit code to the ledger (its authoritative source)', () => {
  const ledger = join(here, 'fixtures', 'green', '.quality-kernel', 'evidence-ledger.jsonl');
  if (existsSync(ledger)) rmSync(ledger);
  runOn('green');
  assert.ok(existsSync(ledger), 'referee should have written the ledger');
  const rows = readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const rec = rows.at(-1);
  assert.strictEqual(rec.source, 'referee');
  assert.strictEqual(rec.exit_code, 0);
  assert.strictEqual(rec.pass, true);
  rmSync(ledger); // keep the fixture clean
});
