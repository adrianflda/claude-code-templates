// Acceptance harness for docs/specs/gate-process-tree/gate-process-tree.feature.
// Each scenario title below is the Gherkin scenario title verbatim (a trace test checks the full list).
// The scenarios run the real referee / gate CLIs against throwaway fixture repos, with real short-lived
// grandchildren (every one sleeps at most 60 s) tagged by a unique marker. Cucumber.js is not installed
// in this plugin (no package.json, no dependency) so the steps are hand-written node:test code.
import './hermetic-git.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { lockPathFor, processStart } from './process-safety/gate-lock.mjs';
import { newMarker, pgrepMarker, pkillMarker, isAlive, waitFor, markedSleep } from './proc-test-kit.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const REFEREE = join(here, 'referee.mjs');
const GATE = join(here, 'qk-gate.mjs');
const FEATURE = join(here, '..', 'docs', 'specs', 'gate-process-tree', 'gate-process-tree.feature');
const T = { timeout: 180000 };
const roots = []; const markers = []; const pids = [];

after(() => {
  for (const m of markers) pkillMarker(m);
  for (const p of pids) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
process.on('exit', () => { for (const m of markers) pkillMarker(m); });

const mark = () => { const m = newMarker(); markers.push(m); return m; };
const scenario = (title, fn) => test(title, T, fn);
const cmdSleeper = (m) => markedSleep(m);
const cmdTermIgnorer = (m) => `node -e "process.on('SIGTERM',()=>{});setTimeout(()=>{},60000)" ${m}`;
const cmdEscapee = (m) => `node -e "require('child_process').spawn('node',['-e','setTimeout(()=>{},60000)','${m}'],{detached:true,stdio:'ignore'}).unref()"`;
const cmdBig = (stream, bytes) => `node -e "process.${stream}.write('x'.repeat(${bytes}))"`;
// A command that records the pid of its background grandchild, then keeps the tree alive.
const withPidFile = (grandchild, file) => `${grandchild} & echo $! > ${file}; sleep 60`;

function fixture({ tools = {}, toolsRaw, critical = false, headPath = 'src/code.mjs' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'qk-acc-')); roots.push(root);
  const repo = join(root, 'repo'), tmp = join(root, 'tmp'), locks = join(root, 'locks'), side = join(root, 'side');
  for (const d of [repo, tmp, locks, side]) mkdirSync(d, { recursive: true });
  const git = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  const write = (p, c) => { mkdirSync(dirname(join(repo, p)), { recursive: true }); writeFileSync(join(repo, p), c); };
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  write('.quality-kernel/tools.json', toolsRaw ?? JSON.stringify({ verify: 'exit 0', productionGlobs: ['src/**'], ...tools }));
  write('.quality-kernel/critical-surface.json', JSON.stringify({ criticalGlobs: ['**/auth/**'], safeGlobs: ['**/*.md'] }));
  write('src/code.mjs', 'export const f = () => 1;');
  if (critical) write('src/auth/thing.mjs', 'export const a = 1;');
  git('add', '-A'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD').stdout.trim();
  write(critical ? 'src/auth/thing.mjs' : headPath, 'export const f = () => 2;');
  git('add', '-A'); git('commit', '-qm', 'head');
  const head = git('rev-parse', 'HEAD').stdout.trim();
  return { root, repo, tmp, locks, side, base, head, git, write };
}
const envFor = (fx, extra = {}) => ({ ...process.env, TMPDIR: fx.tmp, QK_LOCK_DIR: fx.locks, QK_MEM_GUARD: 'off', ...extra });
const lastJson = (s) => { try { return JSON.parse(s.trim().split('\n').filter(Boolean).pop()); } catch { return null; } };

// Start a process and resolve with its outcome; `child` is available immediately.
function start(script, fx, { env = envFor(fx), repo = fx.repo, base = fx.base, head = fx.head } = {}) {
  const t0 = Date.now();
  const child = spawn('node', [script, '--repo', repo, '--base', base, '--head', head], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  pids.push(child.pid);
  let stdout = '', stderr = '';
  child.stdout.on('data', (d) => { stdout += d; }); child.stderr.on('data', (d) => { stderr += d; });
  const done = new Promise((res) => child.on('close', (code, signal) => res({ code, signal, stdout, stderr, verdict: lastJson(stdout), elapsed: Date.now() - t0 })));
  return { child, done };
}
const run = (script, fx, opts) => start(script, fx, opts).done;
const dirEmpty = (d) => readdirSync(d).length === 0;
const gone = (pid, ms = 5000) => waitFor(() => !isAlive(pid), { timeoutMs: ms });
const noMarker = (m, ms = 2000) => waitFor(() => pgrepMarker(m).length === 0, { timeoutMs: ms });
const readPid = (file) => { try { const n = Number(readFileSync(file, 'utf8').trim()); return n > 0 ? n : 0; } catch { return 0; } };
// Wait until the grandchild recorded in `file` is alive; returns its pid.
async function grandchildUp(file) {
  const pid = await waitFor(() => { const p = readPid(file); return p && isAlive(p) ? p : 0; }, { timeoutMs: 20000 });
  assert.ok(pid, 'grandchild must be running');
  return pid;
}
const sideDir = () => { const d = mkdtempSync(join(tmpdir(), 'qk-side-')); roots.push(d); return d; };
// Commit a passing contract plus a new head on top of an existing fixture; returns the new pair.
function passingPair(fx) {
  fx.write('.quality-kernel/tools.json', JSON.stringify({ verify: 'exit 0', productionGlobs: ['src/**'] }));
  fx.git('add', '-A'); fx.git('commit', '-qm', 'passing contract');
  const base = fx.git('rev-parse', 'HEAD').stdout.trim();
  fx.write('src/code.mjs', 'export const f = () => 3;');
  fx.git('add', '-A'); fx.git('commit', '-qm', 'head2');
  return { base, head: fx.git('rev-parse', 'HEAD').stdout.trim() };
}
const ledgerLines = (fx) => { const f = join(fx.repo, '.quality-kernel', 'evidence-ledger.jsonl'); return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).length : 0; };

// ---------- A. Whole-tree termination ----------

for (const timeout of [1, 3]) {
  scenario(`a timed-out command's whole tree is killed and the verdict is INDETERMINATE [timeout ${timeout}]`, async () => {
    const m = mark(); const pf = join(sideDir(), 'pid');
    const fx = fixture({ tools: { verify: withPidFile(cmdSleeper(m), pf), timeoutSeconds: timeout } });
    const r = await run(REFEREE, fx);
    assert.strictEqual(r.code, 2);
    assert.match(r.verdict.reason, new RegExp(`timed out after ${timeout}s`));
    assert.match(r.verdict.reason, /process tree killed/);
    assert.ok(await noMarker(m), 'no process carries MARK within 2 seconds of the verdict');
    assert.ok(r.elapsed <= (timeout + 5 + 3) * 1000, `elapsed ${r.elapsed}`);
  });
}

scenario('a SIGTERM-ignoring member is killed after the 5000 ms grace', async () => {
  const m = mark(); const fx = fixture({ tools: { verify: `${cmdTermIgnorer(m)} & sleep 60`, timeoutSeconds: 2 } });
  const r = await run(REFEREE, fx);
  assert.strictEqual(r.code, 2);
  assert.match(r.verdict.reason, /timed out after 2s/);
  assert.deepStrictEqual(pgrepMarker(m), [], 'no process carries MARK at the verdict');
  assert.ok(r.elapsed >= (2 + 5) * 1000, `grace must be honored, elapsed ${r.elapsed}`);
  assert.ok(r.elapsed <= (2 + 5 + 3) * 1000, `elapsed ${r.elapsed}`);
});

scenario('exiting 0 during the grace period does not turn a timeout into PASS', async () => {
  const fx = fixture({ tools: { verify: "trap 'exit 0' TERM; sleep 30 & wait", timeoutSeconds: 1 } });
  const r = await run(REFEREE, fx);
  assert.strictEqual(r.code, 2);
  assert.match(r.verdict.reason, /timed out after 1s/);
});

for (const [status, refExit] of [[0, 0], [3, 1]]) {
  scenario(`stragglers are reaped after a command ends, without waiting for them [status ${status}]`, async () => {
    const m = mark(); const fx = fixture({ tools: { verify: `${cmdSleeper(m)} & exit ${status}` } });
    const r = await run(REFEREE, fx);
    assert.strictEqual(r.code, refExit);
    assert.deepStrictEqual(pgrepMarker(m), [], 'no process carries MARK at the moment the referee exits');
    assert.ok(r.elapsed < 15000, `elapsed ${r.elapsed}`);
  });
}

scenario('stragglers of "verifySetup" are reaped before "verify" starts', async () => {
  const m = mark();
  const fx = fixture({ tools: { verifySetup: `${cmdSleeper(m)} & exit 0`, verify: `if pgrep -f "[${m[0]}]${m.slice(1)}" >/dev/null; then exit 4; else exit 0; fi` } });
  const r = await run(REFEREE, fx);
  assert.strictEqual(r.code, 0, r.stdout);
});

scenario(`a descendant that left the process group is killed whether or not its environment is visible [node detached]`, async () => {
  // "verify" fails with exit 4 if the setup's escapee is still alive when it starts, so the kill must
  // happen at the end of the setup command, not merely when the referee exits.
  const m = mark();
  const fx = fixture({ tools: { verifySetup: `${cmdEscapee(m)}; exit 0`, verify: `if pgrep -f "[${m[0]}]${m.slice(1)}" >/dev/null; then exit 4; else exit 0; fi` } });
  const r = await run(REFEREE, fx);
  assert.strictEqual(r.code, 0, r.stdout);
  assert.ok(await noMarker(m, 3000), 'no process carries MARK');
});

// Apple platform binaries hide their environment from ps, so only descendant tracking can see them.
const cmdPerl = (m, escape) => `/usr/bin/perl -e 'use POSIX; sleep 1; ${escape}; sleep 60' ${m}`;
for (const [escape, ending, refExit] of [['setpgrp(0,0)', 'exits 0', 0], ['POSIX::setsid()', 'exits 0', 0], ['setpgrp(0,0)', 'timeout', 2], ['POSIX::setsid()', 'timeout', 2]]) {
  scenario(`a descendant that left the process group is killed whether or not its environment is visible [perl ${escape} ${ending}]`, async () => {
    const m = mark();
    const verify = ending === 'timeout' ? `${cmdPerl(m, escape)} & sleep 60` : `${cmdPerl(m, escape)} & sleep 2; exit 0`;
    const fx = fixture({ tools: { verify, ...(ending === 'timeout' ? { timeoutSeconds: 3 } : {}) } });
    const r = await run(REFEREE, fx);
    assert.strictEqual(r.code, refExit, r.stdout);
    assert.deepStrictEqual(pgrepMarker(m), [], 'no process carries MARK at the moment the referee exits');
  });
}

const cmdStubborn = (m) => `/usr/bin/perl -e 'sleep 1; setpgrp(0,0); $SIG{TERM}="IGNORE"; sleep 60' ${m}`;
scenario('a SIGTERM-ignoring descendant that left the group is SIGKILLed without grace', async () => {
  const m = mark(); const fx = fixture({ tools: { verify: `${cmdStubborn(m)} & sleep 60`, timeoutSeconds: 2 } });
  const r = await run(REFEREE, fx);
  assert.strictEqual(r.code, 2);
  assert.deepStrictEqual(pgrepMarker(m), []);
  assert.ok(r.elapsed <= (2 + 5 + 3) * 1000, `elapsed ${r.elapsed}`);
});

scenario('takeover kills a recorded tracked descendant that left the group, hides its environment and ignores SIGTERM', async () => {
  const pf = join(sideDir(), 'pid'); const m = mark();
  const fx = fixture({ tools: { verify: `${cmdStubborn(m)} & echo $! > ${pf}; sleep 60`, timeoutSeconds: 300 } });
  const first = start(REFEREE, fx);
  const perl = await grandchildUp(pf); pids.push(perl);
  const listed = () => readdirSync(fx.locks).some((f) => { try { return JSON.parse(readFileSync(join(fx.locks, f), 'utf8')).descendants.some((d) => d.pid === perl); } catch { return false; } });
  assert.ok(await waitFor(listed, { timeoutMs: 10000 }), 'the lock lists the perl process in "descendants"');
  first.child.kill('SIGKILL'); await first.done;
  assert.ok(isAlive(perl), 'the perl process outlives a SIGKILLed referee');
  const r = await run(REFEREE, fx, passingPair(fx));
  assert.strictEqual(r.code, 0, r.stdout);
  assert.ok(await gone(perl, 3000), 'the perl process is gone');
});

scenario('takeover never kills a pid whose start time differs from the recorded one', async () => {
  const fx = fixture();
  const unrelated = spawn('sleep', ['30'], { stdio: 'ignore' }); pids.push(unrelated.pid);
  const dead = spawnSync('node', ['-e', '0']).pid;
  writeFileSync(lockPathFor(fx.repo, fx.locks), JSON.stringify({ pid: dead, lstart: 'x', runId: '0123456789abcdef', repo: fx.repo, pgids: [], descendants: [{ pid: unrelated.pid, start: 'Thu Jan 1 00:00:00 1970' }] }));
  const r = await run(REFEREE, fx);
  assert.strictEqual(r.code, 0, r.stdout);
  assert.ok(isAlive(unrelated.pid), 'the unrelated process is still alive');
  unrelated.kill('SIGKILL');
});

scenario('every command sees one run marker per run and no NODE_TEST_CONTEXT', async () => {
  const w = join(sideDir(), 'witness');
  const rec = `printf '%s %s\\n' "$QK_RUN_ID" "\${NODE_TEST_CONTEXT-absent}" >> ${w}`;
  const fx = fixture({ tools: { verifySetup: rec, verify: rec, acceptance: rec } });
  const runs = [];
  for (let i = 0; i < 2; i++) {
    rmSync(w, { force: true });
    const r = await run(REFEREE, fx, { env: envFor(fx, { NODE_TEST_CONTEXT: 'child' }) });
    assert.strictEqual(r.code, 0, r.stdout);
    runs.push(readFileSync(w, 'utf8').trim().split('\n').map((l) => l.split(' ')));
  }
  for (const lines of runs) {
    assert.strictEqual(lines.length, 5, 'setup, verify, acceptance on the trusted tree + setup, verify on head');
    assert.strictEqual(new Set(lines.map((l) => l[0])).size, 1);
    assert.match(lines[0][0], /^[0-9a-f]{16}$/);
    for (const l of lines) assert.strictEqual(l[1], 'absent');
  }
  assert.notStrictEqual(runs[0][0][0], runs[1][0][0]);
});

for (const [bytes, stream, status, refExit] of [[3145728, 'stdout', 0, 0], [3145728, 'stderr', 0, 0], [1048577, 'both', 0, 0], [3145728, 'stdout', 3, 1]]) {
  scenario(`large output is classified by exit status only [${bytes} ${stream} ${status}]`, async () => {
    const out = stream === 'both' ? `${cmdBig('stdout', bytes)}; ${cmdBig('stderr', bytes)}` : cmdBig(stream, bytes);
    const fx = fixture({ tools: { verify: `${out}; exit ${status}` } });
    const r = await run(REFEREE, fx);
    assert.strictEqual(r.code, refExit, r.stdout.slice(-300));
    assert.ok(!('indeterminate' in r.verdict), 'the verdict has no "indeterminate" field');
  });
}

for (const [bytes, status, refExit, check] of [[0, 127, 2, /not executable \(exit 127\)/], [0, 126, 2, /not executable \(exit 126\)/], [3145728, 127, 1, null]]) {
  scenario(`exit 126/127 is "not executable" only when stdout is empty [${bytes} ${status}]`, async () => {
    const fx = fixture({ tools: { verify: `${bytes ? cmdBig('stdout', bytes) : 'true'}; exit ${status}` } });
    const r = await run(REFEREE, fx);
    assert.strictEqual(r.code, refExit);
    if (check) assert.match(r.verdict.reason, check); else assert.doesNotMatch(r.verdict.reason, /not executable/);
  });
}

scenario('a command killed by an external signal is INDETERMINATE "could not complete"', async () => {
  const fx = fixture({ tools: { verify: 'kill -9 $$' } });
  const r = await run(REFEREE, fx);
  assert.strictEqual(r.code, 2);
  assert.match(r.verdict.reason, /could not complete/);
});

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
  scenario(`a signal to the referee kills every tree and releases the lock [${signal}]`, async () => {
    const m = mark(); const pf = join(sideDir(), 'pid');
    const fx = fixture({ tools: { verify: withPidFile(cmdSleeper(m), pf), timeoutSeconds: 300 } });
    const { child, done } = start(REFEREE, fx);
    const gc = await grandchildUp(pf);
    child.kill(signal);
    const r = await Promise.race([done, new Promise((res) => setTimeout(() => res(null), 10000))]);
    assert.ok(r, 'the referee process ends within 10 seconds');
    assert.strictEqual(r.code, code);
    assert.doesNotMatch(r.stdout, /"pass":true/);
    assert.ok(await gone(gc), 'grandchild gone');
    assert.deepStrictEqual(pgrepMarker(m), []);
    assert.ok(dirEmpty(fx.locks), 'QK_LOCK_DIR is empty');
  });
}

async function gateSignalScenario(signal) {
  const m = mark(); const pf = join(sideDir(), 'pid');
  const fx = fixture({ tools: { verify: withPidFile(cmdSleeper(m), pf), timeoutSeconds: 300 } });
  const { child, done } = start(GATE, fx);
  const gc = await grandchildUp(pf);
  const ref = Number((spawnSync('pgrep', ['-P', String(child.pid)], { encoding: 'utf8' }).stdout.trim().split('\n')[0]));
  assert.ok(ref > 0, 'the referee is a child of the gate');
  pids.push(ref);
  const tKill = Date.now();
  child.kill(signal);
  await done;
  const limit = signal === 'SIGKILL' ? 5000 : 15000;
  assert.ok(await gone(ref, Math.max(0, limit - (Date.now() - tKill))), 'the referee is gone');
  assert.ok(await gone(gc, 2000), 'grandchild gone');
  assert.ok(await waitFor(() => dirEmpty(fx.locks), { timeoutMs: 1000 }), 'QK_LOCK_DIR is empty');
  assert.deepStrictEqual(pgrepMarker(m), []);
  assert.ok(Date.now() - tKill <= limit + 500, `took ${Date.now() - tKill} ms`);
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  scenario(`a signal to the gate kills the referee and every tree [${signal}]`, () => gateSignalScenario(signal));
}
scenario('SIGKILL of the gate is detected by the referee through parent death', () => gateSignalScenario('SIGKILL'));

// ---------- B. Configurable timeout ----------

for (const value of ['0', '-1', '1.5', '"5"', 'true', 'null', '3601', '99999']) {
  scenario(`an invalid timeoutSeconds is INDETERMINATE and runs nothing [${value}]`, async () => {
    const witness = join(sideDir(), 'witness');
    const raw = `{"verify":"touch ${witness}","productionGlobs":["src/**"],"timeoutSeconds":${value}}`;
    const fx = fixture({ toolsRaw: raw });
    const r = await run(REFEREE, fx);
    assert.strictEqual(r.code, 2);
    assert.match(r.verdict.reason, /timeoutSeconds/);
    assert.ok(!existsSync(witness), 'the witness file does not exist');
    assert.ok(dirEmpty(fx.tmp), 'TMPDIR is empty');
    assert.ok(dirEmpty(fx.locks), 'QK_LOCK_DIR is empty');
  });
}

for (const value of [1, 3600]) {
  scenario(`boundary values are accepted unchanged [${value}]`, async () => {
    const fx = fixture({ tools: { verify: 'exit 0', timeoutSeconds: value } });
    assert.strictEqual((await run(REFEREE, fx)).code, 0);
  });
}

scenario('the working tree and head cannot change the timeout', async () => {
  const fx = fixture({ tools: { verify: 'sleep 10', timeoutSeconds: 2 } });
  writeFileSync(join(fx.repo, '.quality-kernel', 'tools.json'), JSON.stringify({ verify: 'sleep 10', productionGlobs: ['src/**'], timeoutSeconds: 3600 }));
  const r = await run(REFEREE, fx);
  assert.match(r.verdict.reason, /timed out after 2s/);
});

scenario('each command has its own budget', async () => {
  const fx = fixture({ tools: { verifySetup: 'sleep 3', verify: 'sleep 3', timeoutSeconds: 4 } });
  assert.strictEqual((await run(REFEREE, fx)).code, 0);
});

// ---------- C. Pre-flight ----------

scenario('a live run on another worktree of the same repository blocks this run', async () => {
  const fxA = fixture({ tools: { verify: 'sleep 20' } });
  const wt = join(fxA.root, 'wt'); fxA.git('worktree', 'add', '-q', '--detach', wt, fxA.head);
  const tmpB = join(fxA.root, 'tmpB'); mkdirSync(tmpB);
  const a = start(REFEREE, fxA);
  assert.ok(await waitFor(() => readdirSync(fxA.locks).length === 1, { timeoutMs: 10000 }), 'A holds the lock');
  const lockFile = readdirSync(fxA.locks)[0];
  const r = await run(REFEREE, fxA, { repo: wt, env: envFor(fxA, { TMPDIR: tmpB }) });
  assert.strictEqual(r.code, 2);
  assert.match(r.verdict.reason, /another gate run is active/);
  assert.ok(r.verdict.reason.includes(String(a.child.pid)), 'the reason names the holder pid');
  assert.deepStrictEqual(readdirSync(fxA.locks), [lockFile], 'QK_LOCK_DIR contains only the holder\'s lock file');
  assert.ok(dirEmpty(tmpB), 'the refused run leaves its TMPDIR empty');
  a.child.kill('SIGTERM'); await a.done;
  assert.ok(dirEmpty(fxA.locks), 'the lock is released');
  assert.strictEqual((await run(REFEREE, fxA, { repo: wt, env: envFor(fxA, { TMPDIR: tmpB }) })).code, 0, 'a run on B now proceeds');
});

scenario('runs on different repositories do not block each other', async () => {
  const fx1 = fixture({ tools: { verify: 'sleep 20' } }); const fx2 = fixture();
  const a = start(REFEREE, fx1);
  assert.ok(await waitFor(() => readdirSync(fx1.locks).length === 1, { timeoutMs: 10000 }));
  const r = await run(REFEREE, fx2, { env: envFor(fx2, { QK_LOCK_DIR: fx1.locks }) });
  assert.strictEqual(r.code, 0, r.stdout);
  a.child.kill('SIGTERM'); await a.done;
});

for (const [outcome, tools, code] of [['PASS', { verify: 'exit 0' }, 0], ['FAIL', { verify: 'exit 5' }, 1], ['INDETERMINATE', { verify: 'exit 127' }, 2]]) {
  scenario(`the lock is released after every verdict kind [${outcome}]`, async () => {
    const fx = fixture({ tools });
    assert.strictEqual((await run(REFEREE, fx)).code, code);
    assert.ok(dirEmpty(fx.locks), 'QK_LOCK_DIR is empty');
  });
}

scenario('a lock whose holder pid does not exist is taken over and its processes swept', async () => {
  const m = mark(); const pf = join(sideDir(), 'pid');
  const fx = fixture({ tools: { verify: withPidFile(cmdSleeper(m), pf), timeoutSeconds: 300 } });
  const first = start(REFEREE, fx);
  const gc = await grandchildUp(pf);
  first.child.kill('SIGKILL'); await first.done;
  assert.ok(isAlive(gc), 'the grandchild outlives a SIGKILLed referee (documented residual risk 2)');
  assert.strictEqual(readdirSync(fx.locks).length, 1, 'the dead run left its lock behind');
  const pair = passingPair(fx);
  const r = await run(REFEREE, fx, pair);
  assert.strictEqual(r.code, 0, r.stdout);
  assert.ok(await gone(gc, 3000), 'the swept grandchild is gone');
  assert.deepStrictEqual(pgrepMarker(m), []);
});

scenario('PID reuse is treated as stale and the unrelated process is untouched', async () => {
  const fx = fixture();
  const unrelated = spawn('sleep', ['30'], { stdio: 'ignore' }); pids.push(unrelated.pid);
  writeFileSync(lockPathFor(fx.repo, fx.locks), JSON.stringify({ pid: unrelated.pid, lstart: 'Thu Jan  1 00:00:00 1970', runId: '0123456789abcdef', repo: fx.repo, pgids: [] }));
  const r = await run(REFEREE, fx);
  assert.strictEqual(r.code, 0, r.stdout);
  assert.ok(isAlive(unrelated.pid), 'the unrelated process is still alive');
  unrelated.kill('SIGKILL');
});

scenario('of two runs racing for a stale lock at most one proceeds', async () => {
  const fx = fixture({ tools: { verify: 'sleep 2' } });
  const dead = spawnSync('node', ['-e', '0']).pid;
  writeFileSync(lockPathFor(fx.repo, fx.locks), JSON.stringify({ pid: dead, lstart: processStart(process.pid), runId: '0123456789abcdef', repo: fx.repo, pgids: [] }));
  const rs = await Promise.all([run(REFEREE, fx), run(REFEREE, fx)]);
  assert.ok(rs.some((r) => r.code === 0), `codes ${rs.map((r) => r.code)}`);
  for (const r of rs.filter((x) => x.code !== 0)) {
    assert.strictEqual(r.code, 2);
    assert.match(r.verdict.reason, /another gate run is active/);
  }
});

const MAC = { skip: process.platform !== 'darwin' && 'macOS only' };
for (const [variable, value] of [['QK_MEM_MAX_PRESSURE_LEVEL', '1'], ['QK_MEM_MIN_LEVEL_PCT', '101']]) {
  test(`a breached macOS memory threshold refuses the run before any temp tree or lock exists [${variable}=${value}]`, { ...T, ...MAC }, async () => {
    const witness = join(sideDir(), 'witness');
    const fx = fixture({ tools: { verify: `touch ${witness}` } });
    const r = await run(REFEREE, fx, { env: envFor(fx, { QK_MEM_GUARD: undefined, [variable]: value }) });
    assert.strictEqual(r.code, 2);
    assert.match(r.verdict.reason, /memory pressure/);
    assert.ok(!existsSync(witness));
    assert.ok(dirEmpty(fx.tmp)); assert.ok(dirEmpty(fx.locks));
  });
}
for (const [variable, value] of [['QK_MEM_MAX_PRESSURE_LEVEL', '5'], ['QK_MEM_MIN_LEVEL_PCT', '0']]) {
  test(`thresholds the machine does not breach let the run proceed [${variable}=${value}]`, { ...T, ...MAC }, async () => {
    const fx = fixture();
    const r = await run(REFEREE, fx, { env: envFor(fx, { QK_MEM_GUARD: undefined, [variable]: value }) });
    assert.strictEqual(r.code, 0, r.stdout);
  });
}
test('QK_MEM_GUARD=off disables the guard', { ...T, ...MAC }, async () => {
  const fx = fixture();
  const r = await run(REFEREE, fx, { env: envFor(fx, { QK_MEM_MIN_LEVEL_PCT: '101', QK_MEM_GUARD: 'off' }) });
  assert.strictEqual(r.code, 0, r.stdout);
});

scenario('validation is checked before the memory guard, which is checked before the lock', async () => {
  const liveLock = (fx) => writeFileSync(lockPathFor(fx.repo, fx.locks), JSON.stringify({ pid: process.pid, lstart: processStart(process.pid), runId: '0123456789abcdef', repo: fx.repo, pgids: [] }));
  const bad = fixture({ toolsRaw: '{"verify":"exit 0","productionGlobs":["src/**"],"timeoutSeconds":0}' }); liveLock(bad);
  assert.match((await run(REFEREE, bad)).verdict.reason, /timeoutSeconds/);
  const plain = fixture(); liveLock(plain);
  const r = await run(REFEREE, plain);
  assert.strictEqual(r.code, 2);
  assert.match(r.verdict.reason, /another gate run is active/);
  if (process.platform === 'darwin') {
    const mem = fixture(); liveLock(mem);
    const m = await run(REFEREE, mem, { env: envFor(mem, { QK_MEM_GUARD: undefined, QK_MEM_MIN_LEVEL_PCT: '101' }) });
    assert.match(m.verdict.reason, /memory pressure/);
  }
});

scenario('takeover kills a recorded process group even when its members scrubbed the marker', async () => {
  const pf = join(sideDir(), 'pid');
  const fx = fixture({ tools: { verify: `env -i /bin/sleep 60 & echo $! > ${pf}; sleep 60`, timeoutSeconds: 300 } });
  const first = start(REFEREE, fx);
  const scrubbed = await grandchildUp(pf); pids.push(scrubbed);
  first.child.kill('SIGKILL'); await first.done;
  assert.ok(isAlive(scrubbed), 'the scrubbed grandchild outlives a SIGKILLed referee');
  const r = await run(REFEREE, fx, passingPair(fx));
  assert.strictEqual(r.code, 0, r.stdout);
  assert.ok(await gone(scrubbed, 3000), 'the scrubbed grandchild is gone');
});

// ---------- D. Unchanged behavior ----------

for (const [status, refExit] of [[0, 0], [5, 1]]) {
  scenario(`referee verdicts keep their exit codes and JSON shape [${status}]`, async () => {
    const fx = fixture({ tools: { verify: `exit ${status}` } });
    const r = await run(REFEREE, fx);
    assert.strictEqual(r.code, refExit);
    assert.strictEqual(r.stdout.trim().split('\n').length, 1, 'exactly one verdict line');
    assert.deepStrictEqual(Object.keys(r.verdict).sort(), ['evidence', 'pass', 'reason']);
    assert.deepStrictEqual(Object.keys(r.verdict.evidence).sort(), ['acceptance', 'acceptanceExit', 'base', 'head', 'headExit', 'overlaidTests', 'trustedExit', 'verify']);
  });
}

for (const [verify, critical, gateExit, gateName] of [['exit 0', false, 0, 'pass'], ['exit 5', false, 1, 'fail'], ['exit 127', false, 2, 'indeterminate'], ['exit 0', true, 3, 'blocked-needs-breaker']]) {
  scenario(`the gate keeps its exit codes and output keys [${gateName}]`, async () => {
    const fx = fixture({ tools: { verify }, critical });
    const r = await run(GATE, fx);
    assert.strictEqual(r.code, gateExit, r.stdout);
    assert.deepStrictEqual(Object.keys(r.verdict), ['gate', 'refereePass', 'tier', 'requiresBreaker', 'requiresHumanReview', 'referee', 'route', 'notes']);
    assert.strictEqual(r.verdict.gate, gateName);
  });
}

for (const [behavior, verify, timeoutSeconds, lines] of [['exits 0', 'exit 0', undefined, 1], ['exits 5', 'exit 5', undefined, 1], ['exceeds a 1 second timeout', 'sleep 10', 1, 0]]) {
  scenario(`the evidence ledger is appended only for PASS and FAIL [${behavior}]`, async () => {
    const fx = fixture({ tools: { verify, ...(timeoutSeconds ? { timeoutSeconds } : {}) } });
    const before = ledgerLines(fx);
    await run(REFEREE, fx);
    assert.strictEqual(ledgerLines(fx) - before, lines);
  });
}

// ---------- Trace: every feature scenario has a harness scenario ----------
test('trace — every Gherkin scenario title appears in this harness', () => {
  const titles = [...readFileSync(FEATURE, 'utf8').matchAll(/^\s*Scenario(?: Outline)?:\s*(.+?)\s*$/gm)].map((m) => m[1]);
  const self = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  assert.strictEqual(titles.length, 34);
  for (const t of titles) assert.ok(self.includes(t.replace(/'/g, "\\'")) || self.includes(t), `missing scenario: ${t}`);
});
