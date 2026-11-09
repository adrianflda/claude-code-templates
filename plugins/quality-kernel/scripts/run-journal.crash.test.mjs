import './hermetic-git.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHECK, CHECK_FILE, writeGateConfig } from './run-journal/test-fixture.mjs';

// INV-1 (spec-run-journal.v1.md §7): after kill -9 of the orchestrator at any phase, `resume` reports
// exactly the tasks that were gate_green before the kill, each with its SHA reachable from its branch.
// A scripted orchestrator works 2 tasks in 2 repos, announces every step and waits; the test SIGKILLs
// it at step k, for every k. The expected answer comes from the orchestrator's own log of confirmed
// appends and commits (written after each one succeeded), never from the journal, and SHAs are checked
// against git directly.
const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, 'run-journal.mjs');
const RUN = '0123456789abcdef';
const AT = '2026-11-07T10:00:00Z';
const REPOS = [{ name: 'app1', task: 't1' }, { name: 'app2', task: 't2' }];
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const gitIn = (dir) => (...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });

function fixture() {
  const org = realpathSync(mkdtempSync(join(tmpdir(), 'qk-rj-crash-'))); dirs.push(org);
  const repos = REPOS.map(({ name, task }) => {
    const dir = join(org, name); mkdirSync(dir);
    const g = gitIn(dir);
    g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
    writeFileSync(join(dir, 'a.txt'), 'a'); writeFileSync(join(dir, CHECK_FILE), CHECK); g('add', '-A'); g('commit', '-qm', 'init');
    g('branch', 'feat/a');
    g('worktree', 'add', '-q', join(org, `${name}-wt`), 'feat/a');
    return { name, task, dir, wt: join(org, `${name}-wt`), base: g('rev-parse', 'HEAD').stdout.trim() };
  });
  writeGateConfig(org, REPOS.map((r) => r.name)); // resume re-runs the real gate (§5.3)
  return { org, repos, log: join(org, 'orchestrator.log') };
}

// The orchestrator: before every step it prints `step <k>` and blocks on stdin; after a step succeeds
// it records it in its own log (appendFileSync is synchronous: the line exists before the next step).
const ORCHESTRATOR = `
import { spawnSync } from 'node:child_process';
import { appendFileSync, writeFileSync, readSync } from 'node:fs';
import { join } from 'node:path';
const [cli, org, run, log, at, reposJson] = process.argv.slice(2);
const repos = JSON.parse(reposJson);
let k = 0; let seq = 0;
const pause = () => { process.stdout.write('step ' + k + '\\n'); const b = Buffer.alloc(1); readSync(0, b); k++; };
const put = (record) => {
  pause();
  const r = spawnSync(process.execPath, [cli, 'append', '--org', org, '--run', run, '--expect-seq', String(seq), '--record', JSON.stringify(record)]);
  if (r.status !== 0) { process.stderr.write(r.stdout + r.stderr); process.exit(9); }
  seq++;
  appendFileSync(log, JSON.stringify({ append: record }) + '\\n');
};
put({ v: 1, type: 'run_started', run_id: run, plan_ref: 'plan.md', repos: repos.map((r) => ({ name: r.name, base_sha: r.base })) });
for (const r of repos) {
  const t = { v: 1, type: 'task', task_id: r.task, repo: r.name, branch: 'feat/a', worktree: r.name + '-wt' };
  put({ ...t, state: 'pending' });
  put({ ...t, state: 'in_progress' });
  pause();
  writeFileSync(join(r.wt, r.task + '.txt'), r.task);
  const g = (...a) => spawnSync('git', ['-C', r.wt, ...a], { encoding: 'utf8' });
  if (g('add', '-A').status !== 0 || g('commit', '-qm', r.task, '--trailer', 'QK-Task: ' + r.task).status !== 0) process.exit(8);
  const sha = g('rev-parse', 'HEAD').stdout.trim();
  appendFileSync(log, JSON.stringify({ commit: r.task, sha }) + '\\n');
  put({ ...t, state: 'committed', head_sha: sha });
  put({ ...t, state: 'gate_green', head_sha: sha, gate: { exit: 0, at } });
}
process.stdout.write('done\\n');
`;
const STEPS = 1 + REPOS.length * 5; // run_started + (pending, in_progress, commit, committed, gate_green) per task

// Runs the orchestrator, letting steps 0..killAt-1 complete, and SIGKILLs it while it waits before
// step killAt (killAt === STEPS: it runs to completion).
function runUntil(f, script, killAt) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, CLI, f.org, RUN, f.log, AT, JSON.stringify(f.repos)], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = ''; let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.stdout.on('data', (d) => {
      buf += d;
      for (let i; (i = buf.indexOf('\n')) >= 0;) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (line === `step ${killAt}`) child.kill('SIGKILL');
        else if (line.startsWith('step ')) child.stdin.write('g');
      }
    });
    child.on('exit', (code, signal) => {
      if (killAt < STEPS && signal !== 'SIGKILL') reject(new Error(`expected a kill at step ${killAt}, got exit ${code}: ${err}`));
      else if (killAt === STEPS && code !== 0) reject(new Error(`orchestrator failed: ${err}`));
      else resolve();
    });
  });
}

const confirmed = (f) => (existsSync(f.log) ? readFileSync(f.log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

for (let killAt = 0; killAt <= STEPS; killAt++) {
  test(`INV-1: SIGKILL before step ${killAt} of ${STEPS} -> resume reports exactly the confirmed greens`, async () => {
    const f = fixture();
    const script = join(f.org, 'orchestrator.mjs');
    writeFileSync(script, ORCHESTRATOR);
    await runUntil(f, script, killAt);

    const log = confirmed(f);
    const greens = log.filter((e) => e.append?.state === 'gate_green').map((e) => e.append.task_id).sort();
    const committedIds = new Set(log.filter((e) => e.append?.state === 'committed').map((e) => e.append.task_id));
    const orphans = log.filter((e) => e.commit && !committedIds.has(e.commit)).map((e) => ({ task_id: e.commit, kind: 'orphan_commits', commits: [e.sha] }));
    const r = spawnSync(process.execPath, [CLI, 'resume', '--org', f.org, '--run', RUN], { encoding: 'utf8' });

    if (!log.some((e) => e.append?.type === 'run_started')) {
      assert.strictEqual(r.status, 2, `no run_started confirmed: resume is indeterminate: ${r.stdout}`);
      return;
    }
    assert.strictEqual(r.status, orphans.length ? 1 : 0, r.stdout);
    const plan = JSON.parse(r.stdout);
    assert.deepStrictEqual(plan.done, greens);
    assert.deepStrictEqual(plan.divergences, orphans);
    assert.strictEqual(plan.torn_tail, false);
    const unfinished = log.filter((e) => e.append?.type === 'task' && !greens.includes(e.append.task_id)).map((e) => e.append.task_id);
    assert.deepStrictEqual(plan.continue, [...new Set(unfinished)].filter((id) => !orphans.some((o) => o.task_id === id)).sort());
    // Each green SHA, as the orchestrator saw it committed, is reachable from its branch (asked of git directly).
    for (const id of greens) {
      const sha = log.find((e) => e.commit === id).sha;
      const repo = f.repos.find((x) => x.task === id);
      assert.strictEqual(gitIn(repo.dir)('merge-base', '--is-ancestor', sha, 'refs/heads/feat/a').status, 0, id);
    }
  });
}
