import { test, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAlive, waitFor } from './proc-test-kit.mjs';

// createForwarder installs process-wide signal handlers, so the forwarding parent is a child process.
const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'qk-fw-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const file = (name, body) => { const p = join(dir, name); writeFileSync(p, body); return p; };

const PARENT = file('parent.mjs', `
import { createForwarder } from ${JSON.stringify(pathToFileURL(join(here, 'process-safety', 'proc-forward.mjs')).href)};
const [mode, graceMs, child, ...args] = process.argv.slice(2);
const forwarder = createForwarder({ graceMs: Number(graceMs) });
if (mode === 'idle') { console.log('ready'); setInterval(() => {}, 1000); }
else forwarder.runJson(child, args, { stderr: 'inherit' }).then((r) => console.log(JSON.stringify(r)));
`);
const JSON_CHILD = file('json-child.mjs', `console.log('noise'); console.log(JSON.stringify({ args: process.argv.slice(2) })); process.exit(3);`);
// Writes its pid to <file> once its handlers are installed; on each listed signal appends the name and, unless told to ignore, exits.
const SIGNAL_CHILD = file('signal-child.mjs', `
import { writeFileSync, appendFileSync } from 'node:fs';
const [out, ignore] = process.argv.slice(2);
for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => { appendFileSync(out, ' ' + s); if (ignore !== 'ignore') process.exit(0); });
writeFileSync(out, String(process.pid));
setTimeout(() => {}, 60000);
`);

function startParent(args, env = process.env) {
  const c = spawn(process.execPath, [PARENT, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env });
  let stdout = '';
  c.stdout.on('data', (d) => { stdout += d; });
  const done = new Promise((res) => c.on('exit', (code, signal) => res({ code, signal, stdout })));
  return { c, done, ready: () => stdout.includes('ready') };
}
const childState = (out) => { try { return readFileSync(out, 'utf8'); } catch { return ''; } };

test('runJson passes the arguments and returns the exit code with the last JSON line', async () => {
  const { done } = startParent(['run', '10000', JSON_CHILD, 'a', 'b c']);
  const r = await done;
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), { code: 3, json: { args: ['a', 'b c'] } });
});

test('runJson resolves { code: null, json: null } when the child cannot be spawned', async () => {
  // harm: an unhandled spawn error crashes qk-gate instead of reporting "referee produced no verdict"
  const { done } = startParent(['run', '10000', JSON_CHILD], { ...process.env, PATH: join(dir, 'no-bin') });
  const r = await done;
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), { code: null, json: null });
});

test('PT-A12 — SIGINT/SIGTERM/SIGHUP are forwarded to the child; the parent exits 130/143/129 once it is gone', async () => {
  for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
    const out = join(dir, `child-${sig}`);
    const { c, done } = startParent(['run', '20000', SIGNAL_CHILD, out]);
    assert.ok(await waitFor(() => childState(out) !== ''), 'child ready');
    const t0 = Date.now();
    c.kill(sig);
    const r = await done;
    assert.strictEqual(r.code, code, sig);
    assert.ok(Date.now() - t0 < 5000, `exits when the child is gone, not after the grace (${sig})`);
    assert.match(childState(out), new RegExp(` ${sig}$`), `the child received ${sig}`);
  }
});

test('PT-A12 — with no child running a termination signal exits at once with 128+signal', async () => {
  const { c, done, ready } = startParent(['idle', '20000']);
  assert.ok(await waitFor(ready));
  c.kill('SIGTERM');
  assert.strictEqual((await done).code, 143);
});

test('PT-A12 — a child that ignores the signal is SIGKILLed after the grace; a second signal does not change the exit code', async () => {
  const out = join(dir, 'child-ignore');
  const { c, done } = startParent(['run', '500', SIGNAL_CHILD, out, 'ignore']);
  assert.ok(await waitFor(() => childState(out) !== ''), 'child ready');
  const childPid = Number(childState(out).split(' ')[0]);
  c.kill('SIGTERM');
  await new Promise((res) => setTimeout(res, 100));
  c.kill('SIGINT');
  const r = await done;
  assert.strictEqual(r.code, 143, 'the first signal decides the exit code');
  assert.match(childState(out), / SIGTERM$/, 'only the first signal is forwarded');
  try {
    assert.ok(await waitFor(() => !isAlive(childPid), { timeoutMs: 2000 }), 'the child must be SIGKILLed after the grace');
  } finally { try { process.kill(childPid, 'SIGKILL'); } catch { /* gone */ } }
});
