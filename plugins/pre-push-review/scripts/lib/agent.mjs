// Headless agent runner: one `claude -p` process per reviewer, verifier or summarizer.
//
// Isolation choices, each verified against the CLI before being relied on:
//   --tools "Read,Grep,Glob"   the agent can explore the repo but cannot write or run anything
//   --permission-prompts none  anything that would need approval is denied, so a read outside
//                              the working directory fails instead of waiting for a human
//   --add-dir <dir>            the only way a directory outside the working directory (the
//                              patch directory) becomes readable
//   --setting-sources ''       no user/project settings, so other plugins' hooks never fire in
//                              the nested session and never pollute its output; OAuth still
//                              works, which --bare would drop
//   --strict-mcp-config        no MCP servers
//   --json-schema              the reply is validated structured output, not prose to scrape

import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { registerCleanup } from './cleanup.mjs';

const MAX_OUTPUT = 16 * 1024 * 1024;
export const READ_ONLY_TOOLS = 'Read,Grep,Glob';

/** Hooks run in a non-login shell whose PATH often lacks ~/.local/bin; look in known places. */
export function resolveClaudeBin(env = process.env) {
  if (env.CLAUDE_BIN) return env.CLAUDE_BIN;
  try {
    const probe = process.platform === 'win32' ? 'where' : 'which';
    const found = execFileSync(probe, ['claude'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n')[0]
      .trim();
    if (found) return found;
  } catch {
    /* fall through to known locations */
  }
  const home = homedir();
  for (const candidate of [
    resolve(home, '.local/bin/claude'),
    resolve(home, '.claude/local/claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return process.platform === 'win32' ? 'claude.cmd' : 'claude';
}

export function buildArgs({ model, systemPrompt, schema, tools = READ_ONLY_TOOLS, addDirs = [], maxBudgetUsd = null }) {
  const args = [
    '-p',
    '--setting-sources', '',
    '--model', model,
    '--tools', tools,
    '--permission-prompts', 'none',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--output-format', 'json',
    '--json-schema', JSON.stringify(schema),
    '--append-system-prompt', systemPrompt,
  ];
  for (const dir of addDirs) args.push('--add-dir', dir);
  if (maxBudgetUsd != null) args.push('--max-budget-usd', String(maxBudgetUsd));
  return args;
}

/** Pull the structured reply out of the CLI's JSON envelope. Returns { output } or { error }. */
export function parseEnvelope(stdout) {
  const raw = String(stdout ?? '').trim();
  if (!raw) return { error: 'empty output' };
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return { error: 'output is not JSON' };
  }
  // With --output-format json the CLI prints one result object; tolerate an event array.
  if (Array.isArray(envelope)) envelope = envelope.filter((e) => e?.type === 'result').pop();
  if (!envelope || typeof envelope !== 'object') return { error: 'no result object in output' };

  const meta = {
    costUsd: Number.isFinite(envelope.total_cost_usd) ? envelope.total_cost_usd : null,
    turns: Number.isInteger(envelope.num_turns) ? envelope.num_turns : null,
    denials: Array.isArray(envelope.permission_denials) ? envelope.permission_denials.length : 0,
  };
  if (envelope.is_error) {
    return { error: `agent reported an error (${envelope.subtype ?? 'unknown'}): ${String(envelope.result ?? '').slice(0, 200)}`, ...meta };
  }
  if (envelope.structured_output && typeof envelope.structured_output === 'object') {
    return { output: envelope.structured_output, ...meta };
  }
  if (typeof envelope.result === 'string') {
    try {
      const parsed = JSON.parse(envelope.result);
      if (parsed && typeof parsed === 'object') return { output: parsed, ...meta };
    } catch {
      /* not JSON */
    }
  }
  return { error: 'no structured output in the result', ...meta };
}

function runOnce({ bin, args, prompt, cwd, timeoutMs, env }) {
  return new Promise((done) => {
    const started = Date.now();
    const childEnv = { ...env };
    delete childEnv.CLAUDECODE; // allow a nested invocation from inside Claude Code
    let child;
    try {
      child = spawn(bin, args, { cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      done({ ok: false, error: e.message, transient: false, durationMs: 0 });
      return;
    }
    let out = '';
    let err = '';
    let settled = false;
    // If the harness is interrupted, its agents must not keep running (and billing) on their own.
    const release = registerCleanup(() => child.kill('SIGKILL'));
    const finish = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      release();
      done({ ...res, durationMs: Date.now() - started });
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, error: `timeout after ${timeoutMs}ms`, transient: false });
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      if (out.length < MAX_OUTPUT) out += d;
      else child.kill('SIGKILL');
    });
    child.stderr.on('data', (d) => {
      if (err.length < MAX_OUTPUT) err += d;
    });
    child.on('error', (e) => finish({ ok: false, error: e.message, transient: false }));
    child.on('close', (code) => {
      const parsed = parseEnvelope(out);
      if (parsed.output) {
        finish({ ok: true, output: parsed.output, costUsd: parsed.costUsd, turns: parsed.turns, denials: parsed.denials });
        return;
      }
      const stderrLine = err.trim().split('\n').filter(Boolean).pop() ?? '';
      finish({
        ok: false,
        error: `${parsed.error}${code ? ` (exit ${code})` : ''}${stderrLine ? `: ${stderrLine.slice(0, 200)}` : ''}`,
        costUsd: parsed.costUsd ?? null,
        // An empty or non-JSON reply is what a momentary rate limit looks like; an error the
        // agent itself reported (for example a budget limit) will not improve on retry.
        transient: parsed.error === 'empty output' || parsed.error === 'output is not JSON',
      });
    });
    child.stdin.on('error', () => {}); // the child may exit before reading its prompt
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/**
 * Run one agent. Resolves (never rejects) to
 * { ok, output, error, costUsd, turns, denials, durationMs, attempts }.
 */
export async function runAgent({
  bin,
  model,
  systemPrompt,
  prompt,
  schema,
  cwd,
  tools,
  addDirs,
  timeoutMs,
  maxBudgetUsd,
  retryDelayMs = 2000,
  env = process.env,
}) {
  const args = buildArgs({ model, systemPrompt, schema, tools, addDirs, maxBudgetUsd });
  let result = await runOnce({ bin, args, prompt, cwd, timeoutMs, env });
  let attempts = 1;
  if (!result.ok && result.transient) {
    await new Promise((r) => setTimeout(r, retryDelayMs));
    const retry = await runOnce({ bin, args, prompt, cwd, timeoutMs, env });
    attempts = 2;
    result = { ...retry, costUsd: (retry.costUsd ?? 0) + (result.costUsd ?? 0) || null, durationMs: result.durationMs + retry.durationMs };
  }
  return { ...result, attempts };
}

/** Run `fn` over `items` with at most `limit` in flight, preserving order. */
export async function runPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
