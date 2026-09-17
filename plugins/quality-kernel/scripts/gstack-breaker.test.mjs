import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { decideVerdict, unanchoredVectors, runBreaker, MIN_VECTORS } from './gstack-breaker.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, 'gstack-breaker.mjs');

// ── Pure: verdict rule (mirrors pipeline-breaker.md) ────────────────────────
test('decideVerdict — >=3 HOLDS and all HOLDS → BREAKER_PASS', () => {
  assert.strictEqual(decideVerdict([{ result: 'HOLDS' }, { result: 'HOLDS' }, { result: 'HOLDS' }]), 'BREAKER_PASS');
});
test('decideVerdict — any VIOLATED → BREAKER_FAIL (even with HOLDS around it)', () => {
  assert.strictEqual(decideVerdict([{ result: 'HOLDS' }, { result: 'VIOLATED' }, { result: 'HOLDS' }]), 'BREAKER_FAIL');
});
test('decideVerdict — any INSTRUMENT-BROKEN dominates → INSTRUMENT-BROKEN (default-deny)', () => {
  assert.strictEqual(decideVerdict([{ result: 'HOLDS' }, { result: 'INSTRUMENT-BROKEN' }, { result: 'HOLDS' }]), 'INSTRUMENT-BROKEN');
});
test('decideVerdict — fewer than MIN_VECTORS HOLDS → INDETERMINATE (not PASS)', () => {
  assert.ok(MIN_VECTORS >= 3);
  assert.strictEqual(decideVerdict([{ result: 'HOLDS' }, { result: 'HOLDS' }]), 'BREAKER_INDETERMINATE');
});

test('unanchoredVectors — flags a vector whose invariant is not in the contract', () => {
  const inv = [{ id: 'INV-A' }, { id: 'INV-B' }];
  assert.deepStrictEqual(unanchoredVectors([{ invariant: 'INV-A' }, { invariant: 'INV-Z: x' }], inv), ['INV-Z: x']);
  assert.deepStrictEqual(unanchoredVectors([{ invariant: 'INV-A' }, { invariant: 'INV-B: ok' }], inv), []);
});

// ── Fixtures: a 3-invariant contract + a deterministic stub $B ───────────────
function contract3() {
  return [
    '# Contract — ui',
    '',
    '## Invariants',
    '| id | description | expected |',
    '| INV-UI-1 | #result shows the total | 5 |',
    '| INV-UI-2 | total persists on reload | 5 |',
    '| INV-UI-3 | total visible | 5 |',
    '',
    '## QA procedure',
    '1. Open the page and read #result.',
  ].join('\n');
}

function stubBin() {
  const tmp = mkdtempSync(join(tmpdir(), 'qk-bstub-'));
  const p = join(tmp, 'b.mjs');
  writeFileSync(p, `#!/usr/bin/env node
const cmd = process.argv[2];
const val = process.env.STUB_VALUE ?? '5';
const truth = process.env.STUB_TRUTH ?? 'ok';
if (cmd === 'goto') { console.log('Navigated to ' + (process.argv[3]||'') + ' (200)'); process.exit(0); }
if (cmd === 'text' || cmd === 'attrs' || cmd === 'html') {
  if (truth === 'fail') { console.error('[error] read failed'); process.exit(1); }
  console.log('--- BEGIN UNTRUSTED EXTERNAL CONTENT (source: x) ---');
  console.log(val);
  console.log('--- END UNTRUSTED EXTERNAL CONTENT ---');
  process.exit(0);
}
if (cmd === 'is') { if (truth === 'fail') process.exit(1); console.log(val); process.exit(0); }
process.exit(0);
`);
  chmodSync(p, 0o755);
  return { tmp, script: p };
}

function launcher(script) {
  const tmp = mkdtempSync(join(tmpdir(), 'qk-launch-'));
  const p = join(tmp, 'b');
  writeFileSync(p, `#!/bin/sh\nexec ${process.execPath} ${script} "$@"\n`);
  chmodSync(p, 0o755);
  return { tmp, bin: p };
}

// write contract + vectors to a workdir, run runBreaker (in-process) with the stub bin
function withCase(vectors, fn, { contractMd = contract3() } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qk-brk-'));
  const c = join(dir, 'contract.md');
  const v = join(dir, 'vectors.json');
  writeFileSync(c, contractMd);
  writeFileSync(v, JSON.stringify(vectors));
  try { return fn({ contractPath: c, vectorsFile: v }); } finally { rmSync(dir, { recursive: true, force: true }); }
}

const vec = (id, expected) => ({ invariant: id, steps: { expected, assert: { mode: 'value', cmd: 'text', args: ['#result'] }, steps: [] } });

function withStubEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  try { return fn(); } finally { for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

test('runBreaker — 3 anchored vectors, all HOLDS → BREAKER_PASS', () => {
  const { tmp, script } = stubBin();
  const { tmp: lt, bin } = launcher(script);
  try {
    const out = withStubEnv({ STUB_VALUE: '5' }, () =>
      withCase([vec('INV-UI-1', '5'), vec('INV-UI-2', '5'), vec('INV-UI-3', '5')],
        ({ contractPath, vectorsFile }) => runBreaker({ contractPath, url: 'http://127.0.0.1:5173/', vectorsFile, bin })));
    assert.strictEqual(out.verdict, 'BREAKER_PASS');
    assert.strictEqual(out.executed, 3);
  } finally { rmSync(tmp, { recursive: true, force: true }); rmSync(lt, { recursive: true, force: true }); }
});

test('runBreaker — one vector VIOLATED → BREAKER_FAIL', () => {
  const { tmp, script } = stubBin();
  const { tmp: lt, bin } = launcher(script);
  try {
    const out = withStubEnv({ STUB_VALUE: '5' }, () =>
      withCase([vec('INV-UI-1', '5'), vec('INV-UI-2', '999'), vec('INV-UI-3', '5')],
        ({ contractPath, vectorsFile }) => runBreaker({ contractPath, url: 'http://localhost/', vectorsFile, bin })));
    assert.strictEqual(out.verdict, 'BREAKER_FAIL');
  } finally { rmSync(tmp, { recursive: true, force: true }); rmSync(lt, { recursive: true, force: true }); }
});

test('runBreaker — a broken probe → INSTRUMENT-BROKEN (blocks)', () => {
  const { tmp, script } = stubBin();
  const { tmp: lt, bin } = launcher(script);
  try {
    const out = withStubEnv({ STUB_VALUE: '5', STUB_TRUTH: 'fail' }, () =>
      withCase([vec('INV-UI-1', '5'), vec('INV-UI-2', '5'), vec('INV-UI-3', '5')],
        ({ contractPath, vectorsFile }) => runBreaker({ contractPath, url: 'http://127.0.0.1/', vectorsFile, bin })));
    assert.strictEqual(out.verdict, 'INSTRUMENT-BROKEN');
  } finally { rmSync(tmp, { recursive: true, force: true }); rmSync(lt, { recursive: true, force: true }); }
});

test('runBreaker — fewer than MIN_VECTORS → BREAKER_INDETERMINATE', () => {
  const { tmp, script } = stubBin();
  const { tmp: lt, bin } = launcher(script);
  try {
    const out = withStubEnv({ STUB_VALUE: '5' }, () =>
      withCase([vec('INV-UI-1', '5'), vec('INV-UI-2', '5')],
        ({ contractPath, vectorsFile }) => runBreaker({ contractPath, url: 'http://127.0.0.1/', vectorsFile, bin })));
    assert.strictEqual(out.verdict, 'BREAKER_INDETERMINATE');
  } finally { rmSync(tmp, { recursive: true, force: true }); rmSync(lt, { recursive: true, force: true }); }
});

test('runBreaker — an unanchored vector is refused → INSTRUMENT-BROKEN (contract anchoring)', () => {
  const { tmp, script } = stubBin();
  const { tmp: lt, bin } = launcher(script);
  try {
    const out = withStubEnv({ STUB_VALUE: '5' }, () =>
      withCase([vec('INV-UI-1', '5'), vec('INV-NOPE', '5'), vec('INV-UI-3', '5')],
        ({ contractPath, vectorsFile }) => runBreaker({ contractPath, url: 'http://127.0.0.1/', vectorsFile, bin })));
    assert.strictEqual(out.verdict, 'INSTRUMENT-BROKEN');
    assert.match(out.reason, /not anchored/);
  } finally { rmSync(tmp, { recursive: true, force: true }); rmSync(lt, { recursive: true, force: true }); }
});

test('CLI — exit codes map to the verdict (PASS→0)', () => {
  const { tmp, script } = stubBin();
  const { tmp: lt, bin } = launcher(script);
  try {
    const r = withStubEnv({ STUB_VALUE: '5' }, () =>
      withCase([vec('INV-UI-1', '5'), vec('INV-UI-2', '5'), vec('INV-UI-3', '5')], ({ contractPath, vectorsFile }) =>
        spawnSync(process.execPath, [cli, '--contract', contractPath, '--url', 'http://127.0.0.1/', '--vectors', vectorsFile, '--bin', bin], { encoding: 'utf8' })));
    assert.strictEqual(r.status, 0);
    assert.strictEqual(JSON.parse(r.stdout.trim().split('\n').pop()).verdict, 'BREAKER_PASS');
  } finally { rmSync(tmp, { recursive: true, force: true }); rmSync(lt, { recursive: true, force: true }); }
});

// ── LIVE E2E — real $B + fixture, 3 vectors anchored to a 3-invariant contract → BREAKER_PASS ──
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
test('LIVE — real $B, 3 vectors → BREAKER_PASS', { skip: !LIVE ? 'set GSTACK_BROWSE_BIN to run' : false }, async () => {
  const { proc, port: portP } = startFixtureServer();
  const port = await portP;
  const tvec = (id) => ({ invariant: id, steps: { expected: '5', assert: { mode: 'text', cmd: 'text', args: ['#result'] }, steps: [] } });
  try {
    const out = withCase([tvec('INV-UI-1'), tvec('INV-UI-2'), tvec('INV-UI-3')],
      ({ contractPath, vectorsFile }) => runBreaker({ contractPath, url: `http://127.0.0.1:${port}/`, vectorsFile, bin: process.env.GSTACK_BROWSE_BIN }));
    assert.strictEqual(out.verdict, 'BREAKER_PASS', JSON.stringify(out.vectors));
  } finally { proc.kill(); }
});
