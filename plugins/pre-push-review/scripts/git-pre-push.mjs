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
 * It runs the bundled panel (./ai-review-panel.mjs --branch) in the repository root, streams
 * the panel output to the terminal, keeps the full log in ~/.cache/git-ai-review/review-<sha>.log
 * and exits 0 only when the review finished and found nothing blocking (or there is nothing to
 * review, e.g. a branch deletion). It fails closed: a missing, killed, timed out or unstartable
 * panel exits 1.
 *
 * It honors no skip switch: AI_REVIEW_SKIP, PREPUSH_REVIEW_SKIP and AI_REVIEW_REQUIRED are
 * removed or forced in the environment given to the panel. The only way past it is the human
 * typing `git push --no-verify`, which git itself implements and no hook can see.
 */
import { spawn, spawnSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
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
    process.stdin.on('end', () => res(data));
    process.stdin.on('error', () => res(data));
    setTimeout(() => res(data), 5000).unref?.();
  });
}

// pre-push stdin: "<local ref> <local sha> <remote ref> <remote sha>" per ref being pushed.
const refs = (await readStdin())
  .split('\n')
  .map((l) => l.trim().split(/\s+/))
  .filter((p) => p.length >= 4);
if (refs.length && refs.every((p) => ZERO.test(p[1]))) {
  say('[pre-push-review] Only deleting refs: nothing to review.');
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const panel = resolve(here, 'ai-review-panel.mjs');
if (!existsSync(panel)) fail(`the review panel is missing (${panel}), so nothing can be reviewed. Reinstall the plugin.`);

const git = (args) => spawnSync('git', args, { encoding: 'utf8' });
const top = git(['rev-parse', '--show-toplevel']);
const root = top.status === 0 && top.stdout.trim() ? top.stdout.trim() : process.cwd();

// No skip switch is honored; the review is always required.
const env = { ...process.env, AI_REVIEW_REQUIRED: '1' };
delete env.AI_REVIEW_SKIP;
delete env.PREPUSH_REVIEW_SKIP;

let out = '';
let code = null;
let failure = '';
await new Promise((done) => {
  let child;
  try {
    child = spawn(process.execPath, [panel, '--branch'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    failure = `the panel could not run (${e.code || e.message})`;
    return done();
  }
  const forward = (chunk) => {
    if (out.length < 32 * 1024 * 1024) out += chunk;
    process.stderr.write(chunk);
  };
  child.stdout.on('data', forward);
  child.stderr.on('data', forward);
  const timer = setTimeout(() => {
    failure = `the panel did not finish in ${TIMEOUT_MS} ms`;
    child.kill('SIGKILL');
  }, TIMEOUT_MS);
  child.on('error', (e) => {
    failure ||= `the panel could not run (${e.code || e.message})`;
    clearTimeout(timer);
    done();
  });
  child.on('close', (status, signal) => {
    clearTimeout(timer);
    if (!failure && signal) failure = `the panel was killed by ${signal}`;
    code = status;
    done();
  });
});

// Keep the full output: the terminal scrolls away.
try {
  const head = git(['-C', root, 'rev-parse', 'HEAD']);
  const sha = head.status === 0 ? head.stdout.trim() : 'unknown';
  const cacheDir = join(homedir(), '.cache', 'git-ai-review');
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(
    join(cacheDir, `review-${sha}.log`),
    `repository: ${root}\nexit: ${code}${failure ? ` (${failure})` : ''}\n\n${out}`,
  );
  say(`[pre-push-review] Full output: ${join(cacheDir, `review-${sha}.log`)}`);
} catch {
  /* the log is best-effort */
}

if (failure) fail(`${failure}; the change was NOT reviewed.`);
if (code === 0) process.exit(0);
if (code === 1) fail('critical issue(s) found by the expert panel. Fix them and push again.');
fail(`no reviewer could run (panel exit ${code}). Check that the \`claude\` CLI is installed and signed in.`);
