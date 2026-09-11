# Tasks — M0: Re-executing Verification Referee — v1 (FROZEN)

> **Status:** FROZEN task list (SDD). Executes `plan-m0-referee.v1.md` →
> `spec-m0-referee.v1.md` → `constitution.v1.md`. **Versioning:** never overwrite → `.v2`.
> **Confirmed decisions:** DC1 = extend `tools.json`; DC2 = full suite when mapping uncertain;
> DC3 = exit codes `0`=pass / `1`=real-fail / `2`=indeterminate.
> **Convention:** `[P]` = parallelizable with its siblings. Each task is DONE only when its
> **AC** passes **by execution** (Constitution P2). All paths under
> `plugins/quality-kernel/` in the `claude-code-templates` repo.

## Track A — Config
- **T1. Declare the verify command in config.** Extend `config/tools.example.json` with a
  `verify` command per language (reuse the existing test/coverage entries) and document the
  `.quality-kernel/tools.json` convention the referee reads.
  **AC:** a documented `verify` field exists; a helper can load it; missing → treated as absent (→ T5 fail-closed).

## Track B — Fixtures *(can run in parallel with Track C)*
- **T2 [P]. Build the four fixture repos** under `scripts/fixtures/`: `green/` (passing suite),
  `red/` (failing suite + a "done" claim = forged pass), `trivial-scope/` (an unrelated trivial
  test passes while the diff-mapped suite is red), `indeterminate/` (verify command errors / no
  readable exit). Each is a self-contained dir with a base ref, a `tools.json`, and a README of its
  expected verdict.
  **AC:** each fixture runs its own verify command manually and exhibits the documented state
  (green passes, red fails, etc.).

## Track C — Referee core *(sequential; parallel with Track B and Track D)*
- **T3. Diff resolution + config load.** `referee.mjs`: resolve changed files via
  `git -C <repo> diff --name-only <base>...HEAD`; load the verify command (T1). Git error or missing
  config → exit `2`.
  **AC:** on a fixture, prints the changed files; git/config error → exit `2`.
- **T4. Re-execute + typed verdict.** `spawnSync` the verify command in the repo, read the real
  `status`, parse a structured report (`--json`) if present. Emit
  `{ pass, evidence:{command, exit_code, tests_passed, tests_failed}, reason }`; exit `0` (pass) / `1` (fail).
  **AC:** on `green/` → exit `0`, evidence.exit_code `0`; on `red/` → exit `1`.
- **T5. Fail-closed logic.** Indeterminate (unreadable exit / spawn error) → exit `2`. When the
  diff→suite mapping is uncertain, run the **full** verify command (D4), never a subset.
  **AC:** on `indeterminate/` → exit `2`; on `trivial-scope/` the full suite runs → exit `1`.

## Track D — Evidence-gate fix (audit layer, INV5) *(parallel with Track C)*
- **T6 [P]. Discover the real exit-code field.** Throwaway task: capture a real Claude Code
  PostToolUse `tool_response` payload for a Bash command; document the actual exit-code field name.
  **AC:** the real field name is recorded in the plan/notes.
- **T7. Fix `evidence-gate.py` — bug A (exit code) + bug B (regex scope).** Read the real field
  (T6); keep `unknown-schema` only when genuinely absent. Match `VERIFY_RE` against the parsed
  leading command token(s) of each pipeline segment, not a substring over the whole command.
  **AC:** a real `vitest/pytest` command records a real integer exit code; a `gh pr comment` with
  test-words in its body records **nothing**.
- **T8. Regression tests in `test_hooks.py`.** Add fixtures asserting both bugs stay fixed.
  **AC:** the hook test suite runs green including the two new regressions.

## Track E — Referee tests (the invariants / red-team)
- **T9. `referee.test.mjs` (node --test).** Drive the referee against all four fixtures; assert the
  verdicts. Explicitly cover **INV1** (forged pass blocked) and **INV4** (indeterminate → fail).
  **AC:** `node --test` green; INV1–INV4 asserted. Depends on T2, T3–T5.

## Track F — M0 acceptance (the milestone gate)
- **T10. Prove M0 green by execution.** Run `referee.test.mjs` + the hook tests; run the referee
  once on a real change and inspect the typed verdict.
  **AC (= M0 Definition of Done):** INV1–INV5 all pass by execution — above all **INV1** (a forged
  pass is blocked) and **INV4** (indeterminate fails closed). When this is green, "green" means something.

## Dependency graph (summary)
```
T1 ─┐
    ├─ T3 → T4 → T5 ─┐
T2 ─┘                ├─ T9 ─┐
                     │       ├─ T10 (M0 GREEN)
T6 → T7 → T8 ────────┘───────┘
```
Tracks B, C, D run in parallel; T9 joins B+C; T10 joins everything.
