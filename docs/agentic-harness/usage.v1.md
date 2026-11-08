# Usage — the built teeth (M0 + M1) — v1

> How to use what's built so far: the **referee** (M0), the **router** (M1), and the composed
> **quality gate**. All local, no deps beyond Node + git. Paths: `plugins/quality-kernel/scripts/`.

## Per-repo config (one-time)
Create `.quality-kernel/` in the target repo:
- `tools.json` → `{ "verify": "<your test command>" }` (e.g. `"npm test"`, `"pytest -q"`, `"node --test"`).
- `critical-surface.json` → `{ "criticalGlobs": [...], "safeGlobs": [...] }` — copy
  `plugins/quality-kernel/config/critical-surface.example.json` and **author it from your own past
  incidents** (INV-R5 proved a generic default misses real bugs).

## The composed gate (recommended entry)
```
node plugins/quality-kernel/scripts/qk-gate.mjs --repo <dir> --base <ref>
```
Classifies the change's risk (route) AND verifies by re-executing the test suite (referee), in one
command. Emits `{ pass, tier, requiresBreaker, referee, route, notes }`.
Exit `0` = verified pass · `1` = verified fail · `2` = indeterminate (fail-closed).
> Honest limit: on a `critical` change the live **breaker** oracle is also required before merge —
> that is milestone **M2**, not yet enforced; the gate flags it in `notes`.

## The pieces, standalone
- **Referee (M0)** — re-executes verification, never trusts a claim:
  `node …/referee.mjs --repo <dir> [--base <ref>]` → `{pass, evidence:{command,exit_code}, reason}`;
  exit `0/1/2`. Appends real exit codes to `.quality-kernel/evidence-ledger.jsonl` (source="referee").
- **Router (M1)** — deterministic blast-radius/tier:
  `node …/route.mjs --repo <dir> --base <ref>` (or `--changed a,b` / `--proposed <tier>`) →
  `{tierFloor, tier, requiresBreaker, criticalFiles, reason}`. Fail-safe: no config → `critical`.

## Verify the tools themselves
```
node --test plugins/quality-kernel/scripts/*.test.mjs      # referee, route, qk-gate (+ crap)
python3 plugins/quality-kernel/hooks/test_hooks.py          # evidence-gate
```

## What is NOT here yet (next milestones)
M2 live breaker + dogfood on a real issue with cost measured · M3 regression fixtures + metrics ·
M4 SDD-native pipeline · M5 config-by-target + deploy + dashboard E2E · M6 human layer.
See `build-sequence.v1.md`.
