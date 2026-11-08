import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { buildBlindInput } from './breaker-invoke.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, 'breaker-invoke.mjs');
const exampleMd = join(here, 'fixtures', 'm2', 'contracts', 'example.md');
const shapeMd = join(here, 'fixtures', 'qk-breaker-robust-input', 'contracts', 'contract-1045-shape.md');

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

// --- EARS-H1/H2/H4/H5 (INV-1/2/3/4, carried major #4): a stub that ECHOES the parsed fields back in
// its verdict JSON, so the assertion is on breaker-invoke.mjs's own observable stdout, never an
// internal import of buildBlindInput. ---
function echoStub() {
  const tmp = mkdtempSync(join(tmpdir(), 'qk-brk-echo-'));
  const p = join(tmp, 'echo.mjs');
  writeFileSync(
    p,
    "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const i=JSON.parse(s);" +
      "console.log(JSON.stringify({verdict:(i.qaProcedure&&i.invariants&&i.invariants.length?'BREAKER_PASS':'INSTRUMENT-BROKEN'),qaProcedure:i.qaProcedure,invariants:i.invariants}));});",
  );
  return { tmp, cmd: `node ${p}` };
}

test('EARS-H1 (INV-1) — numbered/parenthetical headings parse: stub observes non-empty qaProcedure/invariants', () => {
  const { tmp, cmd } = echoStub();
  try {
    const r = spawnSync('node', [cli, '--contract', shapeMd, '--probe', 'true', '--url', 'http://example.com', '--breaker', cmd], { encoding: 'utf8' });
    const out = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.strictEqual(out.verdict, 'BREAKER_PASS');
    assert.match(out.qaProcedure, /Navigate to http:\/\/example\.com\/admin\/login\//);
    assert.strictEqual(r.status, 0);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('EARS-H7 (INV-2) — legacy headings/ids still parse end to end through the CLI', () => {
  const { tmp, cmd } = echoStub();
  try {
    const r = spawnSync('node', [cli, '--contract', exampleMd, '--probe', 'true', '--url', 'http://example.com', '--breaker', cmd], { encoding: 'utf8' });
    const out = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.strictEqual(out.verdict, 'BREAKER_PASS');
    assert.deepStrictEqual(out.invariants, [{ id: 'INV-ADD-1', expected: '5' }, { id: 'INV-ADD-2', expected: '400' }]);
    assert.strictEqual(r.status, 0);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('EARS-H4 (INV-3/4) — a bold, parenthetical, non-INV- id normalizes, and a piped probe-command cell does not shift "expected"', () => {
  const { tmp, cmd } = echoStub();
  try {
    const r = spawnSync('node', [cli, '--contract', shapeMd, '--probe', 'true', '--url', 'http://example.com', '--breaker', cmd], { encoding: 'utf8' });
    const out = JSON.parse(r.stdout.trim().split('\n').pop());
    const eo6 = out.invariants.find((i) => i.id === 'EO-6');
    assert.ok(eo6, 'EO-6 missing from parsed invariants');
    assert.strictEqual(eo6.expected, 'not yet probeable');
    assert.ok(!/[`|]|jq/.test(eo6.expected), 'expected value leaked a fragment of the probe-command cell');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('EARS-H2b (INV-12) — a second, genuinely-matching heading never overrides the first (dup.md)', () => {
  const { tmp, cmd } = echoStub();
  const dup = join(tmp, 'dup.md');
  writeFileSync(dup, ['## 6. External Observable Invariants', '| INV-A | d | 1 |', '## 9. Invariants (changelog)', '| INV-Z | changelog-only | 99 |', '## 5. QA procedure', '- do it'].join('\n'));
  try {
    const r = spawnSync('node', [cli, '--contract', dup, '--probe', 'true', '--url', 'http://example.com', '--breaker', cmd], { encoding: 'utf8' });
    const out = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.deepStrictEqual(out.invariants, [{ id: 'INV-A', expected: '1' }]);
    assert.ok(!out.invariants.some((i) => i.id === 'INV-Z'));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// --- EARS-H6 (INV-5/6): an empty QA-procedure / invariants section fails closed BEFORE the breaker
// ever runs, exit 2, verdict INSTRUMENT-BROKEN naming the empty section + headings found. ---
function flagStub(tmp) {
  const flag = join(tmp, 'breaker-invoked.flag');
  return { flag, cmd: `node -e "require('fs').appendFileSync(${JSON.stringify(flag)},'x')"` };
}

test('EARS-H6 (INV-5) — an empty QA-procedure body fails closed, exit 2, breaker never runs', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'qk-brk-h6-'));
  try {
    const shape = readFileSync(shapeMd, 'utf8');
    const blanked = shape.replace(/(## 5\. End-to-end QA procedure[^\n]*\n)[\s\S]*?(\n## 6\.)/, '$1$2');
    const copy = join(tmp, 'blank-qa.md');
    writeFileSync(copy, blanked);
    const { flag, cmd } = flagStub(tmp);
    const r = spawnSync('node', [cli, '--contract', copy, '--probe', 'true', '--url', 'http://example.com', '--breaker', cmd], { encoding: 'utf8' });
    const out = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.strictEqual(r.status, 2);
    assert.strictEqual(out.verdict, 'INSTRUMENT-BROKEN');
    assert.match(out.reason, /qaProcedure/);
    assert.match(out.reason, /## 5\. End-to-end QA procedure/);
    assert.ok(!existsSync(flag), 'the breaker command ran even though the input was empty');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('EARS-H6 (INV-6) — an empty invariants table fails closed, exit 2, breaker never runs', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'qk-brk-h6b-'));
  try {
    const shape = readFileSync(shapeMd, 'utf8');
    const blanked = shape.replace(/(## 6\. External Observable Invariants\n)[\s\S]*?(\n## 7\.)/, '$1$2');
    const copy = join(tmp, 'blank-inv.md');
    writeFileSync(copy, blanked);
    const { flag, cmd } = flagStub(tmp);
    const r = spawnSync('node', [cli, '--contract', copy, '--probe', 'true', '--url', 'http://example.com', '--breaker', cmd], { encoding: 'utf8' });
    const out = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.strictEqual(r.status, 2);
    assert.strictEqual(out.verdict, 'INSTRUMENT-BROKEN');
    assert.match(out.reason, /invariants/);
    assert.match(out.reason, /## 6\. External Observable Invariants/);
    assert.ok(!existsSync(flag), 'the breaker command ran even though the input was empty');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
