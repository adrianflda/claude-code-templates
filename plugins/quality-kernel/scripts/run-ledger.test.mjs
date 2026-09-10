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
