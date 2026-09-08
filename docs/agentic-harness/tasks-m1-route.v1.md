# Tasks — M1: Deterministic Risk/Tier Router (`route.mjs`) — v1 (FROZEN)

> **Status:** FROZEN task list (SDD). Executes `plan-m1-route.v1.md` → `spec-m1-route.v1.md` →
> `constitution.v1.md`. **Versioning:** never overwrite → `.v2`.
> **Convention:** `[P]` = parallelizable. Each task is DONE only when its **AC** passes **by
> execution**. Paths under `plugins/quality-kernel/` in `claude-code-templates`.

## Track A — Config template
- **T1. Update the `critical-surface` template.** Refresh `config/critical-surface.example.json`
  (`criticalGlobs` + `safeGlobs`) and document the `.quality-kernel/critical-surface.json`
  convention `route.mjs` reads.
  **AC:** the template parses; the doc names the read location and the fail-safe-when-absent rule.

## Track B — Glob matcher *(parallel with A)*
- **T2 [P]. Minimal glob matcher** inside `route.mjs` (exported): `**`,`*`,`?` → RegExp, specials
  escaped, full-path anchored.
  **AC:** unit cases pass — `**/auth/**` matches `app/auth/x.ts` and `auth/y.ts`; `**/*.sql`
  matches `db/m.sql`; `*` does not cross `/` (`src/*` ≠ `src/a/b`).

## Track C — Router core *(needs T1, T2)*
- **T3. Resolve change + load config.** `route.mjs`: `--changed` list or `git diff`; load
  critical-surface.json; absent → fail-safe mode. Git error → exit `2`.
  **AC:** `--changed a,b` lists them; a missing repo/git → exit `2`.
- **T4. Classify + floor + verdict.** Implement FR3–FR6 (tierFloor, tier=max(floor,proposed),
  requiresBreaker, typed verdict, exit 0).
  **AC:** INV-R1 (critical glob → critical+breaker), INV-R2 (safe-only → trivial),
  INV-R3 (no config → critical), INV-R4 (floor raises-not-lowers) — all by execution.

## Track D — Real-bug replay inputs *(parallel with C)*
- **T5 [P]. Author the replay config + changesets.** `fixtures/route/critical-surface.json` whose
  `criticalGlobs` catch the PHI/IDOR files AND the inhaler #560 files; record the two changed-file
  lists as fixture data.
  **AC:** the config parses; the PHI/IDOR file list is present.
- **T6. Resolve the inhaler #560 changed files.** `git -C phoenixcare-call-websocket show --stat`
  on the #560 fix commit; record the file list into the fixture.
  **AC:** the #560 changed-file list is captured in the fixture data.

## Track E — Router tests (the invariants + kill-condition)
- **T7. `route.test.mjs` (node --test).** Assert INV-R1…INV-R4 against fixtures, and **INV-R5**:
  `route.mjs --changed <PHI/IDOR files>` → `critical`, and `--changed <#560 files>` → `critical`,
  using the authored config.
  **AC:** `node --test route.test.mjs` green; INV-R5 forces `critical` on BOTH real bugs.
  🛑 If either real bug does not classify `critical`, the globs/approach are wrong — fix before T8.

## Track F — M1 acceptance
- **T8. Prove M1 green by execution.** Run `route.test.mjs`; run `route.mjs` once on a real change.
  **AC (= M1 DoD):** INV-R1…INV-R5 all pass by execution, above all the INV-R5 replay.

## Dependency graph
```
T1 ─┐
T2 ─┴─ T3 → T4 ─┐
                ├─ T7 → T8 (M1 GREEN)
T5 [P] → T6 ────┘
```
