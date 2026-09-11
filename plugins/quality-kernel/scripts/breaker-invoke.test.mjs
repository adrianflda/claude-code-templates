import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { buildBlindInput } from './breaker-invoke.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, 'breaker-invoke.mjs');
const exampleMd = join(here, 'fixtures', 'm2', 'contracts', 'example.md');

test('P5 boundary — the blind input contains ONLY contract + probe, never the diff/tests/reasoning', () => {
  const input = buildBlindInput("## Invariants\n| INV-A | d | 1 |\n\n## QA procedure\n- step 1", { probeCmd: 'run', systemUrl: 'http://x' });
  assert.deepStrictEqual(Object.keys(input).sort(), ['invariants', 'probeCmd', 'qaProcedure', 'systemUrl']);
  for (const forbidden of ['diff', 'changed', 'tests', 'reasoning', 'code', 'patch']) {
    assert.ok(!(forbidden in input), `blind input must not contain "${forbidden}"`);
  }
  assert.deepStrictEqual(input.invariants, [{ id: 'INV-A', expected: '1' }]);
});

// a deterministic stub breaker: reads the blind input on stdin, returns a fixed verdict
function stub(verdict) {
  const tmp = mkdtempSync(join(tmpdir(), 'qk-brk-'));
  const p = join(tmp, 'stub.mjs');
  writeFileSync(p, `let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const i=JSON.parse(s);if('diff'in i||'tests'in i){console.log(JSON.stringify({verdict:'BREAKER_FAIL',reason:'leaked'}));process.exit(0);}console.log(JSON.stringify({verdict:'${verdict}'}));});`);
  return { tmp, cmd: `node ${p}` };
}

test('CLI — a stub breaker returning BREAKER_FAIL -> exit 1', () => {
  const { tmp, cmd } = stub('BREAKER_FAIL');
  try {
    const r = spawnSync('node', [cli, '--contract', exampleMd, '--probe', 'true', '--url', 'http://x', '--breaker', cmd], { encoding: 'utf8' });
    assert.strictEqual(r.status, 1);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('CLI — a stub breaker returning BREAKER_PASS -> exit 0, and it received no diff', () => {
  const { tmp, cmd } = stub('BREAKER_PASS');
  try {
    const r = spawnSync('node', [cli, '--contract', exampleMd, '--probe', 'true', '--url', 'http://x', '--breaker', cmd], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0);
    assert.deepStrictEqual(JSON.parse(r.stdout.trim().split('\n').pop()).blindInputKeys.sort(), ['invariants', 'probeCmd', 'qaProcedure', 'systemUrl']);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('CLI — a breaker that cannot run -> exit 2 (fail-closed)', () => {
  const r = spawnSync('node', [cli, '--contract', exampleMd, '--breaker', 'this-cmd-does-not-exist-xyz'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 2);
});

// --- review regression (#25): a breaker with no live target, or a failed process, cannot green ---
test('CLI (RED) — missing --probe/--url fails closed (exit 2) even with a PASSing breaker', () => {
  const { tmp, cmd } = stub('BREAKER_PASS');
  try {
    const r = spawnSync('node', [cli, '--contract', exampleMd, '--breaker', cmd], { encoding: 'utf8' });
    assert.strictEqual(r.status, 2);
    assert.match(JSON.parse(r.stdout.trim()).reason, /--probe/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
test('CLI (RED) — a breaker printing BREAKER_PASS but exiting non-zero does not green the gate', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'qk-brk-'));
  try {
    const p = join(tmp, 'crash.mjs');
    writeFileSync(p, "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{console.log(JSON.stringify({verdict:'BREAKER_PASS'}));process.exit(7);});");
    const r = spawnSync('node', [cli, '--contract', exampleMd, '--probe', 'true', '--url', 'http://x', '--breaker', `node ${p}`], { encoding: 'utf8' });
    assert.strictEqual(r.status, 2);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
