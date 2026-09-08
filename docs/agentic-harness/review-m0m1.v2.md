# Re-attack of the HARDENED M0+M1 — v2 (amendment to review-m0m1.v1)

> After the rework closed the 4 named blockers, a second red-team pass (run by execution)
> confirmed the 4 blockers hold BUT found **2 deeper residual holes of the same class** that
> M0/M1's approach cannot close — they are M3's job. Recorded honestly (Constitution P2/P11).
> (The fully-independent critic agent could not spawn during this pass — classifier outage — so
> these were produced by the main loop's own red-team, with concrete repro; an independent pass
> is still owed.) **Versioning:** never overwrite → `review-m0m1.v3.md`.

## Confirmed: the 4 blockers hold
The rework's regression tests are green (node --test 34/34, hooks 17/17). Weakening `tools.json`,
deleting a test, invoking without `--base`, and the missing invoker are all defeated.

## New findings (verified by execution — both make the gate PASS a broken change)
- **A — oracle indirection.** The base-ref fix protects `tools.json` but NOT the *scripts* the
  verify command invokes. Repro: `verify` = `bash verify.sh`; the change weakens `verify.sh` to
  `exit 0` (worktree) and breaks the suite → **referee PASS, qk-gate exit 0**. `route` sees only a
  `verify.sh`/test edit → `standard`, no breaker.
- **B — test neutered in place.** `route` flags a *deleted* test critical, but a test *modified*
  to `assert(true)` is a safe-glob edit. Repro: break `code.mjs` and rewrite `guard.test.mjs` to
  `test('guard', () => assert.ok(true))` → **referee PASS, qk-gate exit 0**.

## Root cause (the layer M0/M1 cannot reach)
The oracle's integrity depends on the WHOLE test harness — the verify scripts, `package.json`, and
the test files themselves — all of which live in the mutable worktree the change controls. Reading
only `tools.json` from the base ref protects *which command runs*, not *what the scripts/tests it
runs actually do*. Fully closing this needs either running the change's code against a **trusted
(base) harness**, or **mutation testing** that proves the tests actually kill bugs.

## Disposition → M3 (not a M1 patch)
These map precisely to milestone **M3 (hardener / mutation + fixtures)**:
- **B** is exactly what mutation testing catches — a test asserting `true` kills zero mutants.
- **A** needs the "run against a trusted harness" verification model.
Attempting to patch them in M1 (e.g. "any test edit is critical") would cause breaker fatigue
(the panel's own warning) and still miss the subtle forms. So they are recorded as **defined M3
scope**, and finding them by execution validates why M3 exists.

## Honest verdict
The hardening was real and worth it (blatant gaming is gone; the named guarantees hold). But
"non-gameable" is **still not fully true** — the subtle oracle-tampering class remains until M3.
M2 (live breaker + dogfood, no test-harness tampering involved) can proceed; but the harness must
not be described as "non-gameable" until M3 lands. Add A and B as M3's first two acceptance tests.
