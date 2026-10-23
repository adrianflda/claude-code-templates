import './hermetic-git.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync, rmSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { newMarker, pgrepMarker, pkillMarker, isAlive, waitFor, markedSleep } from './proc-test-kit.mjs';

// openSession installs process-wide handlers, so every scenario runs in its own child process.
const here = dirname(fileURLToPath(import.meta.url));
const markers = []; const dirs = [];
const mark = () => { const m = newMarker(); markers.push(m); return m; };
after(() => { for (const m of markers) pkillMarker(m); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const scratch = () => { const d = mkdtempSync(join(tmpdir(), 'qk-gs-')); dirs.push(d); return d; };

const SESSION = JSON.stringify(pathToFileURL(join(here, 'process-safety', 'gate-session.mjs')).href);
const SCRIPT = `
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openSession } from ${SESSION};
const [scenario, repo, cmd, extra] = process.argv.slice(2);
const lockDir = process.env.QK_LOCK_DIR || join(process.env.TMPDIR, 'qk-gate-' + process.getuid());
const lockPgids = (dir = lockDir) => readdirSync(dir).filter((f) => f.endsWith('.lock')).flatMap((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')).pgids);
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
if (scenario === 'norun') {
  const session = openSession({ onFatal: () => {} });
  session.run('true', repo).then((r) => { out({ code: r.code, error: r.error && r.error.message }); process.exit(0); }, (e) => { out({ threw: String(e) }); process.exit(0); });
} else {
const injected = scenario === 'inject' ? { lockDir: extra, guardEnv: { QK_MEM_GUARD: 'bogus' } } : scenario === 'injectdir' ? { lockDir: extra } : {};
const session = openSession({ onFatal: () => {}, ...injected });
const refusal = session.preflight({ repo, timeoutMs: 20000 });
if (scenario === 'inject') { out({ refusal }); process.exit(0); }
if (scenario === 'injectdir') { out({ refusal, pgids: lockPgids(extra) }); process.exit(0); }
if (scenario === 'refuse') { out({ refusal }); process.exit(0); }
if (scenario === 'twice') { out({ refusal, second: session.preflight({ repo, timeoutMs: 20000 }) }); process.exit(0); }
const tree = session.tempTree();
const pending = session.run(cmd, repo);
setTimeout(() => out({ refusal, tree, pgids: lockPgids() }), 400);
if (scenario === 'abandon') setTimeout(() => process.exit(0), 800);
else if (scenario === 'run') pending.then((r) => { out({ code: r.code, hasStdout: r.hasStdout }); process.exit(0); });
}
`;

function setup() {
  const dir = scratch(); const repo = join(dir, 'repo'); const locks = join(dir, 'locks'); const tmp = join(dir, 'tmp');
  for (const d of [repo, locks, tmp]) mkdirSync(d);
  spawnSync('git', ['-C', repo, 'init', '-q']);
  const script = join(dir, 'session.mjs'); writeFileSync(script, SCRIPT);
  return { dir, repo, locks, tmp, script };
}
const baseEnv = (s, extra = {}) => ({ ...process.env, QK_MEM_GUARD: 'off', QK_LOCK_DIR: s.locks, TMPDIR: s.tmp, ...extra });
function runScenario(s, args, env) {
  const c = spawn(process.execPath, [s.script, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env });
  let stdout = ''; let stderr = '';
  c.stdout.on('data', (d) => { stdout += d; }); c.stderr.on('data', (d) => { stderr += d; });
  return new Promise((res) => c.on('close', (code, signal) => res({ code, signal, stderr, lines: stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l)) })));
}

test('PT-C1/C4 — a run takes the lock in QK_LOCK_DIR, persists its group, and on exit removes temp trees and the lock', async () => {
  const s = setup();
  // the command outlives one parent-death poll (1 s): a healthy launcher must not end the run
  const r = await runScenario(s, ['run', s.repo, 'sleep 1.6; echo done'], baseEnv(s));
  assert.strictEqual(r.code, 0, r.stderr);
  const [first, result] = r.lines;
  assert.strictEqual(first.refusal, null);
  assert.strictEqual(first.pgids.length, 1, 'the running group is persisted in the lock (Decision 18)');
  assert.ok(Number.isInteger(first.pgids[0].pgid) && first.pgids[0].pgid > 1);
  assert.ok(typeof first.pgids[0].start === 'string' && first.pgids[0].start.length > 5, 'the leader start time is recorded with the pgid (PT-C14)');
  assert.strictEqual(dirname(first.tree), s.tmp);
  assert.match(basename(first.tree), /^[0-9a-f]{12}/);
  assert.deepStrictEqual(result, { code: 0, hasStdout: true });
  assert.strictEqual(existsSync(first.tree), false, 'temp tree removed by the cleanup');
  assert.deepStrictEqual(readdirSync(s.locks), [], 'lock released');
});

test('PT-C12 — without QK_LOCK_DIR the lock lives in the private <tmp>/qk-gate-<uid> directory (0700)', async () => {
  const s = setup(); const env = baseEnv(s); delete env.QK_LOCK_DIR;
  const r = await runScenario(s, ['run', s.repo, 'sleep 0.6'], env);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(r.lines[0].refusal, null);
  assert.strictEqual(r.lines[0].pgids.length, 1);
  const priv = join(s.tmp, `qk-gate-${process.getuid()}`);
  assert.strictEqual(statSync(priv).mode & 0o777, 0o700);
  assert.deepStrictEqual(readdirSync(priv), [], 'lock released');
  assert.deepStrictEqual(readdirSync(s.tmp).filter((f) => f.endsWith('.lock')), []);
});

test('PT-C12 — an untrusted default lock directory refuses pre-flight instead of using it', async () => {
  const s = setup(); const env = baseEnv(s); delete env.QK_LOCK_DIR;
  const priv = join(s.tmp, `qk-gate-${process.getuid()}`); mkdirSync(priv); chmodSync(priv, 0o777);
  const r = await runScenario(s, ['refuse', s.repo], env);
  assert.ok(r.lines[0].refusal.includes(priv), r.lines[0].refusal);
});

test('openSession options — lockDir and guardEnv are injectable and win over the process environment', async () => {
  const s = setup(); const other = join(s.dir, 'injected'); mkdirSync(other);
  const g = await runScenario(s, ['inject', s.repo, '', other], baseEnv(s, { QK_MEM_GUARD: 'off' }));
  assert.match(g.lines[0].refusal, /QK_MEM_GUARD/, 'guardEnv, not process.env, feeds the guard');
  const d = await runScenario(s, ['injectdir', s.repo, '', other], baseEnv(s));
  assert.strictEqual(d.lines[0].refusal, null);
  assert.strictEqual(d.lines[0].pgids.length, 0, 'no command yet: the lock exists in the injected dir with no groups');
  assert.deepStrictEqual(readdirSync(s.locks), [], 'QK_LOCK_DIR was not used');
});

test('run() before a successful preflight() resolves to an explicit refusal, never a TypeError', async () => {
  const s = setup();
  const r = await runScenario(s, ['norun', s.repo], baseEnv(s));
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(r.lines[0].code, null);
  assert.match(r.lines[0].error, /preflight/);
});

test('PT-A7/D6 — the session builds the command env: QK_RUN_ID added, NODE_TEST_CONTEXT dropped, the rest inherited', async () => {
  const s = setup(); const out = join(s.dir, 'env.txt');
  const r = await runScenario(s, ['run', s.repo, `printf '%s|%s|%s' "$QK_RUN_ID" "\${NODE_TEST_CONTEXT-unset}" "$QK_PROBE_KEEP" > ${out}`], baseEnv(s, { NODE_TEST_CONTEXT: 'child-v8', QK_PROBE_KEEP: 'kept', QK_RUN_ID: 'caller-supplied' }));
  assert.strictEqual(r.code, 0, r.stderr);
  const [id, ctx, keep] = readFileSync(out, 'utf8').split('|');
  assert.match(id, /^[0-9a-f]{16}$/);
  assert.strictEqual(ctx, 'unset');
  assert.strictEqual(keep, 'kept');
});

test('PT-C1 — a memory-guard refusal stops pre-flight before any lock exists', async () => {
  const s = setup();
  const r = await runScenario(s, ['refuse', s.repo], baseEnv(s, { QK_MEM_GUARD: 'bogus' }));
  assert.match(r.lines[0].refusal, /QK_MEM_GUARD/);
  assert.deepStrictEqual(readdirSync(s.locks), []);
});

test('PT-C3 — pre-flight refuses while the repository lock is held by a live run', async () => {
  const s = setup();
  const r = await runScenario(s, ['twice', s.repo], baseEnv(s));
  assert.strictEqual(r.lines[0].refusal, null);
  assert.match(r.lines[0].second, /another gate run is active/);
  assert.deepStrictEqual(readdirSync(s.locks), [], 'the first lock is still released at exit');
});

test('PT-A9 — exiting with a command still running SIGKILLs its whole group (even a SIGTERM-ignoring, scrubbed member)', async () => {
  const s = setup(); const m = mark();
  const cmd = `env -i "${process.execPath}" -e "process.on('SIGTERM',()=>{});setTimeout(()=>{},60000)" ${m} & wait`;
  const r = await runScenario(s, ['abandon', s.repo, cmd], baseEnv(s));
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(await waitFor(() => pgrepMarker(m).length === 0, { timeoutMs: 3000 }), true, 'no survivor');
  assert.deepStrictEqual(readdirSync(s.locks), []);
});

test('PT-A13 — when the launcher dies the session kills its tree, releases the lock and exits', async () => {
  const s = setup(); const m = mark();
  // the launcher shell prints the session pid, lives 1.5 s, then dies, orphaning the session
  const launcher = spawn('sh', ['-c', `"${process.execPath}" "${s.script}" hold "${s.repo}" '${markedSleep(m)} & wait' > /dev/null & echo $!; sleep 1.5`], { stdio: ['ignore', 'pipe', 'ignore'], env: baseEnv(s) });
  const pid = await new Promise((res) => launcher.stdout.once('data', (d) => res(Number(String(d).trim()))));
  try {
    assert.ok(await waitFor(() => pgrepMarker(m).length > 0, { timeoutMs: 4000 }), 'the command must start');
    assert.ok(await waitFor(() => !isAlive(pid) && pgrepMarker(m).length === 0, { timeoutMs: 6000 }), 'session and tree must be gone');
    assert.deepStrictEqual(readdirSync(s.locks), []);
  } finally { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
});
