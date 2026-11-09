#!/usr/bin/env node
// QA probe — gate-process-tree (docs/specs/gate-process-tree/contract.md, "End-to-end QA procedure" and
// the INV-PT-* table). UI-ONLY: it drives `qk-gate.mjs` / `referee.mjs` as a user would, on throwaway
// fixture git repos under a scratch dir, and observes ONLY external state: exit codes, the stdout JSON
// verdict, stderr, the process table (`pgrep -f`, `kill -0`) and the files in QK_LOCK_DIR / TMPDIR.
// It never imports a production module. This script IS the live probe a blind breaker runs.
//
//   node scripts/qa/gate-process-tree-probe.mjs [--scenario <name>[,<name>...]|all] [--list] [--keep]
//
// Custom vector (for the breaker; every flag optional):
//   node scripts/qa/gate-process-tree-probe.mjs --scenario custom \
//     --entry gate|referee            launch qk-gate.mjs (default) or referee.mjs
//     --verify '<sh>'                 tools.json "verify"; placeholders {MARK} {SIDE} {PIDFILE}
//     --setup '<sh>' --acceptance '<sh>'   tools.json "verifySetup" / "acceptance" (same placeholders)
//     --timeout '<json literal>'      tools.json "timeoutSeconds" verbatim (e.g. 2, null, '"5"', 1.5)
//     --signal INT|TERM|HUP|KILL --target gate|referee --signal-when pidfile|<ms>
//     --lock none|live|stale-dead|stale-reuse   repository lock state before the run
//     --worktree                      run on a second `git worktree` of the fixture repo
//     --env K=V                       extra env for the run (repeatable), e.g. QK_MEM_MAX_PRESSURE_LEVEL=1
//     --expect-exit <n> --expect-reason <regex> --min-elapsed <s> --max-elapsed <s>
//   {MARK} is a fresh `qkpt_<uuid>` per vector and never appears in this probe's own argv; {PIDFILE}
//   is where a command should `echo $!` its grandchild so the probe can wait for it / signal after it.
//   Grandchildren must be short-lived (sleep <= 60 s). Every vector is cleaned (`pkill -9 -f MARK`).
//   Universal checks applied to every vector: no marker process within 2 s of the return, no referee
//   left for the fixture, QK_LOCK_DIR empty, TMPDIR empty, exit code and JSON keys per PT-D1..D3.
//
// Output: one JSON line per scenario {scenario, invariants, result, checks[]} then a summary line.
// Exit:  0 = every invariant HOLDS · 1 = a VIOLATED check · 2 = INSTRUMENT-BROKEN (fail-closed)

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir, devNull } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const GATE = join(here, '..', 'qk-gate.mjs');
const REFEREE = join(here, '..', 'referee.mjs');
const GATE_KEYS = ['gate', 'refereePass', 'tier', 'requiresBreaker', 'requiresHumanReview', 'referee', 'route', 'notes'];
const PASSFAIL_KEYS = ['pass', 'evidence', 'reason'];
const EVIDENCE_KEYS = ['verify', 'trustedExit', 'headExit', 'acceptance', 'acceptanceExit', 'base', 'head', 'overlaidTests'];
const INDET_KEYS = ['pass', 'indeterminate', 'evidence', 'reason'];
const SIGNO = { HUP: 1, INT: 2, KILL: 9, TERM: 15 };

// Fixture git (and the gate's git, which inherits it) ignores the operator's own git config, so a global
// excludesfile or hooksPath cannot change a fixture. Same pinning as scripts/hermetic-git.mjs, inlined
// because this probe is outside the test-file set the architecture gate exempts.
if (process.env.QK_HERMETIC_GIT !== '1') {
  const n = Number.parseInt(process.env.GIT_CONFIG_COUNT ?? '0', 10) || 0;
  Object.assign(process.env, {
    GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1', QK_HERMETIC_GIT: '1', GIT_CONFIG_COUNT: String(n + 2),
    [`GIT_CONFIG_KEY_${n}`]: 'core.excludesFile', [`GIT_CONFIG_VALUE_${n}`]: devNull,
    [`GIT_CONFIG_KEY_${n + 1}`]: 'core.attributesFile', [`GIT_CONFIG_VALUE_${n + 1}`]: devNull,
  });
}

// ---------- external observation helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pgrep = (pattern) => (spawnSync('pgrep', ['-f', pattern], { encoding: 'utf8' }).stdout || '').split('\n').filter(Boolean).map(Number);
const pkill9 = (pattern) => { spawnSync('pkill', ['-9', '-f', pattern]); };
// pid <= 0 would address a process GROUP (kill(0) = our own group), never a single process.
const alive = (pid) => { if (!(pid > 1)) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const lstartOf = (pid) => (spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).stdout || '').trim();
const pgidOf = (pid) => Number((spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).stdout || '').trim()) || 0;
const ls = (d) => (existsSync(d) ? readdirSync(d) : []);
const lastJson = (s) => { try { return JSON.parse(s.trim().split('\n').filter(Boolean).pop()); } catch { return null; } };
async function waitFor(pred, ms, step = 50) {
  const end = Date.now() + ms;
  let v = await pred();
  while (!v && Date.now() < end) { await sleep(step); v = await pred(); }
  return v;
}
const readPid = (f) => { try { const n = Number(readFileSync(f, 'utf8').trim()); return n > 0 ? n : 0; } catch { return 0; } };
const sameKeys = (o, keys) => !!o && typeof o === 'object' && Object.keys(o).sort().join() === [...keys].sort().join();
const sameStart = (a, b) => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();

// ---------- command builders (every grandchild sleeps <= 60 s and carries the marker) ----------
const marked = (m, secs = 60) => `node -e "setTimeout(()=>{},${secs * 1000})" ${m}`;
const termIgnorer = (m) => `node -e "process.on('SIGTERM',()=>{});setTimeout(()=>{},60000)" ${m}`;
const escapee = (m) => `node -e "require('child_process').spawn('node',['-e','setTimeout(()=>{},60000)','${m}'],{detached:true,stdio:'ignore'}).unref()"`;
// Apple platform binary: its environment is invisible to `ps` on macOS, so only descendant tracking sees it.
const perl = (m, escape) => `/usr/bin/perl -e 'use POSIX; sleep 1; ${escape}; sleep 60' ${m}`;
const big = (stream) => `node -e "process.${stream}.write('x'.repeat(3*1048576))"`;
const longRun = (m, pf) => `${marked(m)} & echo $! > ${pf}; sleep 60`;

// ---------- scenario context ----------
let scratchRoot;
class Ctx {
  constructor(name, invariants) {
    this.name = name; this.invariants = invariants; this.checks = []; this.broken = null;
    this.root = mkdtempSync(join(scratchRoot, `${name}-`));
    this.marks = []; this.pids = [];
  }
  mark() { const m = `qkpt_${randomUUID()}`; this.marks.push(m); return m; }
  dir(n) { const d = join(this.root, n); mkdirSync(d, { recursive: true }); return d; }
  check(name, ok, observed) { this.checks.push({ name, ok: !!ok, observed }); return !!ok; }
  instrument(cond, msg) { if (!cond) { this.broken = msg; throw new Error(`INSTRUMENT: ${msg}`); } }
  cleanup(keep) {
    // --keep leaves the vector's processes running for observation (they exit on their own, <= 60 s).
    if (!keep) {
      for (const m of this.marks) pkill9(m);
      for (const p of this.pids.filter((x) => x > 1)) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
    }
    const survivors = this.marks.flatMap((m) => pgrep(m));
    if (!keep) rmSync(this.root, { recursive: true, force: true });
    return survivors;
  }
}

// A fixture repo whose history is a list of {tools, src} commits; returns their SHAs. Each scenario pair
// (base = a commit setting tools.json, head = the next commit, a benign src edit) is "base..head".
function fixture(ctx, commits) {
  const repo = ctx.dir('repo');
  const git = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  const write = (p, c) => { mkdirSync(dirname(join(repo, p)), { recursive: true }); writeFileSync(join(repo, p), c); };
  git('init', '-q'); git('config', 'user.email', 'qa@qk'); git('config', 'user.name', 'qa');
  write('.quality-kernel/critical-surface.json', JSON.stringify({ criticalGlobs: ['**/auth/**'], safeGlobs: ['**/*.md'] }));
  const shas = [];
  commits.forEach((c, i) => {
    if (c.toolsRaw !== undefined) write('.quality-kernel/tools.json', c.toolsRaw);
    write('src/code.mjs', `export const f = () => ${i};\n`);
    git('add', '-A'); git('commit', '-qm', `c${i}`);
    shas.push(git('rev-parse', 'HEAD').stdout.trim());
  });
  ctx.instrument(shas.every((s) => /^[0-9a-f]{40}$/.test(s)), 'fixture commits failed');
  return { repo, git, write, shas };
}
// tools.json text; `timeoutRaw` is spliced verbatim so non-JSON-number literals reach the gate unchanged.
function tools({ verify, timeoutRaw, setup, acceptance }) {
  const parts = [`"verify": ${JSON.stringify(verify)}`, '"productionGlobs": ["src/**"]'];
  if (timeoutRaw !== undefined) parts.push(`"timeoutSeconds": ${timeoutRaw}`);
  if (setup) parts.push(`"verifySetup": ${JSON.stringify(setup)}`);
  if (acceptance) parts.push(`"acceptance": ${JSON.stringify(acceptance)}`);
  return `{ ${parts.join(', ')} }\n`;
}
// Pair helper: [base commit with tools.json, head commit with a src edit].
const pair = (t) => [{ toolsRaw: tools(t) }, {}];

function baseEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('QK_MEM_') || k === 'QK_RUN_ID' || k === 'NODE_TEST_CONTEXT') delete env[k];
  return { ...env, ...extra };
}

// Launch the gate or the referee; `child` is available immediately, `done` resolves with the outcome.
function launch(ctx, entry, { repo, base, head, tmp, locks, env = {} }) {
  const t0 = Date.now();
  const child = spawn('node', [entry === 'referee' ? REFEREE : GATE, '--repo', repo, '--base', base, '--head', head],
    { env: baseEnv({ TMPDIR: tmp, QK_LOCK_DIR: locks, ...env }), stdio: ['ignore', 'pipe', 'pipe'] });
  ctx.pids.push(child.pid);
  let stdout = '', stderr = '';
  child.stdout.on('data', (d) => { stdout += d; }); child.stderr.on('data', (d) => { stderr += d; });
  const done = new Promise((res) => child.on('close', (code, signal) => {
    res({ entry, code, signal, stdout, stderr: stderr.slice(-600), out: lastJson(stdout), elapsed: (Date.now() - t0) / 1000, endedAt: Date.now() });
  }));
  return { child, done };
}
const refereeOf = (repo) => pgrep(`referee.mjs --repo ${repo}`);
const reasonOf = (r) => (r.out ? (r.entry === 'gate' ? r.out.referee && r.out.referee.reason : r.out.reason) : null) || '';
const verdictOf = (r) => (r.out ? (r.entry === 'gate' ? r.out.referee : r.out) : null);

// PT-D1..D3 shape/exit checks on any completed run (INV-PT-19).
function shapeChecks(ctx, r) {
  if (r.entry === 'gate') {
    ctx.check('gate exit in {0,1,2,3} (PT-D3)', [0, 1, 2, 3].includes(r.code), r.code);
    ctx.check('gate output keys (PT-D3)', sameKeys(r.out, GATE_KEYS), r.out && Object.keys(r.out));
  } else {
    ctx.check('referee exit in {0,1,2} (PT-D1)', [0, 1, 2].includes(r.code), r.code);
  }
  const v = verdictOf(r);
  if (!v) return ctx.check('referee verdict JSON present', false, r.stdout.slice(-300));
  if (v.indeterminate) return ctx.check('INDETERMINATE shape (PT-D2)', sameKeys(v, INDET_KEYS) && v.pass === false && v.evidence === null, v);
  return ctx.check('PASS/FAIL shape (PT-D2)', sameKeys(v, PASSFAIL_KEYS) && sameKeys(v.evidence, EVIDENCE_KEYS), Object.keys(v));
}
async function noSurvivor(ctx, m, label, graceMs = 0) {
  const ok = await waitFor(() => pgrep(m).length === 0, graceMs);
  return ctx.check(label, ok, ok ? [] : pgrep(m));
}
const emptyDir = (ctx, d, label) => ctx.check(label, ls(d).length === 0, ls(d));

// Learn the repository's lock file name and payload the only way a user can: a verify command copies
// what it finds in $QK_LOCK_DIR while the run holds the lock.
async function discoverLock(ctx, fx, base, head, locks, tmp) {
  const r = await launch(ctx, 'gate', { repo: fx.repo, base, head, tmp, locks }).done;
  const side = ctx.dir('side-discover');
  const name = existsSync(join(side, 'name')) ? readFileSync(join(side, 'name'), 'utf8').trim() : '';
  let payload = null; try { payload = JSON.parse(readFileSync(join(side, 'lock.json'), 'utf8')); } catch { /* none */ }
  ctx.instrument(r.code === 0 && /^qk-gate-.*\.lock$/.test(name) && payload, `lock discovery failed (exit ${r.code}, name "${name}")`);
  return { name, payload };
}
const discoverVerify = (ctx) => { const s = ctx.dir('side-discover'); return `ls "$QK_LOCK_DIR" > ${s}/name; cat "$QK_LOCK_DIR"/qk-gate-*.lock > ${s}/lock.json`; };

// ---------- contract scenarios (QA procedure steps 1..15) ----------
const S = {};

S['timeout-tree'] = { inv: ['INV-PT-1', 'INV-PT-6', 'INV-PT-7', 'INV-PT-12', 'INV-PT-19'], step: 1, async run(ctx) {
  const m = ctx.mark(); const pf = join(ctx.dir('side'), 'pid'); const T = ctx.dir('tmp'), L = ctx.dir('locks');
  const fx = fixture(ctx, pair({ verify: longRun(m, pf), timeoutRaw: 2 }));
  const r = await launch(ctx, 'gate', { repo: fx.repo, base: fx.shas[0], head: fx.shas[1], tmp: T, locks: L }).done;
  ctx.check('exit 2', r.code === 2, r.code);
  ctx.check('reason matches /timed out after [0-9]+s.*process tree killed/', /timed out after 2s.*process tree killed/.test(reasonOf(r)), reasonOf(r));
  ctx.check('elapsed <= 2+5+3 s', r.elapsed <= 10, r.elapsed);
  await noSurvivor(ctx, m, 'no marker process within 2 s of the verdict', 2000);
  emptyDir(ctx, L, '$L empty'); emptyDir(ctx, T, '$T empty'); shapeChecks(ctx, r);
} };

S['term-ignorer'] = { inv: ['INV-PT-1', 'INV-PT-7'], step: 2, async run(ctx) {
  const m = ctx.mark(); const T = ctx.dir('tmp'), L = ctx.dir('locks');
  const fx = fixture(ctx, pair({ verify: `${termIgnorer(m)} & sleep 60`, timeoutRaw: 2 }));
  const r = await launch(ctx, 'gate', { repo: fx.repo, base: fx.shas[0], head: fx.shas[1], tmp: T, locks: L }).done;
  ctx.check('exit 2, reason "timed out after 2s"', r.code === 2 && /timed out after 2s/.test(reasonOf(r)), [r.code, reasonOf(r)]);
  ctx.check('elapsed >= 2+5 s (grace honored)', r.elapsed >= 7, r.elapsed);
  ctx.check('elapsed <= 2+5+3 s', r.elapsed <= 10, r.elapsed);
  await noSurvivor(ctx, m, 'no marker process at the verdict');
  emptyDir(ctx, L, '$L empty'); shapeChecks(ctx, r);
} };

S['straggler'] = { inv: ['INV-PT-2', 'INV-PT-12'], step: 3, async run(ctx) {
  const m = ctx.mark(); const T = ctx.dir('tmp'), L = ctx.dir('locks');
  const fx = fixture(ctx, pair({ verify: `${marked(m)} & exit 0` }));
  const r = await launch(ctx, 'gate', { repo: fx.repo, base: fx.shas[0], head: fx.shas[1], tmp: T, locks: L }).done;
  ctx.check('gate pass, exit 0', r.code === 0 && r.out && r.out.gate === 'pass', [r.code, r.out && r.out.gate, reasonOf(r)]);
  ctx.check('elapsed < 15 s (not 60)', r.elapsed < 15, r.elapsed);
  await noSurvivor(ctx, m, 'no marker process immediately after gate exit');
  emptyDir(ctx, L, '$L empty'); emptyDir(ctx, T, '$T empty'); shapeChecks(ctx, r);
} };

S['escapee'] = { inv: ['INV-PT-3'], step: 4, async run(ctx) {
  const m = ctx.mark(); const T = ctx.dir('tmp'), L = ctx.dir('locks');
  const fx = fixture(ctx, pair({ verify: `${escapee(m)}; exit 0` }));
  const r = await launch(ctx, 'gate', { repo: fx.repo, base: fx.shas[0], head: fx.shas[1], tmp: T, locks: L }).done;
  ctx.check('gate pass, exit 0', r.code === 0, [r.code, reasonOf(r)]);
  await noSurvivor(ctx, m, 'no new-session marker process after gate returns');
  shapeChecks(ctx, r);
} };

S['platform-escapee'] = { inv: ['INV-PT-1', 'INV-PT-3'], step: '4b', async run(ctx) {
  const cases = [
    { label: 'perl setpgrp(0,0), verify exits 0', escape: 'setpgrp(0,0)', tail: 'sleep 2; exit 0', code: 0 },
    { label: 'perl POSIX::setsid(), verify exits 0', escape: 'POSIX::setsid()', tail: 'sleep 2; exit 0', code: 0 },
    { label: 'perl setpgrp(0,0), 3 s timeout', escape: 'setpgrp(0,0)', tail: 'sleep 60', code: 2, timeout: 3 },
    { label: 'perl POSIX::setsid(), 3 s timeout', escape: 'POSIX::setsid()', tail: 'sleep 60', code: 2, timeout: 3 },
  ];
  for (const c of cases) {
    const m = ctx.mark(); const T = ctx.dir('tmp'), L = ctx.dir('locks');
    const fx = fixture(ctx, pair({ verify: `${perl(m, c.escape)} & ${c.tail}`, timeoutRaw: c.timeout }));
    const r = await launch(ctx, 'gate', { repo: fx.repo, base: fx.shas[0], head: fx.shas[1], tmp: T, locks: L }).done;
    ctx.check(`${c.label}: exit ${c.code}`, r.code === c.code, [r.code, reasonOf(r)]);
    await noSurvivor(ctx, m, `${c.label}: no marker process after the gate returns`);
    emptyDir(ctx, L, `${c.label}: $L empty`); shapeChecks(ctx, r);
  }
} };

S['large-output'] = { inv: ['INV-PT-17', 'INV-PT-19'], step: 5, async run(ctx) {
  const cases = [
    { label: '3 MiB stdout, exit 0', verify: `${big('stdout')}; exit 0`, code: 0, pass: true },
    { label: '3 MiB stderr, exit 0', verify: `${big('stderr')}; exit 0`, code: 0, pass: true },
    { label: '3 MiB stdout+stderr, exit 3', verify: `${big('stdout')}; ${big('stderr')}; exit 3`, code: 1, pass: false },
    { label: '3 MiB stdout, exit 127', verify: `${big('stdout')}; exit 127`, code: 1, pass: false },
  ];
  for (const c of cases) {
    const sub = new Ctx(`${ctx.name}-sub`, []); sub.root = ctx.dir(`c${cases.indexOf(c)}`);
    const T = sub.dir('tmp'), L = sub.dir('locks');
    const fx = fixture(sub, pair({ verify: c.verify }));
    const r = await launch(ctx, 'gate', { repo: fx.repo, base: fx.shas[0], head: fx.shas[1], tmp: T, locks: L }).done;
    const v = verdictOf(r);
    ctx.check(`${c.label}: gate exit ${c.code}, referee.pass ${c.pass}, not indeterminate, not "not executable"`,
      r.code === c.code && v && v.pass === c.pass && !v.indeterminate && !/not executable/.test(reasonOf(r)), [r.code, v && v.pass, v && v.indeterminate, reasonOf(r)]);
    shapeChecks(ctx, r);
  }
} };

async function gateKilled(ctx, sig, withinS) {
  const m = ctx.mark(); const pf = join(ctx.dir('side'), 'pid'); const T = ctx.dir('tmp'), L = ctx.dir('locks');
  const fx = fixture(ctx, pair({ verify: longRun(m, pf), timeoutRaw: 300 }));
  const { child, done } = launch(ctx, 'gate', { repo: fx.repo, base: fx.shas[0], head: fx.shas[1], tmp: T, locks: L });
  ctx.instrument(await waitFor(() => readPid(pf) && alive(readPid(pf)), 20000), 'grandchild never started');
  const ref = refereeOf(fx.repo); ctx.instrument(ref.length === 1, `referee not uniquely found: ${ref}`);
  ctx.check('lock file present while running', ls(L).length === 1, ls(L));
  const t0 = Date.now(); process.kill(child.pid, `SIG${sig}`);
  const r = await done;
  const clean = await waitFor(() => pgrep(m).length === 0 && !alive(ref[0]) && ls(L).length === 0, withinS * 1000);
  const took = (Date.now() - t0) / 1000;
  ctx.check(`no marker, no referee, no lock within ${withinS} s of SIG${sig} to the gate`, clean, { took, marker: pgrep(m), referee: alive(ref[0]), locks: ls(L) });
  if (sig !== 'KILL') ctx.check('gate exit non-zero', r.code !== 0, [r.code, r.signal]);
  emptyDir(ctx, T, '$T empty');
}
S['gate-sigterm'] = { inv: ['INV-PT-5'], step: '6a', run: (ctx) => gateKilled(ctx, 'TERM', 15) };
S['gate-sigkill'] = { inv: ['INV-PT-5'], step: '6b', run: (ctx) => gateKilled(ctx, 'KILL', 5) };

async function refereeSignal(ctx, sig) {
  const m = ctx.mark(); const pf = join(ctx.dir('side'), 'pid'); const T = ctx.dir('tmp'), L = ctx.dir('locks');
  const fx = fixture(ctx, pair({ verify: longRun(m, pf), timeoutRaw: 300 }));
  const { child, done } = launch(ctx, 'referee', { repo: fx.repo, base: fx.shas[0], head: fx.shas[1], tmp: T, locks: L });
  ctx.instrument(await waitFor(() => readPid(pf) && alive(readPid(pf)), 20000), 'grandchild never started');
  process.kill(child.pid, `SIG${sig}`);
  const r = await done;
  ctx.check(`referee exit ${128 + SIGNO[sig]} on SIG${sig}`, r.code === 128 + SIGNO[sig], [r.code, r.signal]);
  ctx.check('no PASS output', !(r.out && r.out.pass === true), r.stdout.slice(-200));
  await noSurvivor(ctx, m, 'no marker process');
  ctx.check('referee not alive', !alive(child.pid), child.pid);
  emptyDir(ctx, L, '$L empty (lock released)'); emptyDir(ctx, T, '$T empty');
}
S['referee-sigint'] = { inv: ['INV-PT-4', 'INV-PT-12'], step: '7-INT', run: (ctx) => refereeSignal(ctx, 'INT') };
S['referee-sigterm'] = { inv: ['INV-PT-4', 'INV-PT-12'], step: '7-TERM', run: (ctx) => refereeSignal(ctx, 'TERM') };
S['referee-sighup'] = { inv: ['INV-PT-4', 'INV-PT-12'], step: '7-HUP', run: (ctx) => refereeSignal(ctx, 'HUP') };

S['lock-takeover'] = { inv: ['INV-PT-13'], step: 8, async run(ctx) {
  const m = ctx.mark(); const side = ctx.dir('side'); const pf = join(side, 'pid'), ps = join(side, 'scrubbed');
  const T = ctx.dir('tmp'), L = ctx.dir('locks');
  const verify = `${marked(m)} & echo $! > ${pf}; env -i /bin/sleep 60 & echo $! > ${ps}; sleep 60`;
  const fx = fixture(ctx, [...pair({ verify, timeoutRaw: 300 }), ...pair({ verify: 'exit 0' })]);
  const { child, done } = launch(ctx, 'referee', { repo: fx.repo, base: fx.shas[0], head: fx.shas[1], tmp: T, locks: L });
  ctx.instrument(await waitFor(() => alive(readPid(pf)) && alive(readPid(ps)), 20000), 'grandchildren never started');
  const scrubbed = readPid(ps); ctx.pids.push(scrubbed);
  process.kill(child.pid, 'SIGKILL'); await done;
  await sleep(1500);
  ctx.check('residual risk 2 documented: both grandchildren alive after referee SIGKILL', pgrep(m).length > 0 && alive(scrubbed), { marker: pgrep(m), scrubbed: alive(scrubbed) });
  const stale = ls(L).map((f) => { try { return JSON.parse(readFileSync(join(L, f), 'utf8')); } catch { return f; } });
  ctx.check('stale lock left in $L', stale.length === 1, { stale, probePgid: pgidOf(process.pid), refereePid: child.pid });
  const r = await launch(ctx, 'gate', { repo: fx.repo, base: fx.shas[2], head: fx.shas[3], tmp: ctx.dir('tmp2'), locks: L }).done;
  ctx.check('next run proceeds: gate pass', r.code === 0 && r.out && r.out.gate === 'pass', [r.code, reasonOf(r)]);
  ctx.check('marker grandchild gone', pgrep(m).length === 0, pgrep(m));
  ctx.check('scrubbed-env grandchild (recorded pgid) gone', !alive(scrubbed), scrubbed);
  emptyDir(ctx, L, '$L empty'); shapeChecks(ctx, r);
} };

// V-K: the referee is SIGKILLed while a tracked platform-binary descendant (left its group, ignores TERM)
// is alive; the NEXT run must still find it through the descendants recorded in the lock (PT-A18, PT-C4).
S['takeover-descendant'] = { inv: ['INV-PT-13'], step: '8b', async run(ctx) {
  const m = ctx.mark(); const side = ctx.dir('side'); const pf = join(side, 'pid');
  const T = ctx.dir('tmp'), L = ctx.dir('locks');
  const stubborn = `/usr/bin/perl -e 'sleep 1; setpgrp(0,0); $SIG{TERM}="IGNORE"; sleep 60' ${m}`;
  const fx = fixture(ctx, [...pair({ verify: `${stubborn} & echo $! > ${pf}; sleep 60`, timeoutRaw: 300 }), ...pair({ verify: 'exit 0' })]);
  const { child, done } = launch(ctx, 'referee', { repo: fx.repo, base: fx.shas[0], head: fx.shas[1], tmp: T, locks: L });
  ctx.instrument(await waitFor(() => alive(readPid(pf)), 20000), 'perl never started');
  const perlPid = readPid(pf); ctx.pids.push(perlPid);
  const listed = () => ls(L).some((f) => { try { return JSON.parse(readFileSync(join(L, f), 'utf8')).descendants.some((d) => d.pid === perlPid); } catch { return false; } });
  await sleep(2000);                                       // attached for 1 s, then setpgrp, then at least one more snapshot
  ctx.check('the lock lists the perl process in descendants before the kill', await waitFor(listed, 3000), ls(L));
  process.kill(child.pid, 'SIGKILL'); await done;
  await sleep(500);
  ctx.check('residual risk 2 documented: perl alive after referee SIGKILL', alive(perlPid), perlPid);
  const r = await launch(ctx, 'gate', { repo: fx.repo, base: fx.shas[2], head: fx.shas[3], tmp: ctx.dir('tmp2'), locks: L }).done;
  ctx.check('next run proceeds: gate pass', r.code === 0 && r.out && r.out.gate === 'pass', [r.code, reasonOf(r)]);
  ctx.check('perl descendant gone after the takeover', await waitFor(() => !alive(perlPid), 2000), perlPid);
  await noSurvivor(ctx, m, 'no marker process after the next run');
  emptyDir(ctx, L, '$L empty'); shapeChecks(ctx, r);
} };

S['lock-pid-reuse'] = { inv: ['INV-PT-14'], step: 9, async run(ctx) {
  const T = ctx.dir('tmp'), L = ctx.dir('locks');
  const fx = fixture(ctx, [...pair({ verify: discoverVerify(ctx) }), ...pair({ verify: 'exit 0' })]);
  const lock = await discoverLock(ctx, fx, fx.shas[0], fx.shas[1], L, T);
  ctx.check('discovered lock payload keys {pid,lstart,runId,repo,pgids,descendants}', sameKeys(lock.payload, ['pid', 'lstart', 'runId', 'repo', 'pgids', 'descendants']), lock.payload);
  ctx.check('$L empty after the discovery run', ls(L).length === 0, ls(L));
  const unrelated = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' }); unrelated.unref(); ctx.pids.push(unrelated.pid);
  await sleep(200);
  const wrong = typeof lock.payload.lstart === 'number' ? 1 : 'Thu Jan  1 00:00:00 1970';
  writeFileSync(join(L, lock.name), JSON.stringify({ ...lock.payload, pid: unrelated.pid, lstart: wrong, runId: randomBytes(8).toString('hex'), pgids: [] }));
  const r = await launch(ctx, 'gate', { repo: fx.repo, base: fx.shas[2], head: fx.shas[3], tmp: T, locks: L }).done;
  ctx.check('gate proceeds: pass', r.code === 0 && r.out && r.out.gate === 'pass', [r.code, reasonOf(r)]);
  ctx.check('unrelated process still alive', alive(unrelated.pid), unrelated.pid);
  emptyDir(ctx, L, '$L empty');
} };

S['lock-live-worktree'] = { inv: ['INV-PT-11', 'INV-PT-12'], step: 10, async run(ctx) {
  const m = ctx.mark(); const pf = join(ctx.dir('side'), 'pid'); const L = ctx.dir('locks');
  const fx = fixture(ctx, [...pair({ verify: longRun(m, pf), timeoutRaw: 300 }), ...pair({ verify: 'exit 0' })]);
  const wtB = join(ctx.root, 'wtB');
  ctx.instrument(fx.git('worktree', 'add', '-q', '--detach', wtB, fx.shas[3]).status === 0, 'git worktree add failed');
  const A = launch(ctx, 'gate', { repo: fx.repo, base: fx.shas[0], head: fx.shas[1], tmp: ctx.dir('tmpA'), locks: L });
  ctx.instrument(await waitFor(() => readPid(pf) && alive(readPid(pf)), 20000), 'run A grandchild never started');
  const holder = refereeOf(fx.repo); ctx.instrument(holder.length === 1, `holder referee not found: ${holder}`);
  const lockName = ls(L)[0]; let payload = {}; try { payload = JSON.parse(readFileSync(join(L, lockName), 'utf8')); } catch { /* checked below */ }
  const TB = ctx.dir('tmpB');
  const rB = await launch(ctx, 'gate', { repo: wtB, base: fx.shas[0], head: fx.shas[1], tmp: TB, locks: L }).done;
  const reason = reasonOf(rB);
  ctx.check('B exits 2 with "another gate run is active"', rB.code === 2 && /another gate run is active/.test(reason), [rB.code, reason]);
  ctx.check('reason names the holder pid', reason.includes(String(holder[0])), { holder: holder[0], reason });
  ctx.check('reason names the holder start time (= ps lstart)', !!payload.lstart && reason.includes(String(payload.lstart)) && sameStart(String(payload.lstart), lstartOf(holder[0])), { lock: payload.lstart, ps: lstartOf(holder[0]) });
  ctx.check('$L holds only the holder lock', ls(L).length === 1 && ls(L)[0] === lockName && payload.pid === holder[0], ls(L));
  emptyDir(ctx, TB, '$T (B) empty'); shapeChecks(ctx, rB);
  process.kill(A.child.pid, 'SIGTERM'); await A.done;
  ctx.check('$L empty after A ends', await waitFor(() => ls(L).length === 0, 5000), ls(L));
  const rB2 = await launch(ctx, 'gate', { repo: wtB, base: fx.shas[2], head: fx.shas[3], tmp: TB, locks: L }).done;
  ctx.check('B now proceeds: pass', rB2.code === 0, [rB2.code, reasonOf(rB2)]);
  await noSurvivor(ctx, m, 'no marker process');
  emptyDir(ctx, L, '$L empty at end');
} };

S['timeout-validation'] = { inv: ['INV-PT-8', 'INV-PT-9', 'INV-PT-12'], step: 11, async run(ctx) {
  const invalid = ['0', '-1', '1.5', '"5"', 'true', 'null', '14401', '99999'];
  for (const [i, raw] of [...invalid, '1', '14400'].entries()) {
    const sub = new Ctx(`${ctx.name}-sub`, []); sub.root = ctx.dir(`v${i}`);
    const m = ctx.mark(); const w = join(sub.dir('side'), 'witness'); const T = sub.dir('tmp'), L = sub.dir('locks');
    const ok = !invalid.includes(raw);
    const fx = fixture(sub, pair({ verify: ok ? 'exit 0' : `touch ${w}; ${marked(m, 5)}`, timeoutRaw: raw }));
    const r = await launch(ctx, 'gate', { repo: fx.repo, base: fx.shas[0], head: fx.shas[1], tmp: T, locks: L }).done;
    if (ok) ctx.check(`timeoutSeconds ${raw}: accepted, exit 0`, r.code === 0, [r.code, reasonOf(r)]);
    else {
      ctx.check(`timeoutSeconds ${raw}: exit 2, reason contains "timeoutSeconds"`, r.code === 2 && reasonOf(r).includes('timeoutSeconds'), [r.code, reasonOf(r)]);
      ctx.check(`timeoutSeconds ${raw}: no witness, no marker process`, !existsSync(w) && pgrep(m).length === 0, { witness: existsSync(w) });
    }
    ctx.check(`timeoutSeconds ${raw}: $T and $L empty`, ls(T).length === 0 && ls(L).length === 0, { T: ls(T), L: ls(L) });
    shapeChecks(ctx, r);
  }
} };

S['timeout-source'] = { inv: ['INV-PT-10'], step: 12, async run(ctx) {
  const m = ctx.mark(); const T = ctx.dir('tmp'), L = ctx.dir('locks');
  const verify = `${marked(m, 10)}`;
  const fx = fixture(ctx, pair({ verify, timeoutRaw: 2 }));
  fx.write('.quality-kernel/tools.json', tools({ verify, timeoutRaw: 14400 })); // uncommitted working-tree edit
  ctx.instrument(fx.git('status', '--porcelain').stdout.includes('tools.json'), 'working-tree edit not visible to git');
  const r = await launch(ctx, 'gate', { repo: fx.repo, base: fx.shas[0], head: fx.shas[1], tmp: T, locks: L }).done;
  ctx.check('base timeout applies: exit 2, "timed out after 2s"', r.code === 2 && /timed out after 2s/.test(reasonOf(r)), [r.code, reasonOf(r)]);
  ctx.check('elapsed <= 2+5+3 s', r.elapsed <= 10, r.elapsed);
  await noSurvivor(ctx, m, 'no marker process', 2000);
} };

S['memory-guard'] = { inv: ['INV-PT-15'], step: 13, async run(ctx) {
  if (process.platform !== 'darwin') return ctx.check('skipped: macOS only (unit tests cover Linux)', true, process.platform);
  const level = Number(spawnSync('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], { encoding: 'utf8' }).stdout);
  ctx.instrument(level === 1, `machine pressure level is ${level}; the procedure assumes a normal machine (1)`);
  for (const [k, v] of [['QK_MEM_MAX_PRESSURE_LEVEL', '1'], ['QK_MEM_MIN_LEVEL_PCT', '101']]) {
    const sub = new Ctx(`${ctx.name}-sub`, []); sub.root = ctx.dir(k);
    const T = sub.dir('tmp'), L = sub.dir('locks');
    const fx = fixture(sub, pair({ verify: 'exit 0' }));
    const at = { repo: fx.repo, base: fx.shas[0], head: fx.shas[1], tmp: T, locks: L };
    const r = await launch(ctx, 'gate', { ...at, env: { [k]: v } }).done;
    ctx.check(`${k}=${v}: exit 2, "memory pressure"`, r.code === 2 && /memory pressure/.test(reasonOf(r)), [r.code, reasonOf(r)]);
    ctx.check(`${k}=${v}: $T and $L empty`, ls(T).length === 0 && ls(L).length === 0, { T: ls(T), L: ls(L) });
    const r2 = await launch(ctx, 'gate', { ...at, env: { [k]: v, QK_MEM_GUARD: 'off' } }).done;
    ctx.check(`${k}=${v} + QK_MEM_GUARD=off: proceeds (exit 0)`, r2.code === 0, [r2.code, reasonOf(r2)]);
    shapeChecks(ctx, r); shapeChecks(ctx, r2);
  }
} };

S['env-marker'] = { inv: ['INV-PT-18'], step: 14, async run(ctx) {
  const w = join(ctx.dir('side'), 'env.txt'); const T = ctx.dir('tmp'), L = ctx.dir('locks');
  const rec = (who) => `echo "${who} $QK_RUN_ID \${NODE_TEST_CONTEXT-absent}" >> ${w}`;
  const fx = fixture(ctx, pair({ verify: rec('verify'), setup: rec('setup'), acceptance: rec('acceptance') }));
  const runs = [];
  for (let i = 0; i < 2; i++) {
    const before = existsSync(w) ? readFileSync(w, 'utf8').split('\n').filter(Boolean).length : 0;
    const r = await launch(ctx, 'gate', { repo: fx.repo, base: fx.shas[0], head: fx.shas[1], tmp: T, locks: L, env: { NODE_TEST_CONTEXT: 'child-v8' } }).done;
    ctx.check(`run ${i + 1}: exit 0`, r.code === 0, [r.code, reasonOf(r)]);
    runs.push(readFileSync(w, 'utf8').split('\n').filter(Boolean).slice(before).map((l) => l.split(' ')));
  }
  for (const [i, lines] of runs.entries()) {
    const who = new Set(lines.map((l) => l[0])); const ids = new Set(lines.map((l) => l[1]));
    ctx.check(`run ${i + 1}: setup, verify and acceptance all recorded`, ['setup', 'verify', 'acceptance'].every((x) => who.has(x)), lines);
    ctx.check(`run ${i + 1}: one QK_RUN_ID of 16 lowercase hex`, ids.size === 1 && /^[0-9a-f]{16}$/.test([...ids][0]), [...ids]);
    ctx.check(`run ${i + 1}: NODE_TEST_CONTEXT absent`, lines.every((l) => l[2] === 'absent'), lines.map((l) => l[2]));
  }
  ctx.check('QK_RUN_ID differs across runs', runs[0][0] && runs[1][0] && runs[0][0][1] !== runs[1][0][1], [runs[0][0]?.[1], runs[1][0]?.[1]]);
} };

S['preflight-order'] = { inv: ['INV-PT-11', 'INV-PT-15'], step: 15, async run(ctx) {
  const m = ctx.mark(); const pf = join(ctx.dir('side'), 'pid'); const L = ctx.dir('locks');
  const fx = fixture(ctx, [...pair({ verify: longRun(m, pf), timeoutRaw: 300 }), ...pair({ verify: 'exit 0', timeoutRaw: 0 }), ...pair({ verify: 'exit 0' })]);
  const A = launch(ctx, 'gate', { repo: fx.repo, base: fx.shas[0], head: fx.shas[1], tmp: ctx.dir('tmpA'), locks: L });
  ctx.instrument(await waitFor(() => readPid(pf) && alive(readPid(pf)), 20000), 'lock holder never started');
  const T1 = ctx.dir('tmp1');
  const r1 = await launch(ctx, 'gate', { repo: fx.repo, base: fx.shas[2], head: fx.shas[3], tmp: T1, locks: L }).done;
  ctx.check('live lock + invalid timeoutSeconds: reason is timeoutSeconds, not the lock', r1.code === 2 && reasonOf(r1).includes('timeoutSeconds') && !/another gate run/.test(reasonOf(r1)), reasonOf(r1));
  if (process.platform === 'darwin') {
    const r2 = await launch(ctx, 'gate', { repo: fx.repo, base: fx.shas[4], head: fx.shas[5], tmp: ctx.dir('tmp2'), locks: L, env: { QK_MEM_MAX_PRESSURE_LEVEL: '1' } }).done;
    ctx.check('live lock + QK_MEM_MAX_PRESSURE_LEVEL=1: reason is memory pressure, not the lock', r2.code === 2 && /memory pressure/.test(reasonOf(r2)) && !/another gate run/.test(reasonOf(r2)), reasonOf(r2));
  }
  ctx.check('$L holds only the holder lock', ls(L).length === 1, ls(L));
  emptyDir(ctx, T1, '$T empty');
  process.kill(A.child.pid, 'SIGTERM'); await A.done;
  ctx.check('$L empty after the holder ends', await waitFor(() => ls(L).length === 0, 5000), ls(L));
  await noSurvivor(ctx, m, 'no marker process', 2000);
} };

// ---------- custom vector (breaker-fed) ----------
S['custom'] = { inv: ['INV-PT-1', 'INV-PT-4', 'INV-PT-5', 'INV-PT-12', 'INV-PT-19'], step: 'custom', async run(ctx, o) {
  const m = ctx.mark(); const side = ctx.dir('side'); const pf = join(side, 'pid');
  const T = ctx.dir('tmp'), L = ctx.dir('locks');
  const sub = (s) => s && s.replaceAll('{MARK}', m).replaceAll('{SIDE}', side).replaceAll('{PIDFILE}', pf);
  const t = { verify: sub(o.verify) || 'exit 0', timeoutRaw: o.timeout, setup: sub(o.setup), acceptance: sub(o.acceptance) };
  const hm = ctx.mark(); const hpf = join(side, 'holder-pid');
  const fx = fixture(ctx, [...pair(t), ...pair({ verify: longRun(hm, hpf), timeoutRaw: 300 }), ...pair({ verify: discoverVerify(ctx) })]);
  let repo = fx.repo;
  if (o.worktree) { repo = join(ctx.root, 'wt'); ctx.instrument(fx.git('worktree', 'add', '-q', '--detach', repo, fx.shas[1]).status === 0, 'worktree add failed'); }
  let holder = null;
  if (o.lock === 'live') {
    holder = launch(ctx, 'gate', { repo: fx.repo, base: fx.shas[2], head: fx.shas[3], tmp: ctx.dir('tmpH'), locks: L });
    ctx.instrument(await waitFor(() => readPid(hpf) && alive(readPid(hpf)), 20000), 'lock holder never started');
  } else if (o.lock === 'stale-dead' || o.lock === 'stale-reuse') {
    const lock = await discoverLock(ctx, fx, fx.shas[4], fx.shas[5], L, ctx.dir('tmpD'));
    let pid;
    if (o.lock === 'stale-dead') { const d = spawnSync('sh', ['-c', 'echo $$']); pid = Number(String(d.stdout).trim()); }
    else { const u = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' }); u.unref(); ctx.pids.push(u.pid); pid = u.pid; ctx.unrelated = pid; }
    writeFileSync(join(L, lock.name), JSON.stringify({ ...lock.payload, pid, lstart: 'Thu Jan  1 00:00:00 1970', runId: randomBytes(8).toString('hex'), pgids: [] }));
  }
  const { child, done } = launch(ctx, o.entry, { repo, base: fx.shas[0], head: fx.shas[1], tmp: T, locks: L, env: o.env });
  let refPid = o.entry === 'referee' ? child.pid : null;
  if (o.signal) {
    if (o.signalWhen === 'pidfile') ctx.instrument(await waitFor(() => readPid(pf) && alive(readPid(pf)), 20000), 'verify never wrote {PIDFILE}');
    else await sleep(Number(o.signalWhen) || 0);
    if (!refPid) refPid = refereeOf(repo)[0] || null;
    const target = o.target === 'referee' ? refPid : child.pid;
    ctx.instrument(target, `signal target ${o.target} not found`);
    process.kill(target, `SIG${o.signal}`);
  }
  const r = await done;
  if (holder) { process.kill(holder.child.pid, 'SIGTERM'); await holder.done; }
  if (o.expectExit !== undefined) ctx.check(`exit ${o.expectExit}`, r.code === Number(o.expectExit), [r.code, r.signal]);
  if (o.expectReason) ctx.check(`reason ~ /${o.expectReason}/`, new RegExp(o.expectReason).test(reasonOf(r) || r.stdout), reasonOf(r));
  if (o.minElapsed !== undefined) ctx.check(`elapsed >= ${o.minElapsed} s`, r.elapsed >= Number(o.minElapsed), r.elapsed);
  if (o.maxElapsed !== undefined) ctx.check(`elapsed <= ${o.maxElapsed} s`, r.elapsed <= Number(o.maxElapsed), r.elapsed);
  if (ctx.unrelated) ctx.check('unrelated pid-reuse process still alive', alive(ctx.unrelated), ctx.unrelated);
  if (o.signal && o.target === 'referee' && o.entry === 'referee' && SIGNO[o.signal] && o.signal !== 'KILL') ctx.check(`referee exit ${128 + SIGNO[o.signal]}`, r.code === 128 + SIGNO[o.signal], [r.code, r.signal]);
  if (o.signal) ctx.check('no PASS after a signal', !(verdictOf(r) && verdictOf(r).pass === true), reasonOf(r));
  // universal invariants (skipped only where the vector itself makes them inapplicable)
  const killedReferee = o.signal === 'KILL' && (o.target === 'referee' || o.entry === 'referee');
  if (!killedReferee) {
    await noSurvivor(ctx, m, 'no marker process within 2 s of the return (5 s after a gate SIGKILL)', o.signal === 'KILL' ? 5000 : 2000);
    ctx.check('no referee left for the fixture', await waitFor(() => refereeOf(repo).length === 0 && refereeOf(fx.repo).length === 0, o.signal === 'KILL' ? 5000 : 1000), refereeOf(repo));
    ctx.check('$L empty', await waitFor(() => ls(L).length === 0, o.signal === 'KILL' ? 5000 : 0), ls(L));
    emptyDir(ctx, T, '$T empty');
  } else ctx.check('referee SIGKILL: universal cleanup not applicable (contract residual risk 2)', true, { marker: pgrep(m), locks: ls(L) });
  if (!o.signal) shapeChecks(ctx, r);
  ctx.observed = { code: r.code, signal: r.signal, elapsed: r.elapsed, verdict: verdictOf(r), gate: r.entry === 'gate' && r.out ? r.out.gate : undefined, stderr: r.stderr };
} };

// ---------- CLI ----------
// Live vitest / Stryker processes (worker titles, npm/npx launchers, bin shims) — not mere paths or
// shell text that contain the word.
const HEAVY_RUNNERS = '\\(vitest|exec vitest|npx vitest|bin/vitest|vitest\\.mjs|stryker run|bin/stryker|stryker\\.js';
// `pgrep -fl <pattern>` minus this probe's own ancestors (the invoking shell's command line may quote the pattern).
function foreign(pattern) {
  const mine = new Set();
  for (let p = process.pid; p > 1 && !mine.has(p);) { mine.add(p); p = Number(spawnSync('ps', ['-o', 'ppid=', '-p', String(p)], { encoding: 'utf8' }).stdout.trim()) || 0; }
  const lines = (spawnSync('pgrep', ['-fl', pattern], { encoding: 'utf8' }).stdout || '').split('\n').filter(Boolean);
  return lines.filter((l) => !mine.has(Number(l.split(' ')[0]))).join('\n');
}

function parseArgs(argv) {
  const o = { scenario: 'all', entry: 'gate', target: 'gate', signalWhen: 'pidfile', lock: 'none', env: {} };
  const flag = { '--scenario': 'scenario', '--entry': 'entry', '--verify': 'verify', '--setup': 'setup', '--acceptance': 'acceptance',
    '--timeout': 'timeout', '--signal': 'signal', '--target': 'target', '--signal-when': 'signalWhen', '--lock': 'lock',
    '--expect-exit': 'expectExit', '--expect-reason': 'expectReason', '--min-elapsed': 'minElapsed', '--max-elapsed': 'maxElapsed', '--scratch': 'scratch' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') o.list = true;
    else if (a === '--keep') o.keep = true;
    else if (a === '--worktree') o.worktree = true;
    else if (a === '--env') { const [k, ...v] = argv[++i].split('='); o.env[k] = v.join('='); }
    else if (flag[a]) o[flag[a]] = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  if (o.signal) o.signal = o.signal.replace(/^SIG/, '');
  if (o.signal && !SIGNO[o.signal]) throw new Error(`unsupported --signal ${o.signal}`);
  return o;
}

async function main() {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  if (o.list) { for (const [k, v] of Object.entries(S)) console.log(`${k}\tstep ${v.step}\t${v.inv.join(',')}`); return 0; }
  const pre = foreign(HEAVY_RUNNERS);
  if (pre) { console.log(JSON.stringify({ result: 'INSTRUMENT-BROKEN', reason: `precondition: vitest/stryker running: ${pre}` })); return 2; }
  scratchRoot = realpathSync(mkdtempSync(join(o.scratch || tmpdir(), 'qkpt-probe-')));
  const names = o.scenario === 'all' ? Object.keys(S).filter((k) => k !== 'custom') : o.scenario.split(',');
  for (const n of names) if (!S[n]) { console.error(`unknown scenario ${n} (see --list)`); return 2; }
  const results = [];
  for (const n of names) {
    const ctx = new Ctx(n, S[n].inv);
    try { await S[n].run(ctx, o); } catch (e) { if (!ctx.broken) ctx.broken = e.stack || String(e); }
    const survivors = ctx.cleanup(o.keep);
    if (survivors.length) ctx.check('cleanup: pkill left no marker process', false, survivors);
    const result = ctx.broken ? 'INSTRUMENT-BROKEN' : ctx.checks.every((c) => c.ok) ? 'HOLDS' : 'VIOLATED';
    const line = { scenario: n, step: S[n].step, invariants: S[n].inv, result, broken: ctx.broken || undefined, observed: ctx.observed, checks: ctx.checks };
    results.push(line); console.log(JSON.stringify(line));
  }
  if (!o.keep) rmSync(scratchRoot, { recursive: true, force: true });
  const vitest = foreign(HEAVY_RUNNERS);
  const count = (r) => results.filter((x) => x.result === r).map((x) => x.scenario);
  const summary = { summary: true, holds: count('HOLDS'), violated: count('VIOLATED'), broken: count('INSTRUMENT-BROKEN'), finalRunnerCheck: vitest || 'empty', scratch: o.keep ? scratchRoot : 'removed' };
  console.log(JSON.stringify(summary));
  if (summary.broken.length) return 2;
  return summary.violated.length || vitest ? 1 : 0;
}

process.exitCode = await main();
