#!/usr/bin/env node
// Composed gate WITH the enforced blind breaker — M2. Spec: docs/agentic-harness/spec-m2-plan-qa.v1.md
//
// Closes qk-gate's honest "exit 3 = breaker required but NOT enforced" note (D3): on the critical
// surface, a green referee is not enough — the blind breaker (P5) must PASS against the live system.
//   qk-gate 0            -> 0  (verified, no breaker required)
//   qk-gate 3 + breaker  -> breaker-invoke: PASS->0 · FAIL->1 · could-not-run->2
//   qk-gate 3, no breaker-> 3  (still unenforced; caller must supply --breaker for a real critical merge)
//   qk-gate 1/2          -> passthrough (real fail / indeterminate)
//
// Usage: breaker-gate.mjs --repo <dir> --base <ref> [--head <ref>]
//        [--breaker "<cmd>" --contract <id>.md --probe "<cmd>" --url <systemUrl>]

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
function opt(name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; }

const repo = opt('--repo'), base = opt('--base'), head = opt('--head');
const breaker = opt('--breaker'), contract = opt('--contract'), probe = opt('--probe'), url = opt('--url');
const emit = (v, code) => { process.stdout.write(JSON.stringify(v) + '\n'); process.exit(code); };
if (!repo || !base) emit({ gate: 'error', error: 'need --repo <dir> --base <ref> [--head <ref>]' }, 2);

const gateArgs = ['--repo', repo, '--base', base, ...(head ? ['--head', head] : [])];
const g = spawnSync('node', [join(here, 'qk-gate.mjs'), ...gateArgs], { encoding: 'utf8' });
let gj = null; try { gj = JSON.parse((g.stdout || '').trim().split('\n').filter(Boolean).pop()); } catch { /* null */ }

if (g.status !== 3) emit({ gate: gj ? gj.gate : 'error', refereeGate: gj, breaker: null }, g.status); // 0/1/2 passthrough

// critical surface: the breaker is REQUIRED.
if (!breaker || !contract) emit({ gate: 'blocked-needs-breaker', refereeGate: gj, breaker: null, notes: ['critical change: supply --breaker "<cmd>" --contract <id>.md to enforce the live breaker (P5).'] }, 3);

const b = spawnSync('node', [join(here, 'breaker-invoke.mjs'), '--contract', contract, ...(probe ? ['--probe', probe] : []), ...(url ? ['--url', url] : []), '--breaker', breaker], { encoding: 'utf8' });
let bj = null; try { bj = JSON.parse((b.stdout || '').trim().split('\n').filter(Boolean).pop()); } catch { /* null */ }
const gate = b.status === 0 ? 'pass' : b.status === 1 ? 'breaker-fail' : 'breaker-indeterminate';
emit({ gate, refereeGate: gj, breaker: bj }, b.status);
