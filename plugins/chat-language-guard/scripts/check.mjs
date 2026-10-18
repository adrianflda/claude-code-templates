#!/usr/bin/env node
/**
 * chat-language-guard — Claude Code Stop hook.
 *
 * Rule (see ../RULE.md): Claude talks to the user in Spanish; only what leaves the chat
 * (code, commits, PRs, files, artifacts) is English.
 *
 * When Claude is about to end its turn, this reads what it said to the user during the turn
 * (every assistant text since the last prompt the human typed, interim notes included;
 * subagents and API error notices excluded). If any of it is English prose, it blocks the
 * stop once with {"decision":"block"} and asks for a Spanish rewrite. The user has already
 * seen the English text by then: the hook guarantees a correction in the same turn, not that
 * the English never appears.
 *
 * It blocks at most once per turn (stop_hook_active), so a false positive costs one extra
 * message, never a loop. Off switch: CHAT_LANGUAGE_GUARD_DISABLE=1.
 */
import { readFileSync } from 'node:fs';
import { englishLines } from './lang.mjs';

function readStdin() {
  return new Promise((res) => {
    let d = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { if (d.length < 1_000_000) d += c; });
    process.stdin.on('end', () => res(d));
    setTimeout(() => res(d), 2000).unref?.();
  });
}

const isHumanPrompt = (e) =>
  e?.type === 'user' && !e.isMeta && !e.isSidechain && (!e.origin || e.origin.kind === 'human') &&
  (typeof e.message?.content === 'string' ||
    (Array.isArray(e.message?.content) && !e.message.content.some((b) => b?.type === 'tool_result')));

/** What the assistant told the user since the human's last prompt. */
export function turnTexts(transcriptPath) {
  let raw;
  try {
    raw = readFileSync(transcriptPath, 'utf8');
  } catch {
    return [];
  }
  let texts = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (isHumanPrompt(e)) { texts = []; continue; }
    if (e?.type !== 'assistant' || e.isSidechain || e.isApiErrorMessage) continue;
    const c = e.message?.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) if (b?.type === 'text' && b.text?.trim()) texts.push(b.text);
  }
  return texts;
}

async function main() {
  if (process.env.CHAT_LANGUAGE_GUARD_DISABLE === '1') process.exit(0);
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    process.exit(0);
  }
  if (input?.stop_hook_active) process.exit(0);
  const texts = input?.transcript_path ? turnTexts(input.transcript_path) : [];
  const last = typeof input?.last_assistant_message === 'string' ? input.last_assistant_message : '';
  if (last && !texts.includes(last)) texts.push(last);
  const bad = texts.flatMap((t) => englishLines(t));
  if (!bad.length) process.exit(0);
  const quoted = bad.slice(0, 3).map((l) => `  - "${l.slice(0, 160)}"`).join('\n');
  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason:
      '[chat-language-guard] You wrote to the user in English. The chat with this user is in Spanish ' +
      '(only code, commits, PRs, files and artifacts are English). English lines found:\n' + quoted +
      '\nWrite a short message in Spanish now that says the same thing as the English parts (keep code, ' +
      'paths and commands as they are, in backticks). No long apology; one line acknowledging it is enough.',
  }));
}

main();
