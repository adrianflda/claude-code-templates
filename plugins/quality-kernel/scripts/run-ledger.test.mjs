import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, 'run-ledger.mjs');

test('run-ledger — appends one valid JSONL row with the recorded numbers', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'qk-ledger-'));
  try {
    const r = spawnSync('node', [cli, '--repo', tmp, '--issue', 'gh-42', '--tokens', '12000', '--usd', '0.9', '--wallclock-ms', '45000', '--interventions', '1', '--verdict', 'pass'], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0);
    const row = JSON.parse(readFileSync(join(tmp, '.quality-kernel', 'run-ledger.jsonl'), 'utf8').trim());
    assert.strictEqual(row.issue, 'gh-42');
    assert.strictEqual(row.tokens, 12000);
    assert.strictEqual(row.humanInterventions, 1);
    assert.strictEqual(row.verdict, 'pass');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// --- review regression (#25): the cost ledger must not absorb junk ---
test('run-ledger (RED) — a non-numeric --tokens is rejected, not stored as null', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'qk-ledger-'));
  try {
    const r = spawnSync('node', [cli, '--repo', tmp, '--issue', 'gh-1', '--tokens', 'nope'], { encoding: 'utf8' });
    assert.strictEqual(r.status, 2);
    assert.strictEqual(JSON.parse(r.stdout.trim()).ok, false);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
test('run-ledger (RED) — a missing --issue is rejected', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'qk-ledger-'));
  try {
    const r = spawnSync('node', [cli, '--repo', tmp, '--verdict', 'pass'], { encoding: 'utf8' });
    assert.strictEqual(r.status, 2);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
test('run-ledger (RED) — a verdict outside pass|fail|kill is rejected', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'qk-ledger-'));
  try {
    const r = spawnSync('node', [cli, '--repo', tmp, '--issue', 'gh-1', '--verdict', 'green'], { encoding: 'utf8' });
    assert.strictEqual(r.status, 2);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
test('run-ledger (RED) — a negative numeric is rejected', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'qk-ledger-'));
  try {
    const r = spawnSync('node', [cli, '--repo', tmp, '--issue', 'gh-1', '--usd', '-5'], { encoding: 'utf8' });
    assert.strictEqual(r.status, 2);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
