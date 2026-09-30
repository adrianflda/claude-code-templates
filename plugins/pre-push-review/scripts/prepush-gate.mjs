#!/usr/bin/env node
/**
 * pre-push-review — Claude Code PreToolUse gate.
 *
 * Fires whenever Claude Code is about to run a Bash `git push`, runs the bundled
 * expert panel (./ai-review-panel.mjs) over the commits being pushed, and BLOCKS the
 * push if a blocking (default: critical) issue is found — so code is never pushed
 * without an exhaustive multi-agent review, in every repo, automatically.
 *
 * The panel runs in the repository the push leaves from, which is not always the session's
 * working directory: `cd ../worktree && git push` and `git -C ../worktree push` are followed
 * (see ./push-target.mjs).
 *
 * The gate fails closed. Once a push is found, the push is allowed only if the panel ran in
 * the right repository and finished. It is blocked when the directory cannot be known, when
 * it is not a repository, when the panel is missing, killed or cannot start, and when no
 * reviewer could run. AI_REVIEW_REQUIRED=0 makes only the last case advisory.
 *
 * This is a plugin-local, self-contained hook: it depends only on files shipped inside
 * this plugin (resolved via CLAUDE_PLUGIN_ROOT, with a fallback relative to this file),
 * NOT on any hand-installed ~/.config or ~/.claude script. That is the whole point —
 * portable and versioned instead of per-machine hand-wiring.
 *
 * Protocol: reads the PreToolUse JSON on stdin. Exit 0 = allow the push; exit 2 = block
 * (stderr is fed back to the model as the reason). On allow, the review summary is returned
 * as JSON on stdout so it reaches the session, and the full panel output is kept in
 * ~/.cache/git-ai-review/review-<sha>.log. The gate never sets `permissionDecision`: whether
 * the push may run stays with the normal permission flow.
 *
 * Escape hatch: set PREPUSH_REVIEW_SKIP=1 (or AI_REVIEW_SKIP=1) to bypass.
 */
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { findPushTargets } from './push-target.mjs';

// The panel runs 6 reviewers at up to 240 s each, 3 at a time. Past this limit the review is
// treated as not finished, so the gate answers before the harness gives up on the hook.
const PANEL_TIMEOUT_MS = Number(process.env.PREPUSH_REVIEW_TIMEOUT_MS || 540_000);

const BYPASS =
  '(To bypass once: set PREPUSH_REVIEW_SKIP=1, or ask the user to confirm the override.)\n';
// The line the panel prints last when it reviewed the change and found nothing blocking.
// Only the last line counts: findings quote text that comes from the diff.
const PASSED = '[pre-push-review] Passed. No blocking issues.';
const passed = (out) => out.trimEnd().split('\n').pop().trim() === PASSED;

function readStdin() {
  return new Promise((res) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    // Bound the read — a PreToolUse payload is small; never accumulate unboundedly.
    process.stdin.on('data', (c) => {
      if (data.length < 1_000_000) data += c;
    });
    process.stdin.on('end', () => res(data));
    // Safety: if no stdin arrives, don't hang the tool call.
    setTimeout(() => res(data), 2000).unref?.();
  });
}

function block(message) {
  process.stderr.write(`pre-push-review BLOCKED this push — ${message}\n${BYPASS}`);
  process.exit(2);
}

if (process.env.PREPUSH_REVIEW_SKIP === '1' || process.env.AI_REVIEW_SKIP === '1') {
  process.exit(0);
}

const raw = await readStdin();
let payload = {};
try {
  payload = JSON.parse(raw || '{}');
} catch {
  process.exit(0); // can't parse → don't interfere
}

const toolName = payload.tool_name || payload.toolName || '';
const command = (payload.tool_input || payload.toolInput || {}).command || '';
const baseCwd = payload.cwd || process.cwd();

// Only act on a REAL `git push` command segment — not "push" inside a quoted arg
// (e.g. git commit -m "push ...") or inside another command (echo/printf "git push").
// A push that carries the skip switch inline (`PREPUSH_REVIEW_SKIP=1 git push`) is bypassed.
const targets = toolName === 'Bash' ? findPushTargets(command, baseCwd).filter((t) => !t.skip) : [];
if (!targets.length) process.exit(0);

// From here on there is a push to review: every way out that is not a finished review blocks.

// Resolve the bundled panel. CLAUDE_PLUGIN_ROOT is injected by Claude Code for plugin
// hooks; fall back to this file's own directory so the gate also works when run directly.
const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || resolve(here, '..');
const panel = join(pluginRoot, 'scripts', 'ai-review-panel.mjs');
if (!existsSync(panel)) {
  block(`the review panel is missing (${panel}), so nothing can be reviewed. Reinstall the plugin.`);
}

if (targets.some((t) => !t.known)) {
  block(
    'it cannot tell which repository the push leaves from, because the directory depends on\n' +
      'something only the shell knows (a variable, a command substitution, --git-dir, xargs).\n' +
      'Push with a literal path instead: `git -C <dir> push ...` or `cd <dir> && git push ...`.',
  );
}

const cacheDir = join(homedir(), '.cache', 'git-ai-review');
const gitIn = (dir, args) =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

const reviews = [];
for (const dir of [...new Set(targets.map((t) => t.dir))]) {
  let root;
  try {
    root = gitIn(dir, ['rev-parse', '--show-toplevel']);
  } catch {
    // If the `cd` fails, the shell pushes from wherever it was: that is not what was read here.
    block(`${dir} is not a git repository (or does not exist), so the push cannot be matched to a review.`);
  }

  let out = '';
  let code = 0;
  let failure = '';
  try {
    out = execFileSync('node', [panel, '--branch'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: PANEL_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      env: { ...process.env, AI_REVIEW_REQUIRED: process.env.AI_REVIEW_REQUIRED ?? '1' },
    });
  } catch (e) {
    out = `${e.stdout || ''}${e.stderr || ''}`;
    if (typeof e.status === 'number') code = e.status;
    else {
      // Killed by a signal, could not start, or overflowed its buffer: the review did not finish.
      code = 2;
      failure =
        e.code === 'ETIMEDOUT'
          ? `the panel did not finish in ${PANEL_TIMEOUT_MS} ms`
          : e.signal
            ? `the panel was killed by ${e.signal}`
            : `the panel could not run (${e.code || e.message})`;
    }
  }

  // Keep the full panel output: a pass marker alone does not say what was reviewed.
  let sha = '';
  try {
    sha = gitIn(root, ['rev-parse', 'HEAD']);
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, `review-${sha}.log`),
      `repository: ${root}\nexit: ${code}${failure ? ` (${failure})` : ''}\n\n${out}`,
    );
  } catch {
    /* the log is best-effort */
  }
  reviews.push({ root, sha, out, code, failure });
}

// Panel exit codes: 0 = reviewed (or nothing to push), 1 = blocking issues, anything else =
// the review did not happen. Decide for the whole command before any marker is written.
const critical = reviews.filter((r) => r.code === 1);
if (critical.length) {
  block(
    `critical issue(s) found by the expert panel in ${critical.map((r) => r.root).join(', ')}:\n\n` +
      critical.map((r) => r.out).join('\n') +
      '\nFix the critical issue(s) and push again.',
  );
}
const unreviewed = reviews.filter((r) => r.code !== 0);
if (unreviewed.length) {
  block(
    `${unreviewed.map((r) => r.root).join(', ')} was NOT reviewed: ` +
      `${unreviewed.map((r) => r.failure || `no reviewer could run (panel exit ${r.code})`).join('; ')}.\n\n` +
      unreviewed.map((r) => r.out).join('\n') +
      '\nCheck that the `claude` CLI is installed and signed in, then push again. ' +
      'AI_REVIEW_REQUIRED=0 makes "no reviewer could run" advisory.',
  );
}

const summaries = [];
for (const { root, sha, out } of reviews) {
  // The pass-marker lets an in-repo husky pre-push gate skip re-running the panel. It is
  // written only for a review that ran and passed, never for "nothing to review".
  if (sha && passed(out)) {
    try {
      writeFileSync(join(cacheDir, `pass-${sha}`), String(Date.now()));
    } catch {
      /* marker is best-effort */
    }
  }

  const lines = out.split('\n');
  const pick = (re) => lines.find((l) => re.test(l));
  const [first, ...rest] = [
    pick(/^SUMMARY:/) || pick(/No unpushed commits|No code changes/) || '(the panel printed no summary line)',
    pick(/Reviewing .* with \d+ expert agents/),
    pick(/agent\(s\) failed; review is partial/),
    pick(/All review agents failed/),
    pick(/deleted file\(s\)/),
    pick(/truncating to/),
  ]
    .filter(Boolean)
    .map((l) => l.replace(/^\[pre-push-review\]\s*/, '').trim());
  summaries.push([`${root} @ ${sha.slice(0, 7)}: ${first}`, ...rest].join(' | '));
}

// Surface the result so the review is visible in the transcript and to the model.
const text =
  summaries.map((s) => `[pre-push-review] ${s}`).join('\n') +
  `\n[pre-push-review] Full output: ${join(cacheDir, 'review-<sha>.log')}`;
process.stdout.write(
  JSON.stringify({
    systemMessage: text,
    hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text },
  }) + '\n',
);
process.exit(0);
