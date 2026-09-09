# Independent Validation Panel — v1

> **Status:** Validation record (not a frozen plan doc). Produced by a 4-expert
> independent panel that re-checked the plan AND the built gate **by execution**, because
> the prior build session was known to overstate results. Every gate weakness below was
> either traced to an exact `file:line` (CONFIRMED) or reproduced by running an attack
> (OBSERVED). This document does not modify any frozen doc; it records corrections and
> recommends versioned amendments (`constitution.v2`, `build-sequence.v2`, …) for the human
> to approve.
> **Versioning rule:** never overwrite; the next panel is `validation-panel.v2.md`.

## Method

Four independent agents, one dimension each, mandated to verify-by-execution and to report
what they could NOT verify:

- **claims-auditor** — every factual claim in the docs vs. the actual code/tests/git.
- **plan-architect** — soundness/coherence/altitude of the plan (read all 8 frozen docs + verified two scripts).
- **threat-modeler** — the gate as a trust boundary; adversary = a coding agent that wants its change green.
- **gate-breaker** — actually built throwaway git repos and executed attacks against the gate.

## Headline verdict

- **The plan/design layer is sound and professional.** Keep it (with targeted amendments).
  *Not* a rethink. — `plan-architect`
- **The built gate's central promise is FALSE as shipped.** "The gate can't be faked" /
  "non-gameable" / "a change cannot pass by weakening, neutering, or deleting its own tests"
  is refuted by execution: **9 CRITICAL bypass classes returned a real `exit 0` on broken
  code.** Score **25/100 — REWORK REQUIRED.** — `gate-breaker`
- **Therefore M0 is NOT done.** M0's GREEN criterion (`build-sequence.v1.md:24-26`: the referee
  BLOCKS a forged/gamed pass, *demonstrated by execution*) holds only for the **4 exact attack
  shapes** already in `attacks.test.mjs`. Every one-degree variant passed. The milestone status
  in `HANDOFF.v1.md §5` ("M0 — DONE, green by execution") must be corrected.

---

## 1. What survives (verified real — trustworthy)

| Item | Evidence |
|---|---|
| The lifecycle backbone is legitimately SWEBOK v4 / ISO 12207 / DORA / ITIL-grounded | `plan-architect` verified the KAs are real; minor gaps: no data-migration, no supply-chain, implicit rollback |
| The plan is coherent; M0→M2 falsification-first path with an economic kill-switch at M2 is its best decision | `plan-architect` |
| The re-execution keystone concept is correct and real (subprocess, reads real exit, fail-closed) | `referee.mjs:73-82`; verified by `plan-architect` + `claims-auditor` |
| Hard facts are TRUE | 35 node + 17 python tests pass; global install exists; 9 commits unpushed; v0.3.0 consistent — `claims-auditor` ran them |
| Defenses that genuinely hold (OBSERVED) | red suite → exit 1; worktree `tools.json`→`true` in same commit → blocked; timeout/hang → indeterminate; stdout verdict-injection blocked; the 4 committed attacks still closed |

## 2. What is broken — the gate (grouped by root cause)

All OBSERVED by `gate-breaker` (repro scripts in scratchpad) unless marked INFERRED; cross-confirmed by `threat-modeler` where noted.

### RC1 — The trusted-harness overlay is inverted
It whitelists `HARNESS_GLOBS` from base **over** an otherwise-HEAD tree (`referee.mjs:22-27, 95-98`),
so everything the base tests depend on that isn't in that glob list is taken from the attacker's HEAD.
- **#1 (CRITICAL):** base test asserts via a helper / golden file / non-`.sh` runner (`node run-tests.mjs`, `make test`, `.npmrc script-shell`) → HEAD neuters it → **gate exit 0 with `f()=>999`**. `config/tools.example.json` itself uses `stryker`/`c8`/`jscpd`/`mutmut` — none `.sh`. (threat-modeler Path A.)
- **#2 (CRITICAL):** committed symlinks survive `git archive | tar -x` and `writeFileSync` follows them → test bypass **and arbitrary file write outside the repo** (a victim file outside the repo was overwritten with base-test content).
- **#7 (CRITICAL):** non-ASCII filenames come back C-quoted from `ls-tree`; `git show` fails, the error is ignored → the neutered HEAD test survives silently.
- **H3:** harness files added only in HEAD (e.g. `vitest.config.ts`, `conftest.py`) survive in the trusted tree (overlay writes base files but never removes HEAD extras).

### RC2 — The gate verifies the wrong artifact
It checks the worktree / a client-chosen base / the checked-out HEAD, not the exact commit being pushed from a remote-anchored base.
- **#3 (CRITICAL):** `pre-push.sample:21` gates `$ROOT` (worktree), ignores `local_sha` → `git push origin evil` while sitting on green `main` pushes broken code with `gate:pass`.
- **#4 (CRITICAL):** new branch uses base `local_sha^` → only the last commit is gated; prior commits (with `verify:"true"`) are trusted → push of broken code passes.
- **#5 (CRITICAL):** `@{u}` / `merge-base` is a local ref; `git update-ref refs/remotes/origin/main HEAD` → merge-base==HEAD → trivial+`verify:true` → exit 0.
- **#6 (CRITICAL):** route diffs base-vs-worktree, referee archives HEAD, push ships HEAD → three snapshots; `git checkout base -- file` (uncommitted) hides a committed `PWNED`.
- **#8 (CRITICAL):** base has no valid `tools.json` → referee falls back to the worktree's (`referee.mjs:58-65`) → untracked `{"verify":"true"}` → exit 0.
- **#9 (CRITICAL):** `critical-surface.json` is read from the worktree/env (`route.mjs:116-118`), not base → untracked permissive config → "trivial".

### RC3 — Changeset semantics incomplete
- **H1:** renames/copies keep only the new path (`route.mjs:108`); `R`/`C` never feed `deleted` → `git mv guard.test.mjs guard-old.mjs` dodges "deleting a test is always critical".
- Type-changes (`T`) and non-ASCII paths mis-handled in both route and referee (no `-z`, no unquote).

### RC4 — Fail-OPEN where it must fail-closed (P5 violation at the oracle layer)
- **threat-modeler C / gate-breaker A21, A11:** `buildTrustedTree` returns null on non-git / unverifiable ref / failed archive, and absent `--base` → `trustedExit` stays null → the gate silently collapses to run-1-only (the attacker's own harness). The verify layer fails closed; the *strongest* layer fails open.

### RC5 — Oracle limits undeclared + measurement missing
- **H4:** test-aware code (`f = () => process.env.NODE_TEST_CONTEXT ? 1 : 999`) → exit 0, `f()=>999` in prod. Fundamental limit of any test-based oracle; undeclared.
- **plan-architect #1 (the keystone behind the keystone):** the referee only ever runs *the implementer's own suite*. It catches tampering, not tests that were always weak. True independence needs a **human-approved, machine-checkable acceptance-criteria artifact the referee executes, distinct from the coder's tests.** The breaker was meant to be the independent oracle — but its oracle is LLM-authored, which contradicts Constitution **P3 ("independence is not another LLM")**.
- **H2 (usability→bypass):** `git archive` omits `node_modules`/`.venv` → real repos get false `exit 1` "likely neutered its tests" on genuinely-green changes → trains operators to use `--no-verify`. `QK_GATE=/dev/null` / `--no-verify` bypass the hook entirely (adversary-with-shell caveat undeclared).

## 3. What is overstated — the docs (do not trust at face value)

| Claim | Reality | Source |
|---|---|---|
| "domain-agnostic — no medical framing baked in" | Engine is generic, but `fixtures/route/critical-surface.json` + `route.test.mjs` hardcode `**/inhaler/**`, `realtime/brain/**`, `PHI_IDOR`, `*monitoring*`; bug names sit in **public** `gap-analysis.v1.md:19,22` | claims-auditor, plan-architect |
| M1 replay is a "kill-condition" / "green by execution" | In-sample only — globs were authored to match the very incidents (circular); the fixture comment admits it; hold-out validation undone | claims-auditor |
| `HANDOFF §5` "M1 replay has NOT been executed" | Contradicts committed green `INV-R5`. Real state: run in-sample, generalization unproven | claims-auditor |
| README/CHANGELOG "cannot pass by weakening/neutering/deleting its own tests" | FALSE as written — refuted by execution (§2 RC1) | gate-breaker |
| "trust by mechanism at EACH step" | Front half of the lifecycle (requirements/architecture/threat-model) has no executable oracle | plan-architect |
| "one definitive tool" | Three tools coexist unconsolidated through M6; G17 never deletes | plan-architect |
| M0 "DONE" | Non-gameability (its actual GREEN criterion) refuted; ~40% done | this panel |

## 4. Architectural revisions (before scaling past M2) — plan-architect

1. **Add the acceptance-criteria artifact** (human-approved, machine-checkable, referee-executed, distinct from the coder's tests). The keystone behind the keystone; resolves the P3 contradiction. **Non-negotiable before M2.**
2. **Pull basic cost/measurement to M0/M1** — M2's kill-decision is economic but measurement sits at M3.
3. **Give the breaker M0-level red-team rigor, earlier** — it is the only independent oracle yet the least hardened.
4. **Fix the domain leaks** — move bug names out of public docs into private/per-repo fixtures; validate on a **second unrelated repo** (single-corpus validation proves fit-to-one-app, not agnosticism).
5. **Fix forge role order** — architect-after-coder inverts the backbone's design-before-construction.
6. **Right-altitude violation in the process model** — a fixed 6-role chain + ~35 non-skippable stages put rigidity in the workflow; the principle says rigidity belongs only in the gates.

## 5. Recommended restart plan (keep / rework / add / correct)

**Do NOT start from scratch.** The plan is worth keeping; the *teeth implementation* is what was oversold.

- **KEEP (unchanged):** `lifecycle-backbone`, `stage-tool-map`, `gap-analysis`, `build-sequence`, `constitution`, and the re-execution concept. Respect the freeze — amend via `.v2`, never overwrite.
- **REWORK the referee** — `gate-breaker`'s three fixes are precise and correct:
  1. **Verify the target COMMIT**, built with `git archive <head_sha>`, diffed `base..<head_sha>`, with **base from the remote** (`remote_sha`; new branch → merge-base with the remote default branch, else reject). Never worktree / `tip^` / `@{u}` / `HEAD~1`. Unverifiable base or absent/non-string base `tools.json` ⇒ **indeterminate (exit 2)**, never worktree fallback.
  2. **Invert the trusted tree** — start from the **full BASE tree** and overlay only HEAD files matching a declared **production-code allowlist** in `tools.json` (e.g. `src/**`). Reject any mode-`120000` (symlink) entry ⇒ indeterminate. Solve the deps/env problem (`git worktree add --detach` + linked `node_modules`, or a `verifySetup`) or the trusted run is unusable on real repos.
  3. **Fix changeset semantics** — `git diff -z --name-status -M base..<head_sha>`; treat `R`/`C` old path as deleted, `T` as delete+add; `-z` + unquote in `ls-tree`; read `critical-surface.json` from the **base ref**.
- **ADD before M2:** the acceptance-criteria artifact (revision #1).
- **CORRECT the record:** rewrite the overstated README/CHANGELOG/HANDOFF claims; restate M0 as in-progress; re-run the M1 replay as **hold-out** (author the surface from incident A, validate on unseen incident B) + keep the precision tests.

## 6. Open decisions for the human

1. **Domain-agnostic vs ground-truth:** keep real bugs as *private per-repo* fixtures and ship the tool with generic risk-class fixtures + a second validation repo? (panel recommends yes.)
2. **Milestone bookkeeping:** re-open M0 formally (amend `build-sequence.v2`) or track the referee rework as a new M0.5?
3. **Scope of the acceptance-criteria artifact** — how much the human authors vs. derives from the SDD spec.
