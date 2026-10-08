#!/usr/bin/env node
/**
 * pre-push-review — the single review runner, invoked by git itself as a pre-push hook.
 *
 * It is installed once per machine as a git config hook (see ./install-git-hook.mjs):
 *
 *   hook.ai-review.event   = pre-push
 *   hook.ai-review.command = node <plugin>/scripts/git-pre-push.mjs
 *
 * Config hooks run in every repository, also when a repository sets its own core.hooksPath
 * (husky and friends), so the review applies to every `git push`, by Claude or by a human.
 *
 * It reviews exactly what git says is being pushed. For every ref on stdin it computes the
 * commits that are new to the remote: `<remote sha>..<local sha>` when the remote already has
 * the ref, otherwise the commits not on any ref of that remote (a new branch, or the first
 * push to an empty remote, where the review starts from the empty tree). Each range is passed
 * to the bundled panel (./ai-review-panel.mjs --range <base> <head>), so pushing a branch that
 * is not checked out reviews that branch, not HEAD. Without a clean list of refs it falls back
 * to `--branch` (the panel's own guess). It streams the panel output to the terminal, keeps the full log in ~/.cache/git-ai-review/review-<sha>.log
 * and exits 0 only when the review finished and found nothing blocking (or there is nothing to
 * review, e.g. a branch deletion). It fails closed: a missing, killed, timed out or unstartable
 * panel exits 1.
 *
 * It honors no skip switch: AI_REVIEW_SKIP, PREPUSH_REVIEW_SKIP and AI_REVIEW_REQUIRED are
 * removed or forced in the environment given to the panel. The only way past it is the human
 * typing `git push --no-verify`, which git itself implements and no hook can see.
 */
import { spawn, spawnSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const TIMEOUT_MS = Number(process.env.AI_REVIEW_GATE_TIMEOUT_MS || 540_000);
const ZERO = /^0+$/;

const say = (msg) => process.stderr.write(`${msg}\n`);
const fail = (msg) => {
  say(`[pre-push-review] PUSH BLOCKED: ${msg}`);
  process.exit(1);
};

function readStdin() {
  return new Promise((res) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      if (data.length < 1_000_000) data += c;
    });
    process.stdin.on('end', () => res({ data, clean: true }));
    process.stdin.on('error', () => res({ data, clean: false }));
    setTimeout(() => res({ data, clean: false }), 5000).unref?.();
  });
}

// pre-push stdin: "<local ref> <local sha> <remote ref> <remote sha>" per ref being pushed.
// Only a stream that ended cleanly may short-circuit; a partial read reviews as usual.
const stdin = await readStdin();
const refs = stdin.data
  .split('\n')
  .map((l) => l.trim().split(/\s+/))
  .filter((p) => p.length >= 4);
if (stdin.clean && refs.length && refs.every((p) => ZERO.test(p[1]))) {
  say('[pre-push-review] Only deleting refs: nothing to review.');
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const panel = resolve(here, 'ai-review-panel.mjs');
if (!existsSync(panel)) fail(`the review panel is missing (${panel}), so nothing can be reviewed. Reinstall the plugin.`);

const git = (args, input) => spawnSync('git', args, { encoding: 'utf8', cwd: root, input });
const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
const root = top.status === 0 && top.stdout.trim() ? top.stdout.trim() : process.cwd();
const SHA = /^[0-9a-f]{40,64}$/;
const lines = (r) => (r.status === 0 ? r.stdout.split('\n').filter(Boolean) : null);

// git passes the remote name (or the URL when pushing to one) as the first argument.
const remoteArg = process.argv[2] || '';
const remotes = lines(git(['remote'])) || [];
const notOnRemote = remotes.includes(remoteArg) ? `--remotes=${remoteArg}` : '--remotes';

/** The [base, head] range of commits a ref push sends that the remote does not have yet. */
function rangeFor(localSha, remoteSha) {
  let commits = null;
  if (!ZERO.test(remoteSha) && git(['cat-file', '-e', `${remoteSha}^{commit}`]).status === 0) {
    commits = lines(git(['rev-list', localSha, `^${remoteSha}`]));
  } else {
    // A new branch, an empty remote, or a remote tip we do not have: everything that is not
    // already on that remote is being sent.
    commits = lines(git(['rev-list', localSha, '--not', notOnRemote]));
  }
  if (commits === null) return { error: `cannot list the commits pushed by ${localSha.slice(0, 7)}` };
  if (!commits.length) return null; // the remote already has every commit (e.g. a new name for them)
  const oldest = commits[commits.length - 1];
  const parent = git(['rev-parse', '--verify', '--quiet', `${oldest}^`]);
  let base = parent.status === 0 ? parent.stdout.trim() : '';
  if (!base) {
    // The root commit is being pushed: review it against the empty tree.
    const empty = git(['hash-object', '-t', 'tree', '--stdin'], '');
    base = empty.status === 0 ? empty.stdout.trim() : '';
  }
  if (!SHA.test(base)) return { error: `cannot find the base of the commits pushed by ${localSha.slice(0, 7)}` };
  return { base, head: localSha };
}

// One panel run per distinct range; a ref list we cannot trust falls back to the panel's guess.
const runs = [];
const usableRefs = stdin.clean && refs.length && refs.every((p) => SHA.test(p[1]) && SHA.test(p[3]));
if (usableRefs) {
  const seen = new Set();
  for (const [, localSha, , remoteSha] of refs) {
    if (ZERO.test(localSha)) continue; // deleting a ref sends no code
    const r = rangeFor(localSha, remoteSha);
    if (r?.error) fail(`${r.error}, so the push cannot be matched to a review.`);
    if (!r || seen.has(`${r.base} ${r.head}`)) continue;
    seen.add(`${r.base} ${r.head}`);
    runs.push({ args: ['--range', r.base, r.head], head: r.head });
  }
  if (!runs.length) {
    say('[pre-push-review] The remote already has every pushed commit: nothing new to review.');
    process.exit(0);
  }
} else {
  const head = git(['rev-parse', 'HEAD']);
  runs.push({ args: ['--branch'], head: head.status === 0 ? head.stdout.trim() : 'unknown' });
}

// No skip switch is honored; the review is always required.
const env = { ...process.env, AI_REVIEW_REQUIRED: '1' };
delete env.AI_REVIEW_SKIP;
delete env.PREPUSH_REVIEW_SKIP;

// One deadline for the whole push, however many ranges it has.
const deadline = Date.now() + TIMEOUT_MS;

function runPanel(args) {
  return new Promise((done) => {
    const result = { out: '', code: null, failure: '' };
    const finish = () => done(result);
    let child;
    try {
      // Detached: the panel leads its own process group, so the whole tree (its `claude`
      // children included) can be killed together.
      child = spawn(process.execPath, [panel, ...args], {
        cwd: root,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (e) {
      result.failure = `the panel could not run (${e.code || e.message})`;
      return finish();
    }
    // The panel no longer shares our process group: pass an interrupt on to it.
    const onSignal = () => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
      process.exit(1);
    };
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, onSignal);
    const forward = (chunk) => {
      if (result.out.length < 32 * 1024 * 1024) result.out += chunk;
      process.stderr.write(chunk);
    };
    child.stdout.on('data', forward);
    child.stderr.on('data', forward);
    const timer = setTimeout(() => {
      result.failure = `the panel did not finish in ${TIMEOUT_MS} ms`;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
      // Grandchildren may hold the pipes open, so 'close' may never fire: do not wait for it.
      child.stdout.destroy();
      child.stderr.destroy();
      finish();
    }, Math.max(0, deadline - Date.now()));
    child.on('error', (e) => {
      result.failure ||= `the panel could not run (${e.code || e.message})`;
      clearTimeout(timer);
      finish();
    });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      if (!result.failure && signal) result.failure = `the panel was killed by ${signal}`;
      result.code = status;
      finish();
    });
  });
}

let out = '';
let code = 0;
let failure = '';
for (const run of runs) {
  const r = await runPanel(run.args);
  out += `\n$ ai-review-panel ${run.args.join(' ')}\n${r.out}`;
  if (r.failure) {
    failure = r.failure;
    code = null;
    break;
  }
  // Keep the worst outcome: 1 (blocking findings) is reported, any other non-zero is "not reviewed".
  if (r.code !== 0 && (code === 0 || r.code !== 1)) code = r.code;
  if (code !== 0 && code !== 1) break;
}

// Keep the full output: the terminal scrolls away.
try {
  const sha = runs[runs.length - 1].head;
  const cacheDir = join(homedir(), '.cache', 'git-ai-review');
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  chmodSync(cacheDir, 0o700);
  const logFile = join(cacheDir, `review-${sha}.log`);
  writeFileSync(logFile, `repository: ${root}\nexit: ${code}${failure ? ` (${failure})` : ''}\n\n${out}`, {
    mode: 0o600,
  });
  chmodSync(logFile, 0o600);
  say(`[pre-push-review] Full output: ${join(cacheDir, `review-${sha}.log`)}`);
} catch {
  /* the log is best-effort */
}

if (failure) fail(`${failure}; the change was NOT reviewed.`);
if (code === 0) process.exit(0);
if (code === 1) fail('critical issue(s) found by the expert panel. Fix them and push again.');
fail(`no reviewer could run (panel exit ${code}). Check that the \`claude\` CLI is installed and signed in.`);
