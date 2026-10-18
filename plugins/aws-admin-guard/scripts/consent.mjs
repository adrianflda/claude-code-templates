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
  // Resolve on 'end'. The timer only guards against a caller that never closes stdin, and it
  // is reset by every chunk, so a slow but live payload is never cut short.
  return new Promise((res) => {
    let d = '';
    let timer = setTimeout(() => res(d), 10_000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      if (d.length < 16_000_000) d += c;
      clearTimeout(timer);
      timer = setTimeout(() => res(d), 10_000);
    });
    process.stdin.on('end', () => { clearTimeout(timer); res(d); });
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
