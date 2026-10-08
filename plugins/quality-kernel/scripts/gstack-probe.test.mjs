import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extractValue, assertInvariant, runProbe } from './gstack-probe.mjs';
import { isLocalTarget } from './resolvers/gstack-browse.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, 'gstack-probe.mjs');

// ── Pure: value extraction (real $B output shapes) ──────────────────────────
test('extractValue — unwraps the UNTRUSTED EXTERNAL CONTENT envelope (text/html reads)', () => {
  const out = `--- BEGIN UNTRUSTED EXTERNAL CONTENT (source: http://x) ---\n5\n--- END UNTRUSTED EXTERNAL CONTENT ---`;
  assert.strictEqual(extractValue(out), '5');
});
test('extractValue — plain read (is → "true"), skipping daemon log lines', () => {
  assert.strictEqual(extractValue('[browse] Starting server...\ntrue'), 'true');
});
test('extractValue — multi-line envelope body is preserved', () => {
  const out = `--- BEGIN UNTRUSTED EXTERNAL CONTENT (source: x) ---\nline a\nline b\n--- END UNTRUSTED EXTERNAL CONTENT ---`;
  assert.strictEqual(extractValue(out), 'line a\nline b');
});

// ── Pure: assertion ─────────────────────────────────────────────────────────
test('assertInvariant — value/is/text, HOLDS and VIOLATED', () => {
  assert.strictEqual(assertInvariant({ mode: 'value', expected: '5', actual: '5' }), 'HOLDS');
  assert.strictEqual(assertInvariant({ mode: 'value', expected: '5', actual: '6' }), 'VIOLATED');
  assert.strictEqual(assertInvariant({ mode: 'is', expected: 'true', actual: 'TRUE' }), 'HOLDS');
  assert.strictEqual(assertInvariant({ mode: 'text', expected: 'sum', actual: 'the sum is 5' }), 'HOLDS');
  assert.strictEqual(assertInvariant({ mode: 'text', expected: 'zzz', actual: 'the sum is 5' }), 'VIOLATED');
});

// ── Pure: consent gate (both catch branches are fail-closed) ────────────────
test('isLocalTarget — local hosts pass, remote fails, and both catch branches return false', () => {
  assert.strictEqual(isLocalTarget('http://localhost:5173/'), true);
  assert.strictEqual(isLocalTarget('http://127.0.0.1/'), true);
  assert.strictEqual(isLocalTarget('https://app.production.com/'), false);
  assert.strictEqual(isLocalTarget('not a url'), false);            // URL parse throws → false
  assert.strictEqual(isLocalTarget('http://localhost/', '('), false); // invalid regex → false
});

// ── A deterministic stub $B modelling the REAL binary: truth is the EXIT CODE ─
// STUB_VALUE = value the read prints. STUB_TRUTH = ok (default) | fail (read exits 1).
// STUB_FAILCMD = a step cmd that should exit 1 (to model a failing setup action).
function stubBin() {
  const tmp = mkdtempSync(join(tmpdir(), 'qk-bstub-'));
  const p = join(tmp, 'b.mjs');
  writeFileSync(p, `#!/usr/bin/env node
const cmd = process.argv[2];
const val = process.env.STUB_VALUE ?? '5';
const truth = process.env.STUB_TRUTH ?? 'ok';
const failCmd = process.env.STUB_FAILCMD ?? '';
if (failCmd && cmd === failCmd) { console.error('[error] ' + cmd + ' failed'); process.exit(1); }
if (cmd === 'goto') { console.log('Navigated to ' + (process.argv[3]||'') + ' (200)'); process.exit(0); }
if (cmd === 'text' || cmd === 'attrs' || cmd === 'html') {
  if (truth === 'fail') { console.error('[error] read failed'); process.exit(1); }
  console.log('--- BEGIN UNTRUSTED EXTERNAL CONTENT (source: x) ---');
  console.log(val);
  console.log('--- END UNTRUSTED EXTERNAL CONTENT ---');
  process.exit(0);
}
if (cmd === 'is') { if (truth === 'fail') process.exit(1); console.log(val); process.exit(0); }
process.exit(0); // click/fill/snapshot/… setup actions
`);
  chmodSync(p, 0o755);
  return { tmp, script: p };
}

function withSteps(spec, fn) {
  const tmp = mkdtempSync(join(tmpdir(), 'qk-steps-'));
  const f = join(tmp, 'steps.json');
  writeFileSync(f, JSON.stringify(spec));
  try { return fn(f); } finally { rmSync(tmp, { recursive: true, force: true }); }
}

// A launcher `$B` file that execs `node <stub>` — resolveBrowseBin needs an existing file path.
function launcher(script) {
  const tmp = mkdtempSync(join(tmpdir(), 'qk-launch-'));
  const p = join(tmp, 'b');
  writeFileSync(p, `#!/bin/sh\nexec ${process.execPath} ${script} "$@"\n`);
  chmodSync(p, 0o755);
  return { tmp, bin: p };
}

function runCli(script, url, stepsFile, env = {}) {
  const { tmp, bin } = launcher(script);
  try {
    const r = spawnSync(process.execPath, [cli, '--url', url, '--steps', stepsFile, '--bin', bin], {
      encoding: 'utf8', env: { ...process.env, ...env },
    });
    return { ...r, json: JSON.parse((r.stdout || '').trim().split('\n').filter(Boolean).pop()) };
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

const BASE_STEPS = { expected: '5', assert: { mode: 'value', cmd: 'text', args: ['#result'] }, steps: [] };

test('CLI — invariant HOLDS on a local target → exit 0', () => {
  const { tmp, script } = stubBin();
  try {
    const r = withSteps(BASE_STEPS, (f) => runCli(script, 'http://127.0.0.1:5173/', f, { STUB_VALUE: '5' }));
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.json.result, 'HOLDS');
    assert.strictEqual(r.json.actual, '5');
    assert.match(r.json.probe_output, /BEGIN UNTRUSTED/); // literal evidence kept
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('CLI — invariant VIOLATED (observed ≠ expected) → exit 1', () => {
  const { tmp, script } = stubBin();
  try {
    const r = withSteps(BASE_STEPS, (f) => runCli(script, 'http://localhost:3000/', f, { STUB_VALUE: '6' }));
    assert.strictEqual(r.status, 1);
    assert.strictEqual(r.json.result, 'VIOLATED');
    assert.strictEqual(r.json.actual, '6');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('CLI — a read that exits non-zero → INSTRUMENT-BROKEN, not VIOLATED (exit 2)', () => {
  const { tmp, script } = stubBin();
  try {
    const r = withSteps(BASE_STEPS, (f) => runCli(script, 'http://127.0.0.1/', f, { STUB_TRUTH: 'fail' }));
    assert.strictEqual(r.status, 2);
    assert.strictEqual(r.json.result, 'INSTRUMENT-BROKEN');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('CLI — a setup step that exits non-zero → INSTRUMENT-BROKEN (exit 2)', () => {
  const { tmp, script } = stubBin();
  try {
    const steps = { expected: '5', assert: { mode: 'value', cmd: 'text', args: ['#result'] }, steps: [{ cmd: 'click', args: ['#add'] }] };
    const r = withSteps(steps, (f) => runCli(script, 'http://127.0.0.1/', f, { STUB_FAILCMD: 'click' }));
    assert.strictEqual(r.status, 2);
    assert.strictEqual(r.json.result, 'INSTRUMENT-BROKEN');
    assert.strictEqual(r.json.step, 'click');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('CLI — a boolean `is` invariant HOLDS (plain output, no envelope)', () => {
  const { tmp, script } = stubBin();
  try {
    const steps = { expected: 'true', assert: { mode: 'is', cmd: 'is', args: ['visible', '#result'] }, steps: [] };
    const r = withSteps(steps, (f) => runCli(script, 'http://127.0.0.1/', f, { STUB_VALUE: 'true' }));
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.json.result, 'HOLDS');
    assert.strictEqual(r.json.actual, 'true');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('CLI — non-local target is refused (consent gate) → INSTRUMENT-BROKEN (exit 2)', () => {
  const { tmp, script } = stubBin();
  try {
    const r = withSteps(BASE_STEPS, (f) => runCli(script, 'https://app.production.com/', f));
    assert.strictEqual(r.status, 2);
    assert.match(r.json.reason, /not local/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('runProbe — no $B binary resolved → INSTRUMENT-BROKEN (fail-closed)', () => {
  const prev = process.env.GSTACK_BROWSE_BIN;
  delete process.env.GSTACK_BROWSE_BIN;
  try {
    const out = withSteps(BASE_STEPS, (f) => runProbe({ url: 'http://127.0.0.1/', stepsFile: f, bin: null }));
    assert.strictEqual(out.result, 'INSTRUMENT-BROKEN');
    assert.match(out.reason, /browse binary/);
  } finally { if (prev !== undefined) process.env.GSTACK_BROWSE_BIN = prev; }
});

// ── LIVE E2E — real $B against a local fixture page. Skipped unless a binary is provided. ──
// The fixture server runs in a SEPARATE process: runProbe uses spawnSync (blocking), so a server in
// this same event loop could not answer the daemon's request while the probe runs. In production the
// SUT is always a separate process, so this also models reality.
const LIVE = !!process.env.GSTACK_BROWSE_BIN;
function startFixtureServer() {
  const js = "const h=require('http');const s=h.createServer((q,r)=>{r.writeHead(200,{'content-type':'text/html'});r.end('<!doctype html><html><body><div id=\"result\">5</div></body></html>')});s.listen(0,'127.0.0.1',()=>console.log('UP '+s.address().port));";
  const proc = spawn(process.execPath, ['-e', js], { stdio: ['ignore', 'pipe', 'pipe'] });
  const port = new Promise((res, rej) => {
    proc.stdout.on('data', (d) => { const m = /UP (\d+)/.exec(d.toString()); if (m) res(Number(m[1])); });
    proc.on('error', rej);
    setTimeout(() => rej(new Error('fixture server did not start')), 10000);
  });
  return { proc, port };
}
test('LIVE — real $B reads a fixture invariant and HOLDS', { skip: !LIVE ? 'set GSTACK_BROWSE_BIN to run' : false }, async () => {
  const { proc, port: portP } = startFixtureServer();
  const port = await portP;
  try {
    // text read: expected value present in the (untrusted-unwrapped) page text.
    const hold = withSteps(
      { expected: '5', assert: { mode: 'text', cmd: 'text', args: ['#result'] }, steps: [] },
      (f) => runProbe({ url: `http://127.0.0.1:${port}/`, stepsFile: f, bin: process.env.GSTACK_BROWSE_BIN }),
    );
    assert.strictEqual(hold.result, 'HOLDS', `probe_output: ${hold.probe_output || hold.reason}`);

    // a wrong expectation must come back VIOLATED (not INSTRUMENT-BROKEN) — the oracle discriminates.
    const viol = withSteps(
      { expected: '999', assert: { mode: 'value', cmd: 'text', args: ['#result'] }, steps: [] },
      (f) => runProbe({ url: `http://127.0.0.1:${port}/`, stepsFile: f, bin: process.env.GSTACK_BROWSE_BIN }),
    );
    assert.strictEqual(viol.result, 'VIOLATED', `probe_output: ${viol.probe_output || viol.reason}`);
  } finally { proc.kill(); }
});
