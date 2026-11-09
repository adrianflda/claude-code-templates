// Run-journal records and their legal transitions (spec: docs/agentic-harness/spec-run-journal.v1.md §3).
// validate() is the single gate for every record, both when appending and when folding a journal back
// into state, so a journal can only ever contain what the writer would have accepted.
import { isRepoName } from '../org.mjs';

export const STATES = ['pending', 'in_progress', 'committed', 'gate_green', 'gate_red', 'blocked'];
export const TERMINAL = new Set(['gate_green']);
// §3 / decision §8.5: a task starts in pending; every state except gate_green may go to blocked.
const NEXT = {
  '': ['pending'],
  pending: ['in_progress', 'blocked'],
  in_progress: ['committed', 'blocked'],
  committed: ['gate_green', 'gate_red', 'blocked'],
  gate_red: ['in_progress', 'blocked'],
  gate_green: [],
  blocked: [],
};
// §3 / decision §8.4: after the 3rd gate_red the only legal next state is blocked.
export const MAX_GATE_RED = 3;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
// A real UTC instant: Date.parse alone rolls 2026-02-30 over to March, so the calendar part must survive.
const realUtc = (s) => typeof s === 'string' && ISO_UTC.test(s) && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 19) === s.slice(0, 19);
const NEEDS_SHA = new Set(['committed', 'gate_green', 'gate_red']);
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const TASK_ID = /^[A-Za-z0-9._-]{1,64}$/;
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]{1,200}(?<![/.])$/;
const KEYS = {
  run_started: ['v', 'type', 'run_id', 'plan_ref', 'repos'],
  task: ['v', 'type', 'task_id', 'repo', 'branch', 'worktree', 'state', 'head_sha', 'gate', 'reason'],
  decision: ['v', 'type', 'task_id', 'ref'],
  run_finished: ['v', 'type', 'verdict'],
};

export const emptyState = () => ({ run: null, tasks: {}, finished: null });
const shortText = (s, max = 500) => typeof s === 'string' && s.length > 0 && s.length <= max;
// Own tasks only: a task id such as `constructor` must not resolve to an inherited property.
const taskOf = (state, id) => (Object.hasOwn(state.tasks, id) ? state.tasks[id] : undefined);
const isObj = (o) => Boolean(o) && typeof o === 'object' && !Array.isArray(o);

function shapeError(r) {
  if (!isObj(r) || r.v !== 1 || !Object.hasOwn(KEYS, r.type)) return 'record must be an object with v: 1 and a known type';
  const extra = Object.keys(r).filter((k) => !KEYS[r.type].includes(k));
  return extra.length ? `unknown field(s) for ${r.type}: ${extra.join(', ')}` : null;
}

function runStartedError(r, state, runId) {
  if (state.run) return 'run_started may appear only once';
  if (r.run_id !== runId) return `run_id must be ${runId}`;
  if (!shortText(r.plan_ref)) return 'plan_ref must be a non-empty string';
  if (!Array.isArray(r.repos) || r.repos.length === 0) return 'repos must be a non-empty list';
  const names = r.repos.map((x) => x && x.name);
  if (!r.repos.every((x) => isObj(x) && isRepoName(x.name) && SHA.test(x.base_sha || '') && Object.keys(x).length === 2)) {
    return 'each repo must be { name: <plain sibling name>, base_sha: <sha> }';
  }
  return new Set(names).size === names.length ? null : 'repo names must be unique';
}

function taskFieldsError(r, state) {
  if (!TASK_ID.test(r.task_id || '')) return 'task_id must match [A-Za-z0-9._-]{1,64}';
  if (!state.run.repos.some((x) => x.name === r.repo)) return `repo "${r.repo}" is not declared in run_started`;
  if (!BRANCH.test(r.branch || '')) return 'branch is not a valid branch name';
  if (!isRepoName(r.worktree)) return 'worktree is required and must be a plain sibling name';
  if (!STATES.includes(r.state)) return `state must be one of ${STATES.join(', ')}`;
  if (r.reason !== undefined && !shortText(r.reason)) return 'reason must be a short non-empty string';
  if (r.head_sha !== undefined && !SHA.test(r.head_sha)) return 'head_sha must be a full sha';
  if (NEEDS_SHA.has(r.state) && r.head_sha === undefined) return `${r.state} requires head_sha`;
  return null;
}

function gateError(r, prev) {
  const gated = r.state === 'gate_green' || r.state === 'gate_red';
  if (!gated) return r.gate === undefined ? null : 'gate is only allowed on gate_green / gate_red';
  const keys = isObj(r.gate) ? Object.keys(r.gate).sort().join(',') : '';
  if (keys !== 'at,exit' || !Number.isInteger(r.gate.exit) || !realUtc(r.gate.at)) {
    return 'gate must be { exit: <int>, at: <ISO-8601 UTC timestamp> }';
  }
  if ((r.gate.exit === 0) !== (r.state === 'gate_green')) return 'gate_green requires exit 0 and gate_red a non-zero exit';
  return r.head_sha === prev.head_sha ? null : 'a gate result must be for the committed head_sha';
}

function taskError(r, state) {
  const fields = taskFieldsError(r, state);
  if (fields) return fields;
  const prev = taskOf(state, r.task_id);
  if (prev && (prev.repo !== r.repo || prev.branch !== r.branch)) return 'repo and branch of a task cannot change';
  const from = prev ? prev.state : '';
  if (!NEXT[from].includes(r.state)) return `illegal transition ${from || '(new)'} -> ${r.state}`;
  if (from === 'gate_red' && r.state === 'in_progress' && prev.reds >= MAX_GATE_RED) {
    return `retry cap reached (${MAX_GATE_RED} gate_red): the only legal next state is blocked`;
  }
  return gateError(r, prev || {});
}

// null when `r` may follow `state`, else the reason it may not.
export function validate(r, state, runId) {
  const shape = shapeError(r);
  if (shape) return shape;
  if (state.finished) return 'the run is finished; nothing may follow run_finished';
  if (r.type === 'run_started') return runStartedError(r, state, runId);
  if (!state.run) return 'the first record must be run_started';
  if (r.type === 'task') return taskError(r, state);
  if (r.type === 'decision') {
    const t = taskOf(state, r.task_id);
    if (!t || t.state !== 'blocked') return 'a decision is only allowed for a blocked task';
    return shortText(r.ref) ? null : 'ref must be a non-empty string';
  }
  return ['pass', 'fail', 'kill'].includes(r.verdict) ? null : 'verdict must be pass, fail or kill';
}

// The state after `r` (assumed valid). A task keeps its last head_sha and worktree across records (not
// its reason);
// `reds` counts its gate_red records and a decision (the human unblocking it) starts it again.
export function apply(state, r) {
  if (r.type === 'run_started') return { ...state, run: { run_id: r.run_id, plan_ref: r.plan_ref, repos: r.repos } };
  if (r.type === 'run_finished') return { ...state, finished: r.verdict };
  const prev = taskOf(state, r.task_id) || {};
  // A reason belongs to the record that carries it: a later record without one must not inherit it.
  const { reason: _stale, ...kept } = prev;
  const next = r.type === 'decision'
    ? { ...kept, state: 'pending', decision: r.ref, reds: 0 }
    : { ...kept, ...Object.fromEntries(Object.entries(r).filter(([k]) => !['v', 'type'].includes(k))), reds: (prev.reds || 0) + (r.state === 'gate_red' ? 1 : 0) };
  if (r.type === 'task' && r.state !== 'gate_green' && r.state !== 'gate_red') delete next.gate;
  return { ...state, tasks: { ...state.tasks, [r.task_id]: next } };
}

// Journal text -> { state, seq, tornTail } or { error }. A last line without its newline is a write
// that never completed (torn tail): ignored. Anything unparsable or invalid before it is corruption.
export function fold(text, runId) {
  const tornTail = text.length > 0 && !text.endsWith('\n');
  const lines = text.split('\n').slice(0, -1);
  let state = emptyState();
  for (const [i, line] of lines.entries()) {
    let r;
    try { r = JSON.parse(line); } catch { return { error: `line ${i + 1} is not JSON` }; }
    const why = validate(r, state, runId);
    if (why) return { error: `line ${i + 1}: ${why}` };
    state = apply(state, r);
  }
  return { state, seq: lines.length, tornTail };
}
