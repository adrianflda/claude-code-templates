# Spec — M0: Re-executing Verification Referee — v2 (amendment)

> **Status:** ACTIVE amendment to `spec-m0-referee.v1.md` (v1 stays frozen). Amends INV5 only,
> driven by a fact discovered **by execution** during the M0 build. Ratification: the human owns
> amendments (Constitution governance). **Versioning:** further changes → `spec-m0-referee.v3.md`.

## What changed and why (the discovered fact)
INV5 (v1) assumed the evidence-gate could record a **real exit code** taken from the Bash
PostToolUse payload. **That premise is false, verified by execution:** Claude Code's Bash
`tool_response` exposes only `stdout`, `stderr`, `interrupted`, `isImage`, `noOutputExpected` —
**there is no exit-code field.** This is exactly why the prior hook recorded 112/112
`"unknown-schema"`: it guessed `exit_code/exitCode/returncode/code`, none of which exist.

*(Evidence: inspected real Bash `toolUseResult` objects in a session transcript — keys were
`['stdout','stderr','interrupted','isImage','noOutputExpected']`, no exit code.)*

## INV5 — revised
- **INV5a (revised) — real exit codes come from the REFEREE, not the hook.** The referee
  re-executes the verify command, has the real exit code, and appends a typed record
  `{source:"referee", command, exit_code, pass}` to `.quality-kernel/evidence-ledger.jsonl`.
  *Proof:* `referee.test.mjs` → "INV5a — the referee appends a REAL exit code to the ledger". ✅
- **INV5b (unchanged intent) — the hook never counts prose as verification.** Detection is
  anchored to the START of a shell segment (the executable position), optionally behind a runner
  prefix — so a runner word inside a quoted body (e.g. `gh pr comment -b "…pytest…"`) is not a
  verification event. *Proof:* `test_hooks.py` → `test_prose_in_a_non_verify_command_is_NOT_recorded`,
  `test_echo_mentioning_a_runner_is_NOT_recorded`, `test_chained_verify_command_is_recorded`. ✅
- **The hook stops fabricating exit codes.** It records the honest signals the payload *does*
  expose (`source:"bash-hook"`, `interrupted`, `stderr_nonempty`) as an audit/metrics trail; it
  never invents an exit code. The `"unknown-schema"` sentinel is retired.

## Consequence for the design
This reinforces Constitution P2 (verify by execution) and the plan's own layering: the **referee
is the authoritative gate and the authoritative source of exit-code truth**; the Bash hook is a
lightweight audit recorder, not a gate. Nothing downstream should read the hook's records as a
pass/fail signal — only the referee's `source:"referee"` records (and the referee's own verdict)
carry exit codes.

## M0 Definition of Done — status
INV1–INV4 (v1) ✅ + INV5a/INV5b (v2) ✅ — all green by execution. **M0 is complete.**
