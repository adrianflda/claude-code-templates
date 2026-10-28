#!/usr/bin/env node
// A scripted stand-in for the claude CLI, used by the end-to-end tests.
//
// FAKE_CLAUDE_SCRIPT points at a JSON file: { "<substring of the system prompt>": <reply> }.
// The first key contained in the agent's system prompt selects the reply. A reply is either
//   { "output": {...} }            a successful structured result
//   { "error": "message" }         a result the agent reports as an error
//   { "raw": "text", "exit": 1 }   arbitrary stdout and exit code (for malformed output)
//   { "hang": true }               never answers (for timeouts)
// Every invocation is appended to FAKE_CLAUDE_LOG with its arguments and prompt.

import { appendFileSync, readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
};

let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;

const system = valueOf('--append-system-prompt') ?? '';
const script = JSON.parse(readFileSync(process.env.FAKE_CLAUDE_SCRIPT, 'utf8'));
const key = Object.keys(script).find((k) => system.includes(k));
const reply = key ? script[key] : { error: `no scripted reply for system prompt: ${system.slice(0, 60)}` };

if (process.env.FAKE_CLAUDE_LOG) {
  appendFileSync(
    process.env.FAKE_CLAUDE_LOG,
    JSON.stringify({ key: key ?? null, pid: process.pid, argv, cwd: process.cwd(), claudecode: process.env.CLAUDECODE ?? null, prompt }) + '\n',
  );
}

if (reply.hang) {
  setInterval(() => {}, 1 << 30);
} else if (reply.raw !== undefined) {
  process.stdout.write(reply.raw);
  process.exit(reply.exit ?? 0);
} else {
  const envelope = reply.error
    ? { type: 'result', subtype: 'error_during_execution', is_error: true, result: reply.error, total_cost_usd: 0.01, num_turns: 1, permission_denials: [] }
    : { type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(reply.output), structured_output: reply.output, total_cost_usd: reply.costUsd ?? 0.05, num_turns: 3, permission_denials: [] };
  process.stdout.write(JSON.stringify(envelope));
  process.exit(0);
}
