# Spec — M0: Re-executing Verification Referee — v1 (FROZEN)

> **Status:** FROZEN spec (SDD). Scope = milestone **M0** of `build-sequence.v1.md`
> ("make 'green' mean something"). Governed by `constitution.v1.md`.
> **Versioning rule:** never overwrite; changes → `spec-m0-referee.v2.md`.
> **Altitude:** this states WHAT + acceptance criteria + observable invariants. HOW
> (exact hook mechanism, language) belongs to the plan, not here.

## 1. Purpose
Make "done" trustworthy. Today the harness (an LLM orchestrator) both does the work and
reports whether the gates passed — so it can declare success that never happened
(Constitution P2; evidence-ledger is 112/112 fake). The **referee** replaces that
self-report with an independent mechanism that **re-executes** the verification itself and
admits "done" only on real results.

## 2. Users / scenarios
- **The harness**, at the moment it would mark a unit of work "done" / ready to ship: the
  referee runs and either unlocks or blocks.
- **The human**, who needs to trust that a green result is real without re-checking by hand.

## 3. What it does (functional requirements)
- **FR1 — Re-execute, don't trust.** The referee determines the change (git diff), maps it to
  the project's verify command(s)/test suite(s), and runs them **in its own subprocess**,
  reading the real exit status itself. It never parses another agent's prose, log, or claim as
  the pass/fail signal.
- **FR2 — Diff-mapped scope.** It runs the suite(s) that exercise the changed files (not a single
  test the author points at). A trivially-passing unrelated test cannot satisfy it.
- **FR3 — Fail-closed.** Any indeterminate result — unreadable exit status, no mapped tests for a
  changed file on the critical surface, a verify command that errors — yields **FAIL**, never PASS.
- **FR4 — Typed verdict.** It emits a typed record: `{ pass, evidence: { command, exit_code,
  tests_passed, tests_failed }, reason }`. Downstream trusts only this record.
- **FR5 — Evidence-gate repaired (audit layer).** The existing `evidence-gate` hook records a
  **real integer exit code** for real verify commands (no `unknown-schema`) and does **not** log
  matches found in the prose body of a non-verify command (e.g. a `gh pr comment` heredoc). This
  is the audit/metrics layer; the *gate* is FR1–FR4 (which re-execute, so they don't depend on it).

## 4. Non-functional
- **NFR1 — Deterministic:** same inputs → same verdict.
- **NFR2 — Local-only:** no network/CI (Constitution constraint).
- **NFR3 — Cheap enough to run on every "done":** scoped to the diff-mapped suite where possible.

## 5. Observable invariants (the contract — how it is proven)
Each is a falsifiable predicate with a probe against a fixture repo:
- **INV1 — A forged pass never yields PASS.** *Probe:* fixture where the claim says "done/pass"
  but the mapped suite is RED → referee returns **FAIL**. *(This is the red-team, G2.)*
- **INV2 — A genuine pass yields PASS.** *Probe:* fixture with a real green mapped suite →
  referee returns **PASS** with recorded exit 0.
- **INV3 — Scope cannot be gamed.** *Probe:* fixture where only a trivial unrelated test passes
  while the diff-mapped suite is RED → referee returns **FAIL**.
- **INV4 — Indeterminate → FAIL.** *Probe:* fixture with a verify command that errors / yields no
  readable exit status → referee returns **FAIL**.
- **INV5 — Evidence-gate integrity.** *Probe:* run a real `vitest/jest/pytest` command → the
  ledger records a real integer exit code; run a `gh pr comment` with test-words in its body →
  the ledger records **nothing**.

## 6. Out of scope (later milestones)
`route.mjs` / blast-radius (M1); the live breaker (M2); config-by-target; the full role pipeline;
measurement dashboards (M3). M0 is surface-agnostic: it re-runs the mapped suite regardless of tier.

## 7. Definition of done (M0 GREEN)
All five invariants INV1–INV5 pass **by execution against the fixtures** — most importantly INV1
(the forged pass is blocked) and INV4 (indeterminate fails closed). When these are green, "green"
means something, and every later milestone can be built on top.
