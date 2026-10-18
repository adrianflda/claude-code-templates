import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { englishLines } from '../scripts/lang.mjs';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
const CHECK = join(SCRIPTS, 'check.mjs');
const REMIND = join(SCRIPTS, 'remind.mjs');

// Real messages from a session where the rule was broken (English) and kept (Spanish).
const EN_REAL = [
  "The daemon dies again as soon as the build starts. That's twice, so I won't insist.",
  'The plan matches what I said exactly: 2 to create, 0 to change, 0 to destroy. Applying:',
  'I checked both from outside, with no credentials at all.',
  'The agent made the fix in the review copy (the temporary worktree) instead of your main checkout.',
];
const ES_REAL = [
  'Guardé en memoria el punto de retorno, así que ya puedes compactar sin perder nada.', // EXEMPT-ES: Spanish user phrasing is the test data
  'Los 14 tests de `pr-draft-guard` pasan. Ahora agrego la regla escrita y el manifiesto del plugin.',
  '| Todo push pasa por la revisión de 6 | `pre-push-review` en git: sin revisión no hay push |', // EXEMPT-ES: Spanish user phrasing is the test data
  'Estoy revisando cómo están armados los plugins actuales del repo para copiar su estructura.', // EXEMPT-ES: Spanish user phrasing is the test data
];

test('real English messages are detected and real Spanish ones are not', () => {
  for (const t of EN_REAL) assert.ok(englishLines(t).length, `should flag: ${t}`);
  for (const t of ES_REAL) assert.deepEqual(englishLines(t), [], `should pass: ${t}`);
});

test('English that belongs in a Spanish message is allowed: code, quotes, paths, URLs', () => {
  const msg = [
    'Listo, el commit quedó así:', // EXEMPT-ES: Spanish user phrasing is the test data
    '```',
    'fix(dr): add the bucket to the plan and update the expectations for the check',
    '```',
    '> Every PR is a draft; the human decides when it is ready.',
    'El hook lee `the transcript that is written by the CLI` y lo verifica.',
    'Ver https://github.com/o/r/pull/12 y docs/research/the-file-that-is-here.md',
  ].join('\n');
  assert.deepEqual(englishLines(msg), []);
});

function session() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'clg-')));
  const path = join(dir, 's.jsonl');
  writeFileSync(path, '');
  const add = (e) => appendFileSync(path, JSON.stringify({ timestamp: new Date().toISOString(), ...e }) + '\n');
  return {
    path,
    human: (text) => add({ type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: text } }),
    say: (text, extra = {}) => add({ type: 'assistant', ...extra, message: { role: 'assistant', content: [{ type: 'text', text }] } }),
    tool: () => {
      add({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] } });
      add({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'The output is in English and that is fine.' }] } });
    },
  };
}
function stop(s, extra = {}, env = {}) {
  const r = spawnSync(process.execPath, [CHECK], {
    input: JSON.stringify({ hook_event_name: 'Stop', transcript_path: s?.path, stop_hook_active: false, ...extra }),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout) : null;
}

test('an English reply is sent back for a Spanish rewrite, quoting what was wrong', () => {
  const s = session();
  s.human('como vamos?');
  s.say(EN_REAL[1]);
  const out = stop(s);
  assert.equal(out?.decision, 'block');
  assert.match(out.reason, /Spanish/);
  assert.match(out.reason, /The plan matches what I said/);
});

test('English in the interim notes between tool calls is caught too', () => {
  const s = session();
  s.human('sigue');
  s.say(EN_REAL[0]);
  s.tool();
  s.say(ES_REAL[0]);
  assert.equal(stop(s)?.decision, 'block');
});

test('a Spanish turn passes, and English tool output does not count', () => {
  const s = session();
  s.human('sigue');
  s.say(ES_REAL[3]);
  s.tool();
  s.say(ES_REAL[1]);
  assert.equal(stop(s), null);
});

test('only the current turn is judged', () => {
  const s = session();
  s.human('sigue');
  s.say(EN_REAL[2]);
  s.human('en español porfa'); // EXEMPT-ES: Spanish user phrasing is the test data
  s.say(ES_REAL[0]);
  assert.equal(stop(s), null);
});

test('subagent text and API error notices are not the assistant talking to the user', () => {
  const s = session();
  s.human('sigue');
  s.say(EN_REAL[0], { isSidechain: true });
  s.say("API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)", { isApiErrorMessage: true });
  s.say(ES_REAL[0]);
  assert.equal(stop(s), null);
});

test('it blocks once per turn: on the retry (stop_hook_active) it lets the turn end', () => {
  const s = session();
  s.human('sigue');
  s.say(EN_REAL[1]);
  assert.equal(stop(s, { stop_hook_active: true }), null);
});

test('last_assistant_message is checked even without a transcript', () => {
  assert.equal(stop(null, { transcript_path: undefined, last_assistant_message: EN_REAL[2] })?.decision, 'block');
  assert.equal(stop(null, { transcript_path: undefined, last_assistant_message: ES_REAL[2] }), null);
});

test('it can be switched off, and garbage input is ignored', () => {
  const s = session();
  s.human('x');
  s.say(EN_REAL[1]);
  assert.equal(stop(s, {}, { CHAT_LANGUAGE_GUARD_DISABLE: '1' }), null);
  const r = spawnSync(process.execPath, [CHECK], { input: 'nope', encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('every prompt carries a one-line reminder of the rule', () => {
  const r = spawnSync(process.execPath, [REMIND], { input: JSON.stringify({ prompt: 'sigue' }), encoding: 'utf8' });
  assert.equal(r.status, 0);
  const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /Spanish/);
  assert.ok(ctx.length < 400, 'the reminder stays short');
});
