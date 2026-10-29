#!/usr/bin/env node
/**
 * aws-admin-guard — Claude Code UserPromptSubmit hook.
 *
 * Tells Claude where the admin grant stands after the human's new prompt, so it does not
 * have to guess. It never writes anything: the guard re-reads the transcript itself.
 * Silent when the prompt has nothing to do with the grant.
 */
import { classify, config, grantState, humanPrompts } from './consent-core.mjs';

function readStdin() {
  // Read until EOF, bounded three ways: size (8 MB), idle time (5 s) and total time (15 s).
  // Anything abnormal resolves to '' so the caller's JSON.parse fails and its fallback runs.
  return new Promise((res) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(idle);
      clearTimeout(hard);
      res(ok ? chunks.join('') : '');
    };
    let idle = setTimeout(() => finish(false), 5_000);
    const hard = setTimeout(() => finish(false), 15_000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      size += c.length;
      if (size > 8_000_000) return finish(false);
      chunks.push(c);
      clearTimeout(idle);
      idle = setTimeout(() => finish(false), 5_000);
    });
    process.stdin.on('end', () => finish(true));
    process.stdin.on('error', () => finish(false));
  });
}

async function main() {
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    process.exit(0);
  }
  const prompt = String(input?.prompt ?? '');
  const cfg = config();
  const kind = classify(prompt, cfg.profiles);
  if (kind === 'none') process.exit(0);
  const now = Date.now();
  const prompts = humanPrompts(input?.transcript_path);
  const last = prompts[prompts.length - 1];
  if (!last || last.text !== prompt) prompts.push({ text: prompt, ts: now });
  const s = grantState(prompts, now, cfg);
  let msg;
  if (s.stage === 'granted') {
    msg = `AWS admin profile: granted for this session until ${new Date(s.expiresAt).toLocaleTimeString()} ` +
      `(2 of 2 confirmations). Use it only for what the user approved.`;
  } else if (s.stage === 'pending') {
    msg = 'AWS admin profile: authorization 1 of 2 recorded. It is NOT usable yet: ask the user for the ' +
      `second confirmation in a separate message (within ${cfg.windowMs / 60000} min).`;
  } else if (kind === 'revoke') {
    msg = 'AWS admin profile: revoked by the user. Do not use it.';
  } else {
    return process.exit(0);
  }
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: `[aws-admin-guard] ${msg}` },
  }));
}

main();
