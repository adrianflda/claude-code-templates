#!/usr/bin/env node
/**
 * pre-push-review v2 — Claude Code PreToolUse gate.
 *
 * Runs when Claude Code is about to execute a Bash command. If the command contains a real
 * `git push`, the commits about to be pushed are reviewed (scripts/review.mjs --branch) and
 * the push is blocked when a blocking finding is found.
 *
 * Protocol: reads the PreToolUse JSON on stdin. Exit 0 allows the command; exit 2 blocks it
 * and stderr is fed back to the model as the reason.
 *
 * Bypass once: prefix the push with PREPUSH_REVIEW_SKIP=1, or export it in the environment.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './lib/config.mjs';
import { gitValue, repoRoot } from './lib/git.mjs';
import { findPushes } from './lib/push.mjs';

const here = dirname(fileURLToPath(import.meta.url));

function readStdin() {
  return new Promise((done) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      if (data.length < 1_000_000) data += c;
    });
    process.stdin.on('end', () => done(data));
    setTimeout(() => done(data), 2000).unref?.();
  });
}

function allow(message) {
  if (message) process.stdout.write(`[pre-push-review] ${message}\n`);
  process.exit(0);
}

if (process.env.PREPUSH_REVIEW_SKIP === '1' || process.env.AI_REVIEW_SKIP === '1') allow();

let payload = {};
try {
  payload = JSON.parse((await readStdin()) || '{}');
} catch {
  allow(); // not a payload this gate understands
}

const toolName = payload.tool_name ?? payload.toolName ?? '';
const command = (payload.tool_input ?? payload.toolInput ?? {}).command ?? '';
if (toolName !== 'Bash') allow();

const pushes = findPushes(command).filter((p) => !p.skip);
if (pushes.length === 0) allow();

const baseCwd = payload.cwd || process.cwd();
const reports = [];
let blocked = false;

// One review per distinct repository the command pushes from.
const roots = new Set();
for (const push of pushes) {
  const cwd = push.dir ? (isAbsolute(push.dir) ? push.dir : resolve(baseCwd, push.dir)) : baseCwd;
  const root = existsSync(cwd) ? repoRoot(cwd) : null;
  if (root) roots.add(root);
}

for (const root of roots) {
  const { config, errors } = loadConfig(root);
  if (errors.length) {
    // A broken config must not silently turn the gate off.
    process.stderr.write(`pre-push-review cannot run in ${root}: the configuration is invalid.\n${errors.map((e) => `  - ${e}`).join('\n')}\nFix .pre-push-review.json, or bypass once with PREPUSH_REVIEW_SKIP=1.\n`);
    process.exit(2);
  }
  if (!config.gate.enabled) continue;

  const args = [join(here, 'review.mjs'), '--branch', '--format', 'text', '--cwd', root];
  if (!config.gate.repoCommands) args.push('--no-repo-commands');
  if (!config.gate.summary) args.push('--no-summary');
  const run = spawnSync('node', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;

  if (run.status === 1) {
    blocked = true;
    reports.push(output);
  } else if (run.status === 2) {
    blocked = true;
    reports.push(`The review could not run in ${root}:\n${output}`);
  } else if (run.status === 0) {
    // Marker keyed on the reviewed commit, so a repo-level git hook can skip a second review.
    try {
      const sha = gitValue(['rev-parse', 'HEAD'], { cwd: root });
      const dir = join(homedir(), '.cache', 'git-ai-review');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `pass-${sha}`), String(Date.now()));
    } catch {
      /* the marker is best-effort */
    }
    reports.push((output.match(/SUMMARY:.*/) ?? ['(review ran)'])[0]);
  } else {
    // Killed or crashed: say so instead of passing quietly.
    blocked = true;
    reports.push(`The review process ended abnormally in ${root} (signal ${run.signal ?? 'unknown'}).`);
  }
}

if (blocked) {
  process.stderr.write(
    'pre-push-review BLOCKED this push.\n\n' +
      reports.join('\n\n') +
      '\n\nFix the blocking finding(s) and push again. If a finding is wrong, tell the user why and let them decide; ' +
      'to bypass once they can prefix the push with PREPUSH_REVIEW_SKIP=1.\n',
  );
  process.exit(2);
}
allow(reports.join(' | '));
