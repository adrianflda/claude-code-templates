import './hermetic-git.mjs';
import { test, after, mock } from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { lstatSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, appendFileSync, utimesSync, realpathSync, symlinkSync, rmSync, existsSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createExclusive } from './process-safety/lock-store.mjs';
import { processStart } from './process-safety/lock-liveness.mjs';
import { emptyState, apply, validate } from './run-journal/schema.mjs';
import { CHECK, CHECK_FILE, writeGateConfig, writeRepoGateFile } from './run-journal/test-fixture.mjs';
import { latestGreens, regate } from './run-journal/regate.mjs';

// Contract: docs/agentic-harness/spec-run-journal.v1.md (§2 location, §3 records, §4 writer, §5 resume,
// §7 invariants, §8 decisions). Every assertion names the spec clause it checks; exit codes and
// divergence shapes are the spec's, not this file's. INV-1 lives in run-journal.crash.test.mjs.
const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, 'run-journal.mjs');
const RUN = '0123456789abcdef';
const AT = '2026-11-07T10:00:00Z';
const FAKE_SHA = 'a'.repeat(40);
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const gitIn = (dir) => (...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
const sh = (dir, ...a) => gitIn(dir)(...a).stdout.trim();
const cli = (args, env = {}) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 20000, env: { ...process.env, ...env } });
const json = (r) => JSON.parse(r.stdout);
const runDirOf = (org) => join(org, '.quality-kernel', 'runs', RUN);
const journalFile = (org) => join(runDirOf(org), 'journal.jsonl');

// An org folder with one repo `app` (main + branch feat/a) and a linked worktree `app-wt` on feat/a,
// gated by the org (guide + tools.json) so that resume can re-run the real gate (§5.3).
function fixture() {
  const org = realpathSync(mkdtempSync(join(tmpdir(), 'qk-rj-'))); dirs.push(org);
  const app = join(org, 'app'); mkdirSync(app);
  const git = gitIn(app);
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  writeFileSync(join(app, 'a.txt'), 'a'); writeFileSync(join(app, CHECK_FILE), CHECK); git('add', '-A'); git('commit', '-qm', 'init');
  writeGateConfig(org, ['app']);
  const base = sh(app, 'rev-parse', 'HEAD');
  git('branch', 'feat/a');
  git('worktree', 'add', '-q', join(org, 'app-wt'), 'feat/a');
  return { org, app, wt: join(org, 'app-wt'), base };
}
// A commit on the worktree's branch, optionally tagged for a task with the QK-Task trailer (§3).
function commit(f, msg, taskId) {
  writeFileSync(join(f.wt, `${msg}.txt`), msg);
  const g = gitIn(f.wt); g('add', '-A');
  g('commit', '-qm', msg, ...(taskId ? ['--trailer', `QK-Task: ${taskId}`] : []));
  return sh(f.wt, 'rev-parse', 'HEAD');
}
const append = (f, seq, record, env) => cli(['append', '--org', f.org, '--run', RUN, '--expect-seq', String(seq), '--record', JSON.stringify(record)], env);
const started = (f) => ({ v: 1, type: 'run_started', run_id: RUN, plan_ref: 'plan.md', repos: [{ name: 'app', base_sha: f.base }] });
const task = (state, extra = {}) => ({ v: 1, type: 'task', task_id: 't1', repo: 'app', branch: 'feat/a', worktree: 'app-wt', state, ...extra });
const green = (sha, extra = {}) => task('gate_green', { head_sha: sha, gate: { exit: 0, at: AT }, ...extra });
const red = (sha, extra = {}) => task('gate_red', { head_sha: sha, gate: { exit: 1, at: AT }, ...extra });
// The full lifecycle of one task up to gate_green (§3).
const lifecycle = (sha, extra = {}) => [task('pending', extra), task('in_progress', extra), task('committed', { head_sha: sha, ...extra }), green(sha, extra)];
// Appends records in order from seq 0, asserting each one lands.
function seed(f, ...records) {
  records.forEach((r, i) => { const res = append(f, i, r); assert.strictEqual(res.status, 0, `seed #${i}: ${res.stdout}${res.stderr}`); });
}
// INV-6, checked on every resume of this suite: nothing under the org folder but the journal's own
// directory changes — no file, ref, index, HEAD or worktree is written (mode, size and mtime of every entry).
function orgTree(org) {
  const out = {};
  const walk = (d) => {
    let names;
    try { names = readdirSync(d); } catch (e) { out[d] = `ERR ${e.code}`; return; }
    for (const n of names.sort()) {
      const p = join(d, n);
      if (p === join(org, '.quality-kernel')) continue;
      let st;
      try { st = lstatSync(p); } catch (e) { out[p] = `ERR ${e.code}`; continue; }
      out[p] = `${st.mode}:${st.size}:${st.mtimeMs}`;
      if (st.isDirectory()) walk(p);
    }
  };
  walk(org);
  return out;
}
const resume = (f, env) => {
  const before = orgTree(f.org);
  const r = cli(['resume', '--org', f.org, '--run', RUN], env);
  assert.deepStrictEqual(orgTree(f.org), before, 'INV-6: resume changed something in the org folder');
  return r;
};
const fold = (f) => cli(['fold', '--org', f.org, '--run', RUN]);

// ---- §3 transitions: the table is the contract, written out literally ----

const LEGAL = {
  '(new)': ['pending'],
  pending: ['in_progress', 'blocked'],
  in_progress: ['committed', 'blocked'],
  committed: ['gate_green', 'gate_red', 'blocked'],
  gate_red: ['in_progress', 'blocked'],
  gate_green: [],
  blocked: [],
};
const STATES = ['pending', 'in_progress', 'committed', 'gate_green', 'gate_red', 'blocked'];
const rec = (state) => task(state, state === 'committed' ? { head_sha: FAKE_SHA }
  : state === 'gate_green' ? { head_sha: FAKE_SHA, gate: { exit: 0, at: AT } }
    : state === 'gate_red' ? { head_sha: FAKE_SHA, gate: { exit: 2, at: AT } } : {});
const PATH_TO = {
  '(new)': [], pending: ['pending'], in_progress: ['pending', 'in_progress'],
  committed: ['pending', 'in_progress', 'committed'], gate_green: ['pending', 'in_progress', 'committed', 'gate_green'],
  gate_red: ['pending', 'in_progress', 'committed', 'gate_red'], blocked: ['pending', 'blocked'],
};
const runStarted = { v: 1, type: 'run_started', run_id: RUN, plan_ref: 'p', repos: [{ name: 'app', base_sha: FAKE_SHA }] };
function stateAfter(records) {
  let s = emptyState();
  for (const r of [runStarted, ...records]) { const why = validate(r, s, RUN); assert.strictEqual(why, null, `${JSON.stringify(r)}: ${why}`); s = apply(s, r); }
  return s;
}

test('§3: every (from, to) pair is accepted exactly when the transition table allows it', () => {
  for (const [from, path] of Object.entries(PATH_TO)) {
    const s = stateAfter(path.map(rec));
    for (const to of STATES) {
      const why = validate(rec(to), s, RUN);
      assert.strictEqual(why === null, LEGAL[from].includes(to), `${from} -> ${to}: ${why}`);
    }
  }
});

test('§3/§8.4: after the 3rd gate_red only blocked is legal; a decision restarts the task in pending with a fresh budget', () => {
  const cycle = ['in_progress', 'committed', 'gate_red'];
  let s = stateAfter(['pending', ...cycle, ...cycle, ...cycle].map(rec)); // 3 reds
  assert.match(validate(rec('in_progress'), s, RUN), /retry cap/);
  assert.strictEqual(validate(rec('blocked'), s, RUN), null);
  s = stateAfter(['pending', ...cycle, ...cycle].map(rec)); // 2 reds: one more retry allowed
  assert.strictEqual(validate(rec('in_progress'), s, RUN), null);
  s = stateAfter([...['pending', ...cycle, ...cycle, ...cycle].map(rec), rec('blocked')]);
  const decision = { v: 1, type: 'decision', task_id: 't1', ref: 'issue#7' };
  assert.strictEqual(validate(decision, s, RUN), null);
  s = apply(s, decision);
  assert.strictEqual(s.tasks.t1.state, 'pending');
  for (const r of [...cycle, ...cycle, ...cycle].map(rec)) { assert.strictEqual(validate(r, s, RUN), null); s = apply(s, r); }
  assert.match(validate(rec('in_progress'), s, RUN), /retry cap/);
});

test('§3: a decision is only accepted for a blocked task, and needs a ref', () => {
  const d = { v: 1, type: 'decision', task_id: 't1', ref: 'issue#7' };
  assert.notStrictEqual(validate(d, stateAfter(['pending'].map(rec)), RUN), null);
  assert.notStrictEqual(validate(d, stateAfter([]), RUN), null); // unknown task
  assert.notStrictEqual(validate({ ...d, ref: '' }, stateAfter(['pending', 'blocked'].map(rec)), RUN), null);
  assert.strictEqual(validate(d, stateAfter(['pending', 'blocked'].map(rec)), RUN), null);
});

// ---- §3/§4 writer: validation is fail-closed (exit 2, nothing written) ----

test('§4: a valid record is appended as one JSON line and the new seq is returned', () => {
  const f = fixture();
  const r = append(f, 0, started(f));
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(json(r), { ok: true, seq: 1 });
  assert.strictEqual(readFileSync(journalFile(f.org), 'utf8'), `${JSON.stringify(started(f))}\n`);
  assert.strictEqual(existsSync(join(runDirOf(f.org), 'journal.lock')), false, 'the lock is released');
});

test('§3/§4: every malformed record exits 2 and writes nothing', () => {
  const f = fixture();
  const sha = commit(f, 'c1', 't1');
  seed(f, started(f), task('pending'), task('in_progress'), task('committed', { head_sha: sha }));
  const before = readFileSync(journalFile(f.org), 'utf8');
  const bad = {
    'unknown version': { ...task('gate_green'), v: 2 },
    'unknown type': { v: 1, type: 'note' },
    'unknown field': { ...green(sha), extra: 1 },
    'unknown state': task('done'),
    'repo not declared': green(sha, { repo: 'other' }),
    'bad task_id': green(sha, { task_id: 'a b' }),
    'bad branch': green(sha, { branch: 'feat/../x' }),
    'repo/branch change': green(sha, { branch: 'feat/b' }),
    'missing worktree': green(sha, { worktree: undefined }),
    'worktree path': green(sha, { worktree: '../escape' }),
    'short head_sha': green(sha.slice(0, 12)),
    'gate on another sha': green(FAKE_SHA),
    'gate without at': task('gate_green', { head_sha: sha, gate: { exit: 0 } }),
    'gate at not UTC': task('gate_green', { head_sha: sha, gate: { exit: 0, at: '2026-11-07T10:00:00+01:00' } }),
    'gate at not a date': task('gate_green', { head_sha: sha, gate: { exit: 0, at: '2026-13-45T99:00:00Z' } }),
    'gate extra key': task('gate_green', { head_sha: sha, gate: { exit: 0, at: AT, log: 'x' } }),
    'gate exit not int': task('gate_green', { head_sha: sha, gate: { exit: '0', at: AT } }),
    'green with exit 1': task('gate_green', { head_sha: sha, gate: { exit: 1, at: AT } }),
    'red with exit 0': task('gate_red', { head_sha: sha, gate: { exit: 0, at: AT } }),
    'gate on non-gated state': task('blocked', { gate: { exit: 0, at: AT } }),
    'empty reason': task('blocked', { reason: '' }),
    'second run_started': started(f),
    'bad verdict': { v: 1, type: 'run_finished', verdict: 'ok' },
    'decision for non-blocked': { v: 1, type: 'decision', task_id: 't1', ref: 'x' },
  };
  for (const [name, r] of Object.entries(bad)) {
    const res = append(f, 4, r);
    assert.strictEqual(res.status, 2, `${name}: ${res.stdout}`);
    assert.strictEqual(json(res).ok, false, name);
  }
  assert.strictEqual(readFileSync(journalFile(f.org), 'utf8'), before);
  assert.strictEqual(append(f, 4, green(sha)).status, 0, 'control: the valid record lands');
});

test('§3: run_started must be first, unique-named, with plain repo names and this run id', () => {
  const f = fixture();
  const cases = {
    'task first': task('pending'),
    'repo path': { ...started(f), repos: [{ name: '../app', base_sha: f.base }] },
    'no repos': { ...started(f), repos: [] },
    'duplicate repo': { ...started(f), repos: [{ name: 'app', base_sha: f.base }, { name: 'app', base_sha: f.base }] },
    'repo extra key': { ...started(f), repos: [{ name: 'app', base_sha: f.base, x: 1 }] },
    'other run id': { ...started(f), run_id: 'fedcba9876543210' },
    'empty plan_ref': { ...started(f), plan_ref: '' },
  };
  for (const [name, r] of Object.entries(cases)) assert.strictEqual(append(f, 0, r).status, 2, name);
  assert.strictEqual(existsSync(journalFile(f.org)), false);
});

test('§3: nothing may be appended after run_finished', () => {
  const f = fixture();
  seed(f, started(f), { v: 1, type: 'run_finished', verdict: 'pass' });
  assert.strictEqual(append(f, 2, task('pending')).status, 2);
});

test('§4: a record line of 65536 bytes is accepted, 65537 is refused with exit 2', () => {
  const f = fixture();
  const sized = (bytes) => {
    const r = { ...started(f), repos: Array.from({ length: 700 }, (_, i) => ({ name: `r${i}`, base_sha: f.base })) };
    const pad = bytes - Buffer.byteLength(`${JSON.stringify(r)}\n`);
    r.repos[0].name = `r0${'x'.repeat(pad)}`;
    assert.strictEqual(Buffer.byteLength(`${JSON.stringify(r)}\n`), bytes);
    return r;
  };
  assert.strictEqual(append(f, 0, sized(65537)).status, 2);
  assert.strictEqual(existsSync(journalFile(f.org)), false);
  assert.strictEqual(append(f, 0, sized(65536)).status, 0);
});

// ---- §2 location: nothing outside the org folder is touched ----

test('§2: a run id that is not 16 hex characters is refused (exit 2)', () => {
  const f = fixture();
  for (const run of ['../x', '0123456789ABCDEF', '0123']) {
    const r = cli(['fold', '--org', f.org, '--run', run]);
    assert.strictEqual(r.status, 2, run);
  }
  assert.strictEqual(cli(['fold', '--org', f.org]).status, 2, '--run is required');
});

test('§2: a symlinked runs directory or journal is refused (exit 2) and nothing is written through it', () => {
  const f = fixture();
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'qk-rj-out-'))); dirs.push(outside);
  mkdirSync(join(f.org, '.quality-kernel'), { recursive: true }); // holds the org gate config already
  symlinkSync(outside, join(f.org, '.quality-kernel', 'runs'));
  assert.strictEqual(append(f, 0, started(f)).status, 2);
  assert.strictEqual(existsSync(join(outside, RUN)), false);

  const g = fixture();
  mkdirSync(runDirOf(g.org), { recursive: true });
  const target = join(outside, 'target.jsonl'); writeFileSync(target, '');
  symlinkSync(target, journalFile(g.org));
  assert.strictEqual(append(g, 0, started(g)).status, 2);
  assert.strictEqual(fold(g).status, 2);
  assert.strictEqual(readFileSync(target, 'utf8'), '');
});

test('§4: a FIFO in place of the journal is refused promptly (exit 2), never blocks', () => {
  const f = fixture();
  mkdirSync(runDirOf(f.org), { recursive: true });
  assert.strictEqual(spawnSync('mkfifo', [journalFile(f.org)]).status, 0);
  const t0 = Date.now();
  const r = fold(f);
  assert.strictEqual(r.status, 2, `${r.stdout}${r.error || ''}`);
  assert.ok(Date.now() - t0 < 10000);
  assert.strictEqual(append(f, 0, started(f)).status, 2);
});

// ---- INV-5: optimistic concurrency and the append lock ----

test('INV-5: an append at a stale --expect-seq exits 3 and leaves the journal unchanged', () => {
  const f = fixture();
  seed(f, started(f), task('pending'));
  const before = readFileSync(journalFile(f.org), 'utf8');
  const r = append(f, 1, task('in_progress'));
  assert.strictEqual(r.status, 3, r.stdout);
  assert.strictEqual(readFileSync(journalFile(f.org), 'utf8'), before);
});

test('INV-5: two concurrent writers at the same seq -> exactly one succeeds, the others exit 3', async () => {
  const f = fixture();
  seed(f, started(f), task('pending'));
  const r = JSON.stringify(task('in_progress'));
  const run = () => new Promise((res) => {
    const c = spawn(process.execPath, [CLI, 'append', '--org', f.org, '--run', RUN, '--expect-seq', '2', '--record', r]);
    c.on('exit', (code) => res(code));
  });
  const codes = (await Promise.all([run(), run(), run(), run()])).sort();
  assert.deepStrictEqual(codes, [0, 3, 3, 3]);
  assert.strictEqual(readFileSync(journalFile(f.org), 'utf8').trim().split('\n').length, 3);
});

const lockFile = (org) => join(runDirOf(org), 'journal.lock');

// In-process access to the writer, for the interleavings a spawned process cannot pin down. The lock
// wait is read at import time, so it is shortened only for this import (spawned CLIs keep the default).
const store = await (async () => {
  const saved = process.env.QK_JOURNAL_LOCK_WAIT_MS;
  process.env.QK_JOURNAL_LOCK_WAIT_MS = '200';
  try { return await import('./run-journal/store.mjs'); } finally {
    if (saved === undefined) delete process.env.QK_JOURNAL_LOCK_WAIT_MS; else process.env.QK_JOURNAL_LOCK_WAIT_MS = saved;
  }
})();
const journalLines = (org) => readFileSync(journalFile(org), 'utf8').trim().split('\n');

test('INV-5 (deterministic): a second writer arriving between the first one\'s checks and its write gets exit 3', () => {
  const f = fixture();
  seed(f, started(f), task('pending'));
  let second;
  const first = store.append(f.org, RUN, 2, task('in_progress'), {
    beforeWrite: () => { second = store.append(f.org, RUN, 2, task('blocked', { reason: 'other writer' })); },
  });
  assert.strictEqual(second.code, 3, JSON.stringify(second));
  assert.deepStrictEqual(first, { code: 0, seq: 3 });
  assert.strictEqual(journalLines(f.org).length, 3, 'exactly one record was added');
  assert.strictEqual(json(fold(f)).tasks.t1.state, 'in_progress');
  assert.strictEqual(existsSync(lockFile(f.org)), false);
});

test('§4: a writer whose lock was replaced before it wrote exits 3, writes nothing, and leaves the new lock alone', () => {
  const f = fixture();
  seed(f, started(f));
  const before = readFileSync(journalFile(f.org), 'utf8');
  const usurper = { pid: process.ppid, lstart: processStart(process.ppid), runId: RUN, pgids: [], descendants: [] };
  const r = store.append(f.org, RUN, 1, task('pending'), {
    beforeWrite: () => { rmSync(lockFile(f.org)); assert.ok(createExclusive(lockFile(f.org), usurper)); },
  });
  assert.strictEqual(r.code, 3, JSON.stringify(r));
  assert.strictEqual(readFileSync(journalFile(f.org), 'utf8'), before);
  assert.deepStrictEqual(JSON.parse(readFileSync(lockFile(f.org), 'utf8')), usurper);
});

test('§4: a stale takeover deletes only the holder it identified; a lock that changed hands is put back', () => {
  const f = fixture();
  seed(f, started(f));
  const lock = lockFile(f.org);
  const dead = { pid: 999999, lstart: 'Thu Jan  1 00:00:00 2026', runId: RUN, pgids: [], descendants: [] };
  const live = { pid: process.pid, lstart: processStart(process.pid), runId: RUN, pgids: [], descendants: [] };
  // Judged stale as `dead`, but by the time it is moved aside the file is `live`'s: it must come back.
  assert.ok(createExclusive(lock, live));
  store.takeOverStale(lock, dead);
  assert.deepStrictEqual(JSON.parse(readFileSync(lock, 'utf8')), live);
  // The holder it identified is removed.
  rmSync(lock); assert.ok(createExclusive(lock, dead));
  store.takeOverStale(lock, dead);
  assert.strictEqual(existsSync(lock), false);
  // Nothing is left aside in either case.
  assert.deepStrictEqual(readdirSync(runDirOf(f.org)).filter((n) => n !== 'journal.jsonl'), []);
});

test('§4: a lock held by a live process is never removed — the append exits 3 and writes nothing', () => {
  const f = fixture();
  seed(f, started(f));
  const before = readFileSync(journalFile(f.org), 'utf8');
  const holder = { pid: process.pid, lstart: processStart(process.pid), runId: RUN, pgids: [], descendants: [] };
  assert.ok(createExclusive(lockFile(f.org), holder));
  const r = append(f, 1, task('pending'), { QK_JOURNAL_LOCK_WAIT_MS: '300' });
  assert.strictEqual(r.status, 3, r.stdout);
  assert.strictEqual(readFileSync(journalFile(f.org), 'utf8'), before);
  assert.deepStrictEqual(JSON.parse(readFileSync(lockFile(f.org), 'utf8')), holder, 'the live lock is untouched');
});

test('§4: a dead holder\'s lock is taken over, the record lands, and no lock is left behind', () => {
  const f = fixture();
  seed(f, started(f));
  const child = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' });
  const deadPid = Number(child.stdout.trim());
  assert.ok(createExclusive(lockFile(f.org), { pid: deadPid, lstart: 'Thu Jan  1 00:00:00 2026', runId: RUN, pgids: [], descendants: [] }));
  const r = append(f, 1, task('pending'), { QK_JOURNAL_LOCK_WAIT_MS: '3000' });
  assert.strictEqual(r.status, 0, r.stdout);
  assert.strictEqual(existsSync(lockFile(f.org)), false);
  assert.strictEqual(json(fold(f)).tasks.t1.state, 'pending');
});

// ---- INV-3: torn tail, byte-exact truncation, strict UTF-8 ----

test('INV-3: a torn last line is reported and ignored by fold and resume', () => {
  const f = fixture();
  seed(f, started(f), task('pending'));
  const clean = json(fold(f));
  appendFileSync(journalFile(f.org), '{"v":1,"type":"task","task_id":"t1","repo":"app","bra');
  const torn = fold(f);
  assert.strictEqual(torn.status, 0);
  assert.strictEqual(json(torn).torn_tail, true);
  assert.deepStrictEqual({ ...json(torn), torn_tail: false }, clean);
  const r = resume(f);
  assert.strictEqual(r.status, 0, r.stdout);
  assert.strictEqual(json(r).torn_tail, true);
});

test('INV-3: the next append cuts the torn tail at the byte after the last newline (multibyte content)', () => {
  const f = fixture();
  const s = { ...started(f), plan_ref: 'plán-ñandú-✓.md' }; // EXEMPT-ES: non-ASCII path is the unicode test data
  seed(f, s, task('pending'));
  const good = readFileSync(journalFile(f.org));
  appendFileSync(journalFile(f.org), Buffer.from('{"v":1,"reason":"ñ✓', 'utf8'));
  assert.strictEqual(append(f, 2, task('in_progress')).status, 0);
  const expected = Buffer.concat([good, Buffer.from(`${JSON.stringify(task('in_progress'))}\n`)]);
  assert.deepStrictEqual(readFileSync(journalFile(f.org)), expected);
  assert.strictEqual(json(fold(f)).torn_tail, false);
});

test('INV-3: invalid UTF-8 inside a complete line is corruption (exit 2); inside the torn tail it is ignored', () => {
  const f = fixture();
  seed(f, started(f), task('pending'));
  // A schema-valid record whose reason holds invalid bytes: a lossy decode would turn them into
  // U+FFFD and accept the line, so only a fatal decode refuses it.
  const [head, tail] = JSON.stringify(task('blocked', { reason: 'X' })).split('X');
  appendFileSync(journalFile(f.org), Buffer.concat([Buffer.from(head), Buffer.from([0xff, 0xfe]), Buffer.from(tail)]));
  assert.strictEqual(fold(f).status, 0, 'torn tail with bad bytes is ignored');
  assert.strictEqual(json(fold(f)).torn_tail, true);
  assert.strictEqual(json(fold(f)).seq, 2);
  assert.strictEqual(json(fold(f)).tasks.t1.state, 'pending', 'the torn tail never changes state');
  appendFileSync(journalFile(f.org), '\n');
  assert.strictEqual(fold(f).status, 2);
  assert.strictEqual(resume(f).status, 2);
  assert.strictEqual(append(f, 3, task('in_progress')).status, 2);
});

test('§5.1: a corrupt or schema-invalid line that is not the tail makes resume indeterminate (exit 2)', () => {
  for (const line of ['not json', JSON.stringify(task('gate_green'))]) {
    const f = fixture();
    seed(f, started(f), task('pending'));
    appendFileSync(journalFile(f.org), `${line}\n${JSON.stringify(task('in_progress'))}\n`);
    assert.strictEqual(resume(f).status, 2, line);
    assert.strictEqual(fold(f).status, 2, line);
  }
});

// ---- §5 reconcile against git ----

test('§5: a consistent run resumes with exit 0 and lists done, continuable and blocked tasks', () => {
  const f = fixture();
  const sha = commit(f, 'c1', 't1');
  seed(f, started(f), ...lifecycle(sha),
    task('pending', { task_id: 't2' }),
    task('pending', { task_id: 't3' }), task('blocked', { task_id: 't3', reason: 'needs credentials' }),
    task('pending', { task_id: 't4' }), task('blocked', { task_id: 't4' }));
  const r = resume(f);
  assert.strictEqual(r.status, 0, r.stdout);
  assert.deepStrictEqual(json(r), {
    ok: true, torn_tail: false, done: ['t1'], continue: ['t2'],
    blocked: [{ task_id: 't3', reason: 'needs credentials' }, { task_id: 't4', reason: 'journaled' }], divergences: [],
    regate: [{ repo: 'app', task_id: 't1', sha, exit: 0, gate: 'pass' }], // §5.3: the real gate, re-run at the green SHA
  });
});

test('INV-4: journal says green but the SHA is no longer on the branch -> exit 1 naming the task', () => {
  const f = fixture();
  const sha = commit(f, 'c1', 't1');
  seed(f, started(f), ...lifecycle(sha));
  gitIn(f.wt)('reset', '-q', '--hard', f.base); // the branch is rewritten under the run
  const r = resume(f);
  assert.strictEqual(r.status, 1, r.stdout);
  assert.deepStrictEqual(json(r).divergences, [{ task_id: 't1', kind: 'sha_unreachable', sha }]);
});

test('INV-4: a journaled SHA that does not exist in the repo at all -> sha_unreachable, not indeterminate', () => {
  const f = fixture();
  seed(f, started(f), task('pending'), task('in_progress'), task('committed', { head_sha: FAKE_SHA }));
  const r = resume(f);
  assert.strictEqual(r.status, 1, r.stdout);
  assert.deepStrictEqual(json(r).divergences, [{ task_id: 't1', kind: 'sha_unreachable', sha: FAKE_SHA }]);
});

test('INV-2: a commit for a task after its green SHA -> exit 1 (commits_after_green)', () => {
  const f = fixture();
  const sha = commit(f, 'c1', 't1');
  seed(f, started(f), ...lifecycle(sha));
  const extra = commit(f, 'c2', 't1');
  const r = resume(f);
  assert.strictEqual(r.status, 1, r.stdout);
  assert.deepStrictEqual(json(r).divergences, [{ task_id: 't1', kind: 'commits_after_green', commits: [extra] }]);
});

// ---- §5.3 / §8.2 re-gate on resume (J2): the real qk-gate, once per repo, at the latest gate_green SHA ----

const surface = (f, criticalGlobs) => writeRepoGateFile(f.org, 'app', 'critical-surface.json', { criticalGlobs, safeGlobs: [] });
const tools = (f, t) => writeRepoGateFile(f.org, 'app', 'tools.json', t);
// A commit on another branch of `app`, made in the main checkout (which then returns to main).
function commitOn(f, branch, msg, taskId) {
  const g = gitIn(f.app);
  g('switch', '-q', '-c', branch);
  writeFileSync(join(f.app, `${msg}.txt`), msg); g('add', '-A'); g('commit', '-qm', msg, '--trailer', `QK-Task: ${taskId}`);
  const sha = sh(f.app, 'rev-parse', 'HEAD');
  g('switch', '-q', 'main');
  return sha;
}

test('INV-4: journal says green but the gate is red at that SHA now -> exit 1 gate_red_now naming the task, not done', () => {
  const f = fixture();
  const sha = commit(f, 'BROKEN', 't1'); // the base check fails on any *.txt containing BROKEN
  seed(f, started(f), ...lifecycle(sha));
  const r = resume(f);
  assert.strictEqual(r.status, 1, r.stdout);
  const p = json(r);
  assert.deepStrictEqual(p.divergences, [{ task_id: 't1', kind: 'gate_red_now', repo: 'app', sha }]);
  assert.deepStrictEqual(p.done, []);
  assert.deepStrictEqual(p.regate, [{ repo: 'app', task_id: 't1', sha, exit: 1, gate: 'fail' }]);
});

test('INV-4 RED control: the same journal without the broken file re-gates green (exit 0)', () => {
  const f = fixture();
  const sha = commit(f, 'fine', 't1');
  seed(f, started(f), ...lifecycle(sha));
  const r = resume(f);
  assert.strictEqual(r.status, 0, r.stdout);
  assert.deepStrictEqual(json(r).regate, [{ repo: 'app', task_id: 't1', sha, exit: 0, gate: 'pass' }]);
});

test('§8.2: the gate runs once per repo, at the LATEST gate_green (by gate.at), not per task', () => {
  const f = fixture();
  // The latest green is t1 (11:00, on feat/b); t2 is older (10:00), journaled later, has the greater id
  // and would be red — so picking by id, by journal order or by done order all re-gate the wrong task.
  const latest = commitOn(f, 'feat/b', 'fine', 't1');
  const old = commit(f, 'BROKEN', 't2');
  seed(f, started(f), ...lifecycle(latest, { branch: 'feat/b' }).map((r) => (r.gate ? { ...r, gate: { exit: 0, at: '2026-11-07T11:00:00Z' } } : r)),
    ...lifecycle(old, { task_id: 't2' }));
  const r = resume(f);
  assert.strictEqual(r.status, 0, r.stdout);
  assert.deepStrictEqual(json(r).regate, [{ repo: 'app', task_id: 't1', sha: latest, exit: 0, gate: 'pass' }]);
  assert.deepStrictEqual(json(r).done, ['t1', 't2']);
});

// In-process: the selection rule and the gate answers a real gate cannot be made to give on demand.
const greenTask = (id, repo, at) => ({ task_id: id, repo, state: 'gate_green', head_sha: id.padEnd(40, '0'), gate: { exit: 0, at } });
const stateOf = (...ts) => ({ tasks: Object.fromEntries(ts.map((t) => [t.task_id, t])) });

test('§5.3: latest green per repo — equal gate.at goes to the greater task id; repos sorted by name', () => {
  const s = stateOf(greenTask('ta', 'r2', AT), greenTask('tb', 'r2', AT), greenTask('tc', 'r1', '2026-11-07T09:00:00Z'));
  assert.deepStrictEqual(latestGreens(s, ['tb', 'ta', 'tc']).map(([repo, t]) => [repo, t.task_id]), [['r1', 'tc'], ['r2', 'tb']]);
  assert.deepStrictEqual(latestGreens(s, ['ta', 'tb', 'tc']).map(([repo, t]) => [repo, t.task_id]), [['r1', 'tc'], ['r2', 'tb']]);
});

test('§5.3: only the gate\'s own verdict counts — a crash (exit 1 without fail), no exit, or a mismatched verdict is indeterminate', () => {
  const s = stateOf(greenTask('t1', 'app', AT));
  const call = (answer) => regate('/org', s, ['t1'], { app: '/org/app' }, { app: FAKE_SHA }, { runGate: () => answer });
  const ok = (exit, gate) => ({ regate: [{ repo: 'app', task_id: 't1', sha: s.tasks.t1.head_sha, exit, gate }] });
  assert.deepStrictEqual(call({ status: 0, json: { gate: 'pass' } }), { ...ok(0, 'pass'), divergences: [] });
  assert.deepStrictEqual(call({ status: 3, json: { gate: 'blocked-needs-breaker' } }), { ...ok(3, 'blocked-needs-breaker'), divergences: [] });
  assert.deepStrictEqual(call({ status: 1, json: { gate: 'fail' } }).divergences, [{ task_id: 't1', kind: 'gate_red_now', repo: 'app', sha: s.tasks.t1.head_sha }]);
  for (const [answer, why] of [
    [{ status: 1, json: null }, /exit 1, verdict null/], // node's exit code for an uncaught exception
    [{ status: null, json: null, error: 'killed by SIGKILL' }, /killed by SIGKILL/],
    [{ status: 0, json: { gate: 'fail' } }, /exit 0, verdict fail/],
    [{ status: 3, json: { gate: 'pass' } }, /exit 3, verdict pass/],
    [{ status: 0, json: { gate: 'blocked-needs-breaker' } }, /exit 0, verdict blocked-needs-breaker/],
    [{ status: 3, json: { gate: 'fail' } }, /exit 3, verdict fail/],
    [{ status: 1, json: { gate: 'pass' } }, /exit 1, verdict pass/],
    [{ status: 2, json: { gate: 'indeterminate', notes: ['org config moved'] } }, /org config moved/],
  ]) assert.match(call(answer).error ?? '', why, JSON.stringify(answer));
});

test('§5.3: gate exit 3 (referee green, critical surface needs the breaker) is not a divergence', () => {
  const f = fixture();
  surface(f, ['*.txt']);
  const sha = commit(f, 'c1', 't1');
  seed(f, started(f), ...lifecycle(sha));
  const r = resume(f);
  assert.strictEqual(r.status, 0, r.stdout);
  assert.deepStrictEqual(json(r).regate, [{ repo: 'app', task_id: 't1', sha, exit: 3, gate: 'blocked-needs-breaker' }]);
  assert.deepStrictEqual(json(r).divergences, []);
});

test('§5.3: a re-gate that cannot decide (gate exit 2) makes resume indeterminate (exit 2), never green', () => {
  const f = fixture();
  tools(f, { verify: `node ${CHECK_FILE}`, productionGlobs: ['src/**'] }); // the changed *.txt is unclassifiable
  const sha = commit(f, 'c1', 't1');
  seed(f, started(f), ...lifecycle(sha));
  const r = resume(f);
  assert.strictEqual(r.status, 2, r.stdout);
  assert.match(json(r).error, /re-gate of app at [0-9a-f]{40} \(task t1\) is indeterminate/);
});

test('§5.3: no re-gate on a run git already found divergent (regate: null); no gate without a green task (regate: [])', () => {
  const f = fixture();
  const sha = commit(f, 'BROKEN', 't1');
  seed(f, started(f), ...lifecycle(sha));
  commit(f, 'c2', 't1'); // commits_after_green
  const r = resume(f);
  assert.strictEqual(r.status, 1, r.stdout);
  assert.strictEqual(json(r).regate, null);
  assert.deepStrictEqual(json(r).divergences.map((d) => d.kind), ['commits_after_green']);
  const g = fixture();
  seed(g, started(g), task('pending'));
  assert.deepStrictEqual(json(resume(g)).regate, []);
});

test('INV-2 probe: after a resumed run, `git rev-list <green>..<branch> --grep QK-Task: <id>` is empty', () => {
  const f = fixture();
  const sha = commit(f, 'c1', 't1');
  seed(f, started(f), ...lifecycle(sha), task('pending', { task_id: 't2' }), task('in_progress', { task_id: 't2' }));
  const r = resume(f);
  assert.strictEqual(r.status, 0, r.stdout);
  assert.deepStrictEqual([json(r).done, json(r).continue], [['t1'], ['t2']]); // t1 is done: nothing re-runs it
  const c2 = commit(f, 'c2', 't2'); // the resumed run goes on with t2 on the same branch, and journals it
  assert.strictEqual(append(f, 7, task('committed', { task_id: 't2', head_sha: c2 })).status, 0);
  const probe = (id, green) => sh(f.app, 'rev-list', `${green}..feat/a`, '--grep', `QK-Task: ${id}`);
  assert.strictEqual(probe('t1', sha), '');
  const bad = commit(f, 'c3', 't1'); // a run that re-did t1 after resume breaks INV-2 ...
  assert.strictEqual(probe('t1', sha), bad);
  assert.deepStrictEqual(json(resume(f)).divergences, [{ task_id: 't1', kind: 'commits_after_green', commits: [bad] }]); // ... and resume says so
});

test('§5.2: commits for a task without head_sha (crash between commit and journal) -> orphan_commits', () => {
  for (const states of [['pending'], ['pending', 'in_progress']]) {
    const f = fixture();
    seed(f, started(f), ...states.map((s) => task(s)));
    const orphan = commit(f, 'c1', 't1');
    const r = resume(f);
    assert.strictEqual(r.status, 1, `${states}: ${r.stdout}`);
    assert.deepStrictEqual(json(r).divergences, [{ task_id: 't1', kind: 'orphan_commits', commits: [orphan] }]);
  }
});

test('§5.2: commits tagged with a task id the journal does not know -> orphan_commits for that id', () => {
  const f = fixture();
  const sha = commit(f, 'c1', 't1');
  seed(f, started(f), ...lifecycle(sha));
  commit(f, 'plain'); // no trailer: not the run's business
  const ghost = commit(f, 'c9', 't9');
  const r = resume(f);
  assert.strictEqual(r.status, 1, r.stdout);
  assert.deepStrictEqual(json(r).divergences, [{ task_id: 't9', kind: 'orphan_commits', commits: [ghost] }]);
  assert.deepStrictEqual(json(r).done, ['t1']);
});

test('§5.2: an unknown task id that is a built-in property name (constructor, toString) is still an orphan', () => {
  const f = fixture();
  const sha = commit(f, 'c1', 't1');
  seed(f, started(f), ...lifecycle(sha));
  const ctor = commit(f, 'c8', 'constructor');
  const str = commit(f, 'c9', 'toString');
  const r = resume(f);
  assert.strictEqual(r.status, 1, r.stdout);
  assert.deepStrictEqual(json(r).divergences, [
    { task_id: 'constructor', kind: 'orphan_commits', commits: [ctor] },
    { task_id: 'toString', kind: 'orphan_commits', commits: [str] },
  ]);
});

test('§5.2: a started task whose branch is gone -> exit 1 (branch_missing); a pending one may not have it yet', () => {
  const f = fixture();
  seed(f, started(f), task('pending', { branch: 'feat/gone' }), task('in_progress', { branch: 'feat/gone' }));
  const r = resume(f);
  assert.strictEqual(r.status, 1, r.stdout);
  assert.deepStrictEqual(json(r).divergences, [{ task_id: 't1', kind: 'branch_missing', branch: 'feat/gone' }]);
  const g = fixture();
  seed(g, started(g), task('pending', { branch: 'feat/not-yet' }));
  const p = resume(g);
  assert.strictEqual(p.status, 0, p.stdout);
  assert.deepStrictEqual(json(p).continue, ['t1']);
  assert.deepStrictEqual(json(p).divergences, []);
});

test('§5.2/§8.5: a task blocked before its first commit may lack its branch; one that committed may not', () => {
  const f = fixture();
  seed(f, started(f), task('pending', { branch: 'feat/not-yet' }), task('blocked', { branch: 'feat/not-yet', reason: 'design question' }));
  const r = resume(f);
  assert.strictEqual(r.status, 0, r.stdout);
  assert.deepStrictEqual(json(r).blocked, [{ task_id: 't1', reason: 'design question' }]);
  assert.deepStrictEqual(json(r).divergences, []);
  // committed -> blocked -> decision -> pending keeps head_sha: its branch must exist.
  const g = fixture();
  const sha = commit(g, 'c1', 't1');
  seed(g, started(g), task('pending'), task('in_progress'), task('committed', { head_sha: sha }), task('blocked', { reason: 'why' }),
    { v: 1, type: 'decision', task_id: 't1', ref: 'ADR-1' });
  for (const wt of [g.wt]) spawnSync('git', ['-C', g.app, 'worktree', 'remove', '--force', wt]);
  sh(g.app, 'branch', '-D', 'feat/a');
  for (const state of ['pending', 'blocked']) {
    if (state === 'blocked') assert.strictEqual(append(g, 6, task('blocked', { reason: 'again' })).status, 0);
    const p = resume(g);
    assert.strictEqual(p.status, 1, `${state}: ${p.stdout}`);
    assert.deepStrictEqual(json(p).divergences, [{ task_id: 't1', kind: 'branch_missing', branch: 'feat/a' }]);
  }
});

test('§5.2: a broken branch ref (garbage, or pointing at a missing object) is indeterminate (exit 2), not branch_missing', () => {
  for (const content of ['garbage\n', `${'b'.repeat(40)}\n`]) {
    const f = fixture();
    seed(f, started(f), task('pending'), task('in_progress'));
    writeFileSync(join(f.app, '.git', 'refs', 'heads', 'feat', 'a'), content);
    const r = resume(f);
    assert.strictEqual(r.status, 2, `${JSON.stringify(content)}: ${r.stdout}`);
  }
});

test('§5.2: an ancestry check that git cannot complete (missing history object) is indeterminate (exit 2)', () => {
  const f = fixture();
  const c1 = commit(f, 'c1');
  commit(f, 'c2');
  // A commit that is not on the branch: proving that needs the branch's whole history, and c1 is gone.
  const stray = sh(f.app, 'commit-tree', '-m', 'stray', sh(f.app, 'rev-parse', 'HEAD^{tree}'));
  seed(f, started(f), ...lifecycle(stray));
  rmSync(join(f.app, '.git', 'objects', c1.slice(0, 2), c1.slice(2)));
  const r = resume(f);
  assert.strictEqual(r.status, 2, r.stdout);
});

test('§5.2: commits for a task after its committed / gate_red head_sha -> orphan_commits', () => {
  const states = { committed: (sha) => [task('committed', { head_sha: sha })], gate_red: (sha) => [task('committed', { head_sha: sha }), red(sha)] };
  for (const [name, tail] of Object.entries(states)) {
    const f = fixture();
    const sha = commit(f, 'c1', 't1');
    seed(f, started(f), task('pending'), task('in_progress'), ...tail(sha));
    const orphan = commit(f, 'c2', 't1');
    const r = resume(f);
    assert.strictEqual(r.status, 1, `${name}: ${r.stdout}`);
    assert.deepStrictEqual(json(r).divergences, [{ task_id: 't1', kind: 'orphan_commits', commits: [orphan] }], name);
  }
});

test('§5.2: a gate_red task is active — its worktree is checked (wrong branch -> exit 1, dirty -> blocked)', () => {
  const f = fixture();
  const sha = commit(f, 'c1', 't1');
  seed(f, started(f), task('pending'), task('in_progress'), task('committed', { head_sha: sha }), red(sha));
  writeFileSync(join(f.wt, 'wip.txt'), 'wip');
  let r = resume(f);
  assert.strictEqual(r.status, 0, r.stdout);
  assert.deepStrictEqual(json(r).blocked, [{ task_id: 't1', reason: 'dirty_worktree', worktree: 'app-wt' }]);
  rmSync(join(f.wt, 'wip.txt'));
  gitIn(f.wt)('checkout', '-q', '-b', 'other');
  r = resume(f);
  assert.strictEqual(r.status, 1, r.stdout);
  assert.deepStrictEqual(json(r).divergences, [{ task_id: 't1', kind: 'worktree_wrong_branch', worktree: 'app-wt', expected: 'refs/heads/feat/a', actual: 'refs/heads/other' }]);
});

test('§5.2: an active task whose worktree is gone -> worktree_missing; a pending one is not checked', () => {
  const f = fixture();
  seed(f, started(f), task('pending', { worktree: 'nope' }), task('in_progress', { worktree: 'nope' }));
  const r = resume(f);
  assert.strictEqual(r.status, 1, r.stdout);
  assert.deepStrictEqual(json(r).divergences, [{ task_id: 't1', kind: 'worktree_missing', worktree: 'nope' }]);
  const g = fixture();
  seed(g, started(g), task('pending', { worktree: 'nope' }));
  assert.deepStrictEqual(json(resume(g)).continue, ['t1']);
});

test('§5.2: an active task whose worktree is on another branch or detached -> worktree_wrong_branch', () => {
  const f = fixture();
  seed(f, started(f), task('pending'), task('in_progress'));
  gitIn(f.wt)('checkout', '-q', '-b', 'other');
  let r = resume(f);
  assert.strictEqual(r.status, 1, r.stdout);
  assert.deepStrictEqual(json(r).divergences, [{ task_id: 't1', kind: 'worktree_wrong_branch', worktree: 'app-wt', expected: 'refs/heads/feat/a', actual: 'refs/heads/other' }]);
  gitIn(f.wt)('checkout', '-q', '--detach');
  r = resume(f);
  assert.strictEqual(r.status, 1, r.stdout);
  assert.strictEqual(json(r).divergences[0].actual, 'detached');
});

test('INV-6/§8.6: a dirty worktree blocks only its task (exit 0, run continues), and resume modifies nothing in git', () => {
  const f = fixture();
  const sha = commit(f, 'c1', 't1');
  seed(f, started(f), task('pending'), task('in_progress'), task('committed', { head_sha: sha }), task('pending', { task_id: 't2' }));
  writeFileSync(join(f.wt, 'wip.txt'), 'unsaved work');
  writeFileSync(join(f.wt, 'a.txt'), 'edited');
  // The observer itself must not write: a plain `git status` refreshes the index of racily-clean
  // entries, which would change the index mtime this test watches.
  const snap = () => ({
    status: sh(f.wt, '--no-optional-locks', 'status', '--porcelain'), stash: sh(f.app, 'stash', 'list'),
    head: sh(f.wt, 'rev-parse', 'HEAD'), wip: readFileSync(join(f.wt, 'wip.txt'), 'utf8'),
    index: statSync(join(f.app, '.git', 'worktrees', 'app-wt', 'index')).mtimeMs,
  });
  const before = snap();
  const r = resume(f);
  assert.strictEqual(r.status, 0, r.stdout);
  assert.deepStrictEqual(json(r).blocked, [{ task_id: 't1', reason: 'dirty_worktree', worktree: 'app-wt' }]);
  assert.deepStrictEqual(json(r).continue, ['t2']);
  assert.deepStrictEqual(json(r).divergences, []);
  assert.deepStrictEqual(snap(), before);
});

test('§5.2: a git failure is indeterminate (exit 2), never reported as a divergence', () => {
  const f = fixture();
  seed(f, { ...started(f), repos: [{ name: 'app', base_sha: FAKE_SHA }] }, task('pending'));
  const r = resume(f); // base_sha is not an object of the repo: git log base..tip fails
  assert.strictEqual(r.status, 2, r.stdout);
});

// ---- §5.2 hardening: what the caller's environment or the repo's config cannot change ----

test('§5.2: an inherited GIT_DIR cannot point resume at another repo (no false green)', () => {
  const f = fixture();
  const sha = commit(f, 'c1', 't1');
  seed(f, started(f), ...lifecycle(sha));
  const decoy = join(f.org, 'decoy.git');
  gitIn(f.org)('clone', '-q', '--bare', f.app, decoy); // still has feat/a at sha
  gitIn(f.wt)('reset', '-q', '--hard', f.base);
  const r = resume(f, { GIT_DIR: decoy });
  assert.strictEqual(r.status, 1, r.stdout);
  assert.deepStrictEqual(json(r).divergences, [{ task_id: 't1', kind: 'sha_unreachable', sha }]);
});

test('§5.2: a `git replace` graft cannot forge ancestry of the green SHA', () => {
  const f = fixture();
  const sha = commit(f, 'c1', 't1');
  seed(f, started(f), ...lifecycle(sha));
  gitIn(f.wt)('reset', '-q', '--hard', f.base);
  assert.strictEqual(gitIn(f.app)('replace', '--graft', f.base, sha).status, 0);
  assert.strictEqual(gitIn(f.app)('merge-base', '--is-ancestor', sha, 'feat/a').status, 0, 'control: plain git is fooled');
  const r = resume(f);
  assert.strictEqual(r.status, 1, r.stdout);
  assert.deepStrictEqual(json(r).divergences, [{ task_id: 't1', kind: 'sha_unreachable', sha }]);
});

test('§5.2: a repo-configured fsmonitor hook is never executed by resume', () => {
  const f = fixture();
  seed(f, started(f), task('pending'), task('in_progress'));
  const marker = join(f.org, 'fsmonitor-ran');
  const hook = join(f.org, 'fsmonitor.sh');
  writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`); chmodSync(hook, 0o755);
  gitIn(f.app)('config', 'core.fsmonitor', hook);
  const r = resume(f);
  assert.strictEqual(r.status, 0, r.stdout);
  assert.strictEqual(existsSync(marker), false, 'resume ran the fsmonitor hook');
  sh(f.wt, '--no-optional-locks', 'status', '--porcelain');
  assert.strictEqual(existsSync(marker), true, 'control: plain git status runs it');
});

test('§5.2: a repo-configured clean filter is never executed by resume (git status runs filters on stat-dirty files)', () => {
  const f = fixture();
  seed(f, started(f), task('pending'), task('in_progress'));
  const marker = join(f.org, 'filter-ran');
  for (const name of ['evil', 'Mixed.Case']) {
    gitIn(f.app)('config', `filter.${name}.clean`, `sh -c 'touch "${marker}"; cat'`);
  }
  gitIn(f.app)('config', 'filter.proc.process', `sh -c 'touch "${marker}"; exit 1'`);
  gitIn(f.app)('config', 'filter.proc.required', 'true');
  writeFileSync(join(f.wt, '.gitattributes'), 'a.txt filter=evil\nb.txt filter=Mixed.Case\nc.txt filter=proc\n');
  for (const n of ['b', 'c']) writeFileSync(join(f.wt, `${n}.txt`), n);
  const g = gitIn(f.wt);
  g('-c', 'filter.evil.clean=', '-c', 'filter.Mixed.Case.clean=', '-c', 'filter.proc.process=', '-c', 'filter.proc.required=false', 'add', '-A');
  g('-c', 'filter.evil.clean=', '-c', 'filter.Mixed.Case.clean=', '-c', 'filter.proc.process=', '-c', 'filter.proc.required=false', 'commit', '-qm', 'attrs');
  rmSync(marker, { force: true });
  const later = new Date(Date.now() + 5000);
  for (const n of ['a', 'b', 'c']) utimesSync(join(f.wt, `${n}.txt`), later, later); // stat-dirty, content unchanged
  const r = resume(f);
  assert.strictEqual(r.status, 0, r.stdout);
  assert.deepStrictEqual(json(r).blocked, []);
  assert.strictEqual(existsSync(marker), false, 'resume ran a filter driver');
  sh(f.wt, '--no-optional-locks', 'status', '--porcelain');
  assert.strictEqual(existsSync(marker), true, 'control: plain git status runs it');
});

test('§5.2: commits merged in from main (an earlier run\'s trailers) are not this run\'s orphans', () => {
  const f = fixture();
  const sha = commit(f, 'c1', 't1');
  writeFileSync(join(f.app, 'old.txt'), 'old');
  gitIn(f.app)('add', '-A'); gitIn(f.app)('commit', '-qm', 'old', '--trailer', 'QK-Task: old-run-task');
  gitIn(f.wt)('merge', '-q', '--no-edit', 'main');
  seed(f, started(f), ...lifecycle(sha));
  const r = resume(f);
  assert.strictEqual(r.status, 0, r.stdout); // the merge commit itself carries no trailer
  assert.deepStrictEqual(json(r).divergences, []);
  assert.deepStrictEqual(json(r).done, ['t1']);
});

test('§5.2: an unknown task id in the second repo of a multi-repo run -> orphan_commits', () => {
  const f = fixture();
  const lib = join(f.org, 'lib'); mkdirSync(lib);
  const g = gitIn(lib);
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  writeFileSync(join(lib, 'l.txt'), 'l'); g('add', '-A'); g('commit', '-qm', 'init');
  const libBase = sh(lib, 'rev-parse', 'HEAD');
  g('checkout', '-q', '-b', 'feat/l');
  writeFileSync(join(lib, 'x.txt'), 'x'); g('add', '-A'); g('commit', '-qm', 'x', '--trailer', 'QK-Task: t9');
  const ghost = sh(lib, 'rev-parse', 'HEAD');
  g('checkout', '-q', 'main');
  const sha = commit(f, 'c1', 't1');
  const run = { ...started(f), repos: [{ name: 'app', base_sha: f.base }, { name: 'lib', base_sha: libBase }] };
  seed(f, run, ...lifecycle(sha), task('pending', { task_id: 't2', repo: 'lib', branch: 'feat/l', worktree: 'lib-wt' }));
  const r = resume(f);
  assert.strictEqual(r.status, 1, r.stdout);
  assert.deepStrictEqual(json(r).divergences, [{ task_id: 't9', kind: 'orphan_commits', commits: [ghost] }]);
  assert.deepStrictEqual(json(r).done, ['t1']);
});

test('§2: a repo that became a symlink cannot be trusted -> resume is indeterminate (exit 2)', () => {
  const f = fixture();
  seed(f, started(f), task('pending'));
  const moved = join(f.org, 'app-real');
  spawnSync('mv', [f.app, moved]); symlinkSync(moved, f.app);
  assert.strictEqual(resume(f).status, 2);
});

test('§2: a worktree that belongs to a different repo, or is a symlink, is refused -> exit 2', () => {
  const f = fixture();
  const other = join(f.org, 'other'); mkdirSync(other);
  const g = gitIn(other); g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  writeFileSync(join(other, 'x'), 'x'); g('add', '-A'); g('commit', '-qm', 'x');
  seed(f, started(f), task('pending', { worktree: 'other' }), task('in_progress', { worktree: 'other' }));
  assert.strictEqual(resume(f).status, 2);
  const h = fixture();
  symlinkSync(h.wt, join(h.org, 'wt-link'));
  seed(h, started(h), task('pending', { worktree: 'wt-link' }), task('in_progress', { worktree: 'wt-link' }));
  assert.strictEqual(resume(h).status, 2);
});

// ---- §6: finding unfinished runs ----

test('§6: open lists the runs that have no run_finished, including ones whose journal is unreadable', () => {
  const f = fixture();
  seed(f, started(f));
  const r = cli(['open', '--org', f.org]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(json(r), { open: [RUN] });
  append(f, 1, { v: 1, type: 'run_finished', verdict: 'kill' });
  assert.deepStrictEqual(json(cli(['open', '--org', f.org])), { open: [] });
  const other = 'fedcba9876543210';
  mkdirSync(join(f.org, '.quality-kernel', 'runs', other));
  writeFileSync(join(f.org, '.quality-kernel', 'runs', other, 'journal.jsonl'), 'garbage\n');
  assert.deepStrictEqual(json(cli(['open', '--org', f.org])), { open: [other] });
});

test('§4/§6: a first append that is refused leaves no run behind — open stays empty', () => {
  const f = fixture();
  assert.strictEqual(append(f, 0, { v: 1, type: 'bogus' }).status, 2);
  assert.strictEqual(append(f, 1, started(f)).status, 3);
  assert.strictEqual(append(f, 0, task('pending')).status, 2, 'the first record must be run_started');
  assert.strictEqual(existsSync(runDirOf(f.org)), false);
  assert.deepStrictEqual(json(cli(['open', '--org', f.org])), { open: [] });
  // A run directory with no journal at all (a crash before the first write) is not an open run either.
  mkdirSync(join(f.org, '.quality-kernel', 'runs', 'fedcba9876543210'), { recursive: true });
  assert.deepStrictEqual(json(cli(['open', '--org', f.org])), { open: [] });
  assert.strictEqual(append(f, 0, started(f)).status, 0);
  assert.deepStrictEqual(json(cli(['open', '--org', f.org])), { open: [RUN] });
});

test('CLI: malformed arguments exit 2 with nothing written', () => {
  const f = fixture();
  seed(f, started(f));
  const before = readFileSync(journalFile(f.org), 'utf8');
  const rec = JSON.stringify(task('pending'));
  const base = ['append', '--org', f.org, '--run', RUN];
  const cases = {
    'empty seq': [...base, '--expect-seq', '', '--record', rec],
    'negative seq': [...base, '--expect-seq', '-1', '--record', rec],
    'fractional seq': [...base, '--expect-seq', '1.5', '--record', rec],
    'hex seq': [...base, '--expect-seq', '0x1', '--record', rec],
    'text seq': [...base, '--expect-seq', 'abc', '--record', rec],
    'missing seq': [...base, '--record', rec],
    'record not JSON': [...base, '--expect-seq', '1', '--record', '{nope'],
    'missing --run': ['append', '--org', f.org, '--expect-seq', '1', '--record', rec],
    'missing --org': ['append', '--run', RUN, '--expect-seq', '1', '--record', rec],
    'unknown command': ['frobnicate', '--org', f.org, '--run', RUN],
    'inherited name as command': ['toString', '--org', f.org, '--run', RUN],
    'constructor as command': ['constructor', '--org', f.org, '--run', RUN],
  };
  for (const [name, args] of Object.entries(cases)) {
    const r = cli(args);
    assert.strictEqual(r.status, 2, `${name}: ${r.stdout}`);
    assert.strictEqual(json(r).ok, false, name);
  }
  assert.strictEqual(readFileSync(journalFile(f.org), 'utf8'), before);
});

test('§3: task ids that are names of built-in object properties are ordinary ids', () => {
  const f = fixture();
  const ids = ['constructor', 'toString', '__proto__', 'hasOwnProperty'];
  seed(f, started(f), ...ids.map((id) => task('pending', { task_id: id })));
  const state = json(fold(f));
  assert.deepStrictEqual(Object.keys(state.tasks).sort(), [...ids].sort());
  for (const id of ids) assert.strictEqual(state.tasks[id].state, 'pending', id);
});

test('§2: a journal of exactly 16 MiB is read; one byte more is refused (exit 2)', () => {
  const f = fixture();
  seed(f, started(f));
  const MAX = 16 * 1024 * 1024;
  const head = readFileSync(journalFile(f.org));
  // Padding without a newline is a torn tail: ignored by fold, but it counts toward the size limit.
  writeFileSync(journalFile(f.org), Buffer.concat([head, Buffer.alloc(MAX - head.length, 'x')]));
  const ok = fold(f);
  assert.strictEqual(ok.status, 0, ok.stdout);
  assert.strictEqual(json(ok).torn_tail, true);
  appendFileSync(journalFile(f.org), 'x');
  assert.strictEqual(fold(f).status, 2);
});

test('§3/§8.5: a decision appended through the CLI restarts a blocked task, and resume continues it', () => {
  const f = fixture();
  seed(f, started(f), task('pending'), task('blocked', { reason: 'needs a human' }));
  let r = resume(f);
  assert.deepStrictEqual(json(r).blocked, [{ task_id: 't1', reason: 'needs a human' }]);
  const d = append(f, 3, { v: 1, type: 'decision', task_id: 't1', ref: 'ADR-7' });
  assert.strictEqual(d.status, 0, d.stdout);
  const t = json(fold(f)).tasks.t1;
  assert.deepStrictEqual([t.state, t.decision, t.reds], ['pending', 'ADR-7', 0]);
  r = resume(f);
  assert.strictEqual(r.status, 0, r.stdout);
  assert.deepStrictEqual(json(r).continue, ['t1']);
  assert.deepStrictEqual(json(r).blocked, []);
});

// ---- review rework: reason, required head_sha, writer limits (§3, §4) ----

test('§3: a reason belongs to its record — after a decision, a later blocked without one is reported as journaled', () => {
  const f = fixture();
  seed(f, started(f), task('pending'), task('blocked', { reason: 'design question' }), { v: 1, type: 'decision', task_id: 't1', ref: 'ADR-7' });
  assert.strictEqual(Object.hasOwn(json(fold(f)).tasks.t1, 'reason'), false);
  assert.strictEqual(append(f, 4, task('blocked')).status, 0);
  const r = resume(f);
  assert.strictEqual(r.status, 0, r.stdout);
  assert.deepStrictEqual(json(r).blocked, [{ task_id: 't1', reason: 'journaled' }]);
});

test('§3: committed without head_sha exits 2 and writes nothing', () => {
  const f = fixture();
  seed(f, started(f), task('pending'), task('in_progress'));
  const before = readFileSync(journalFile(f.org), 'utf8');
  const r = append(f, 3, task('committed'));
  assert.strictEqual(r.status, 2, r.stdout);
  assert.strictEqual(readFileSync(journalFile(f.org), 'utf8'), before);
});

test('§3: task_id is at most 64 characters and reason at most 500', () => {
  const f = fixture();
  seed(f, started(f));
  assert.strictEqual(append(f, 1, task('pending', { task_id: 'a'.repeat(65) })).status, 2);
  assert.strictEqual(append(f, 1, task('pending', { task_id: 'a'.repeat(64) })).status, 0);
  assert.strictEqual(append(f, 2, task('pending')).status, 0);
  assert.strictEqual(append(f, 3, task('blocked', { reason: 'r'.repeat(501) })).status, 2);
  assert.strictEqual(append(f, 3, task('blocked', { reason: 'r'.repeat(500) })).status, 0);
});

test('§4: a torn first line (crash during the very first write) is cut before the first record lands', () => {
  const f = fixture();
  mkdirSync(runDirOf(f.org), { recursive: true });
  writeFileSync(journalFile(f.org), '{"v":1,"ty');
  assert.strictEqual(json(fold(f)).torn_tail, true);
  assert.strictEqual(append(f, 0, started(f)).status, 0);
  assert.strictEqual(readFileSync(journalFile(f.org), 'utf8'), `${JSON.stringify(started(f))}\n`);
  const after = json(fold(f));
  assert.strictEqual(after.seq, 1); assert.strictEqual(after.torn_tail, false);
});

test('§4: an absent or empty journal folds to the empty state; resume of it is indeterminate', () => {
  const f = fixture();
  for (const make of [() => {}, () => { mkdirSync(runDirOf(f.org), { recursive: true }); writeFileSync(journalFile(f.org), ''); }]) {
    make();
    const r = fold(f);
    assert.strictEqual(r.status, 0, r.stdout);
    assert.deepStrictEqual(json(r), { ok: true, seq: 0, torn_tail: false, run: null, tasks: {}, finished: null });
    assert.strictEqual(resume(f).status, 2);
  }
});

test('§2: an --org inside a git repository is refused (exit 2) and nothing is created there', () => {
  const f = fixture();
  for (const org of [f.app, join(f.app, 'sub')]) {
    mkdirSync(org, { recursive: true });
    const r = cli(['append', '--org', org, '--run', RUN, '--expect-seq', '0', '--record', JSON.stringify(started(f))]);
    assert.strictEqual(r.status, 2, r.stdout);
    assert.match(json(r).error, /is inside a git repository, not an org folder/);
    assert.strictEqual(existsSync(join(org, '.quality-kernel')), false);
  }
});

// A journal of exactly `target` bytes of valid records whose state ends with t1 pending.
const MAX_JOURNAL = 16 * 1024 * 1024;
function fillJournal(f, target) {
  const blocked = (n) => `${JSON.stringify(task('blocked', { reason: 'x'.repeat(n) }))}\n`;
  const decision = (n) => `${JSON.stringify({ v: 1, type: 'decision', task_id: 't1', ref: 'y'.repeat(n) })}\n`;
  const bB = blocked(0).length; const bD = decision(0).length; const P = bB + bD + 1000;
  const lines = [`${JSON.stringify(started(f))}\n`, `${JSON.stringify(task('pending'))}\n`];
  let size = lines.join('').length;
  const full = blocked(500) + decision(500);
  while (target - size > 4 * P) { lines.push(full); size += full.length; }
  let slack = target - size - 4 * (bB + bD) - 8;
  assert.ok(slack >= 0 && slack <= 8 * 499, `fill slack ${slack}`);
  for (let i = 0; i < 4; i++) {
    const a = 1 + Math.min(499, slack); slack -= a - 1;
    const b = 1 + Math.min(499, slack); slack -= b - 1;
    lines.push(blocked(a) + decision(b));
  }
  mkdirSync(runDirOf(f.org), { recursive: true });
  const text = lines.join('');
  assert.strictEqual(Buffer.byteLength(text), target);
  writeFileSync(journalFile(f.org), text);
  return 2 + (lines.length - 2) * 2;
}

test('§4: an append that would push the journal past 16 MiB is refused (exit 2); one that reaches it exactly lands', () => {
  const next = task('blocked', { reason: 'last' });
  const L = Buffer.byteLength(`${JSON.stringify(next)}\n`);
  const over = fixture();
  const seq = fillJournal(over, MAX_JOURNAL - L + 1);
  const before = readFileSync(journalFile(over.org));
  const r = append(over, seq, next);
  assert.strictEqual(r.status, 2, r.stdout);
  assert.ok(readFileSync(journalFile(over.org)).equals(before));
  const exact = fixture();
  fillJournal(exact, MAX_JOURNAL - L);
  assert.strictEqual(append(exact, seq, next).status, 0);
  assert.strictEqual(statSync(journalFile(exact.org)).size, MAX_JOURNAL);
  assert.strictEqual(json(fold(exact)).seq, seq + 1);
});

// Replaces a node:fs function for the in-process writer (ESM named imports follow syncBuiltinESMExports).
function withFs(name, impl, fn) {
  const m = mock.method(fs, name, impl);
  syncBuiltinESMExports();
  try { return fn(); } finally { m.mock.restore(); syncBuiltinESMExports(); }
}
const inoOf = (fd) => fs.fstatSync(fd).ino;

test('§4: the journal is fsynced on every append and its directory when the journal is created', () => {
  const f = fixture();
  const orig = fs.fsyncSync;
  const synced = [];
  const spy = (fd) => { synced.push(inoOf(fd)); return orig(fd); };
  withFs('fsyncSync', spy, () => assert.strictEqual(store.append(f.org, RUN, 0, started(f)).code, 0));
  const jIno = statSync(journalFile(f.org)).ino; const dIno = statSync(runDirOf(f.org)).ino;
  assert.strictEqual(synced.filter((i) => i === jIno).length, 1, 'journal fsync on create');
  assert.strictEqual(synced.filter((i) => i === dIno).length, 1, 'directory fsync on create');
  synced.length = 0;
  withFs('fsyncSync', spy, () => assert.strictEqual(store.append(f.org, RUN, 1, task('pending')).code, 0));
  assert.strictEqual(synced.filter((i) => i === jIno).length, 1, 'journal fsync on append');
  assert.strictEqual(synced.filter((i) => i === dIno).length, 0, 'no directory fsync once it exists');
});

test('§4: a short write is cut back and reported (exit 2); a failed fsync is reported as not confirmed durable', () => {
  const f = fixture();
  seed(f, started(f));
  const jIno = statSync(journalFile(f.org)).ino;
  const before = readFileSync(journalFile(f.org), 'utf8');
  const origW = fs.writeSync;
  const short = (fd, buf, ...rest) => (inoOf(fd) === jIno ? origW(fd, buf.subarray(0, 5)) : origW(fd, buf, ...rest));
  const r = withFs('writeSync', short, () => store.append(f.org, RUN, 1, task('pending')));
  assert.strictEqual(r.code, 2, JSON.stringify(r));
  assert.strictEqual(readFileSync(journalFile(f.org), 'utf8'), before, 'nothing of the short write is left');
  const origS = fs.fsyncSync;
  const failing = (fd) => { if (inoOf(fd) === jIno) throw Object.assign(new Error('EIO'), { code: 'EIO' }); return origS(fd); };
  const s2 = withFs('fsyncSync', failing, () => store.append(f.org, RUN, 1, task('pending')));
  assert.strictEqual(s2.code, 2, JSON.stringify(s2));
  assert.match(s2.error, /not confirmed durable/);
  assert.strictEqual(json(fold(f)).seq, 2, 'the record was written; the caller must fold before retrying');
});

test('§5.2: resume does not descend into submodules, so a submodule\'s own filter driver never runs', () => {
  const f = fixture();
  const marker = join(f.org, 'sub-filter-ran');
  const src = join(f.org, 'subsrc'); mkdirSync(src);
  const s = gitIn(src);
  s('init', '-q', '-b', 'main'); s('config', 'user.email', 't@t'); s('config', 'user.name', 't');
  writeFileSync(join(src, '.gitattributes'), 'x.txt filter=subevil\n'); writeFileSync(join(src, 'x.txt'), 'x');
  s('add', '-A'); s('commit', '-qm', 'sub');
  const g = gitIn(f.wt);
  const added = g('-c', 'protocol.file.allow=always', 'submodule', '--quiet', 'add', src, 'sub');
  assert.strictEqual(added.status, 0, added.stderr);
  g('commit', '-qm', 'add submodule');
  const sub = join(f.wt, 'sub');
  gitIn(sub)('config', 'filter.subevil.clean', `sh -c 'touch "${marker}"; cat'`);
  seed(f, started(f), task('pending'), task('in_progress'));
  const later = new Date(Date.now() + 5000);
  utimesSync(join(sub, 'x.txt'), later, later); // stat-dirty inside the submodule, content unchanged
  rmSync(marker, { force: true });
  const r = resume(f);
  assert.strictEqual(r.status, 0, r.stdout);
  assert.deepStrictEqual(json(r).blocked, []);
  assert.strictEqual(existsSync(marker), false, 'resume ran a submodule filter driver');
  sh(f.wt, '--no-optional-locks', 'status', '--porcelain');
  assert.strictEqual(existsSync(marker), true, 'control: plain git status descends and runs it');
});

test('§2: when git cannot be run, the org check refuses the append (exit 2) and creates nothing', () => {
  const f = fixture();
  const r = cli(['append', '--org', f.org, '--run', RUN, '--expect-seq', '0', '--record', JSON.stringify(started(f))], { PATH: join(f.org, 'no-bin') });
  assert.strictEqual(r.status, 2, r.stdout + r.stderr);
  assert.match(json(r).error, /cannot run git/);
  assert.strictEqual(existsSync(join(f.org, '.quality-kernel', 'runs')), false);
});

// ---- review rework 2: git as the oracle cannot be bent by the caller's environment or the repo ----

// A green task whose branch was rewritten: its sha is no longer on the branch (sha_unreachable).
function rewrittenGreen() {
  const f = fixture();
  const sha = commit(f, 'c1', 't1');
  seed(f, started(f), ...lifecycle(sha));
  gitIn(f.wt)('reset', '-q', '--hard', f.base);
  const tip = commit(f, 'c2');
  return { f, sha, tip };
}

test('§5.2: neither a graft file in the repo nor GIT_GRAFT_FILE in the environment can forge ancestry', () => {
  const { f, sha, tip } = rewrittenGreen();
  const expected = [{ task_id: 't1', kind: 'sha_unreachable', sha }];
  let r = resume(f);
  assert.strictEqual(r.status, 1, r.stdout); assert.deepStrictEqual(json(r).divergences, expected);
  const grafts = join(f.org, 'grafts'); writeFileSync(grafts, `${tip} ${sha}\n`);
  r = resume(f, { GIT_GRAFT_FILE: grafts });
  assert.strictEqual(r.status, 1, r.stdout); assert.deepStrictEqual(json(r).divergences, expected);
  mkdirSync(join(f.app, '.git', 'info'), { recursive: true });
  writeFileSync(join(f.app, '.git', 'info', 'grafts'), `${tip} ${sha}\n`);
  assert.strictEqual(gitIn(f.app)('merge-base', '--is-ancestor', sha, 'feat/a').status, 0, 'control: plain git honours the graft');
  r = resume(f);
  assert.strictEqual(r.status, 1, r.stdout); assert.deepStrictEqual(json(r).divergences, expected);
});

test('§5.2: a trailer separator set by the repo or the environment cannot hide QK-Task commits', () => {
  const f = fixture();
  seed(f, started(f), task('pending'));
  const sha = commit(f, 'stray', 't9');
  const expected = [{ task_id: 't9', kind: 'orphan_commits', commits: [sha] }];
  const check = (env) => { const r = resume(f, env); assert.strictEqual(r.status, 1, r.stdout); assert.deepStrictEqual(json(r).divergences, expected); };
  check();
  check({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'trailer.separators', GIT_CONFIG_VALUE_0: '=' });
  check({ GIT_CONFIG_PARAMETERS: "'trailer.separators'='='" });
  gitIn(f.app)('config', 'trailer.separators', '=');
  assert.strictEqual(sh(f.app, 'log', '-1', '--format=%(trailers:key=QK-Task,valueonly)', 'feat/a'), '', 'control: plain git loses the trailer');
  check();
});

test('§5.2: resume never runs the repo\'s gpg.program (log.showSignature on a signed-looking commit)', () => {
  const f = fixture();
  const marker = join(f.org, 'gpg-ran');
  const prog = join(f.org, 'fake-gpg'); writeFileSync(prog, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`); chmodSync(prog, 0o755);
  commit(f, 'c1');
  const raw = sh(f.app, 'cat-file', 'commit', 'feat/a');
  const at = raw.indexOf('\n\n');
  const signed = `${raw.slice(0, at)}\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n iQEzBAABCAAdFiEE\n -----END PGP SIGNATURE-----${raw.slice(at)}\n`;
  const forged = spawnSync('git', ['-C', f.app, 'hash-object', '-t', 'commit', '-w', '--stdin'], { input: signed, encoding: 'utf8' }).stdout.trim();
  gitIn(f.app)('update-ref', 'refs/heads/feat/a', forged);
  gitIn(f.app)('config', 'log.showSignature', 'true'); gitIn(f.app)('config', 'gpg.program', prog);
  seed(f, started(f), task('pending'), task('in_progress'));
  const r = resume(f);
  assert.strictEqual(r.status, 0, r.stdout);
  assert.strictEqual(existsSync(marker), false, 'resume ran gpg.program');
  sh(f.app, 'log', '-1', 'feat/a');
  assert.strictEqual(existsSync(marker), true, 'control: plain git log runs it');
});

test('§2: the org-in-repo check fails closed — a ceiling in the environment or an unreadable repo is refused', () => {
  const f = fixture();
  const org = join(f.app, 'sub'); mkdirSync(org);
  const rec = JSON.stringify(started(f));
  const r1 = cli(['append', '--org', org, '--run', RUN, '--expect-seq', '0', '--record', rec], { GIT_CEILING_DIRECTORIES: f.app });
  assert.strictEqual(r1.status, 2, r1.stdout);
  gitIn(f.app)('config', 'core.repositoryformatversion', '99');
  const r2 = cli(['append', '--org', org, '--run', RUN, '--expect-seq', '0', '--record', rec]);
  assert.strictEqual(r2.status, 2, r2.stdout);
  assert.match(json(r2).error, /cannot tell whether/);
  assert.strictEqual(existsSync(join(org, '.quality-kernel')), false);
});

test('INV-3: a torn tail that is itself a complete, valid record is still ignored', () => {
  const f = fixture();
  seed(f, started(f), task('pending'));
  const clean = json(fold(f));
  appendFileSync(journalFile(f.org), JSON.stringify(task('blocked', { reason: 'torn' })));
  const torn = json(fold(f));
  assert.strictEqual(torn.torn_tail, true);
  assert.deepStrictEqual({ ...torn, torn_tail: false }, clean);
  const r = resume(f);
  assert.strictEqual(r.status, 0, r.stdout);
  assert.deepStrictEqual({ continue: json(r).continue, blocked: json(r).blocked }, { continue: ['t1'], blocked: [] });
});

test('§5.2: a filter driver whose name cannot be overridden makes resume indeterminate (exit 2)', () => {
  const f = fixture();
  seed(f, started(f), task('pending'), task('in_progress'));
  const set = gitIn(f.app)('config', 'filter.a=b.clean', 'cat');
  assert.strictEqual(set.status, 0, set.stderr);
  const r = resume(f);
  assert.strictEqual(r.status, 2, r.stdout);
  assert.match(json(r).error, /cannot be disabled/);
});

test('§5.2: committed and gate_red tasks are active — a missing worktree is worktree_missing', () => {
  for (const tail of [(sha) => [task('committed', { head_sha: sha })], (sha) => [task('committed', { head_sha: sha }), red(sha)]]) {
    const f = fixture();
    const sha = commit(f, 'c1', 't1');
    seed(f, started(f), task('pending'), task('in_progress'), ...tail(sha));
    gitIn(f.app)('worktree', 'remove', '--force', f.wt);
    const r = resume(f);
    assert.strictEqual(r.status, 1, r.stdout);
    assert.deepStrictEqual(json(r).divergences, [{ task_id: 't1', kind: 'worktree_missing', worktree: 'app-wt' }]);
  }
});

test('§3: plan_ref and ref are at most 500 characters; base_sha may be a 64-hex (SHA-256) id; gate.at must be a real date', () => {
  const f = fixture();
  const s = (extra) => ({ ...started(f), ...extra });
  assert.strictEqual(append(f, 0, s({ plan_ref: 'p'.repeat(501) })).status, 2);
  assert.strictEqual(append(f, 0, s({ repos: [{ name: 'app', base_sha: 'a'.repeat(63) }] })).status, 2);
  assert.strictEqual(append(f, 0, s({ repos: [{ name: 'app', base_sha: 'a'.repeat(65) }] })).status, 2);
  const g = fixture();
  assert.strictEqual(append(g, 0, { ...started(g), repos: [{ name: 'app', base_sha: 'a'.repeat(64) }] }).status, 0);
  assert.strictEqual(append(f, 0, s({ plan_ref: 'p'.repeat(500) })).status, 0);
  assert.strictEqual(append(f, 1, task('pending')).status, 0);
  assert.strictEqual(append(f, 2, task('blocked')).status, 0);
  const decision = (ref) => ({ v: 1, type: 'decision', task_id: 't1', ref });
  assert.strictEqual(append(f, 3, decision('r'.repeat(501))).status, 2);
  assert.strictEqual(append(f, 3, decision('r'.repeat(500))).status, 0);
  const sha = commit(f, 'c1', 't1');
  for (const r of [task('in_progress'), task('committed', { head_sha: sha })]) assert.strictEqual(append(f, json(fold(f)).seq, r).status, 0);
  const seq = json(fold(f)).seq;
  assert.strictEqual(append(f, seq, green(sha, { gate: { exit: 0, at: '2026-02-30T00:00:00Z' } })).status, 2);
  assert.strictEqual(append(f, seq, green(sha, { gate: { exit: 0, at: '2026-02-28T23:59:59.5Z' } })).status, 0);
});

// Point the commit-graph's first parent of `child` at `parent` (the file's trailing checksum is not
// verified when git loads it), so plain git believes an ancestry that the objects do not have.
function forgeCommitGraphParent(repo, child, parent) {
  const r = spawnSync('git', ['-C', repo, 'commit-graph', 'write', '--stdin-commits'], { input: `${child}\n${parent}\n`, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const file = join(repo, '.git', 'objects', 'info', 'commit-graph');
  const buf = readFileSync(file);
  const chunks = {};
  for (let i = 0; i < buf[6]; i++) chunks[buf.toString('latin1', 8 + i * 12, 12 + i * 12)] = Number(buf.readBigUInt64BE(12 + i * 12));
  const oids = Array.from({ length: buf.readUInt32BE(chunks.OIDF + 255 * 4) }, (_, i) => buf.toString('hex', chunks.OIDL + i * 20, chunks.OIDL + i * 20 + 20));
  const ci = oids.indexOf(child), pi = oids.indexOf(parent);
  assert.ok(ci >= 0 && pi >= 0, 'both commits are in the graph');
  buf.writeUInt32BE(pi, chunks.CDAT + ci * 36 + 20);
  chmodSync(file, 0o644);
  writeFileSync(file, buf);
}

test('§5.2: a forged commit-graph cannot make an unreachable green sha reachable', () => {
  const { f, sha, tip } = rewrittenGreen();
  forgeCommitGraphParent(f.app, tip, sha);
  assert.strictEqual(gitIn(f.app)('merge-base', '--is-ancestor', sha, 'feat/a').status, 0, 'control: plain git trusts the forged graph');
  const r = resume(f);
  assert.strictEqual(r.status, 1, r.stdout);
  assert.deepStrictEqual(json(r).divergences, [{ task_id: 't1', kind: 'sha_unreachable', sha }]);
});
