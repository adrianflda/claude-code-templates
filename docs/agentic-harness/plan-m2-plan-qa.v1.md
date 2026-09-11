# Plan — M2 (reoriented): Plan-with-Teeth + Agentic QA (P2·P4·P5) — v1

> **Status:** SDD technical plan. Implements `spec-m2-plan-qa.v1.md` under `constitution.v1.md`.
> **Altitude:** design decisions + components + how each invariant is proven. Tasks/code are next.
> **Reuse-not-modify (constitution):** M2 WIRES existing pieces (SDD commands, forge, `pipeline-breaker`,
> `adversarial-critic`, the referee/route we built) BY REFERENCE; it does not edit them. The only NEW
> code is additive: the Contract format+compiler, the blind-breaker invoker, the plan-critique gate,
> and a run-ledger. **Versioning:** never overwrite → `plan-m2-plan-qa.v2.md`.

## 1. Key design decisions

- **D1 — The Contract is two coupled files, both committed at base (immutable to the change).**
  - `.quality-kernel/contracts/<id>.md` — human-facing source: EARS criteria, Gherkin scenarios, an
    **observable-invariants table** (id → exact value/code), and the end-to-end **QA procedure** (UI-only
    where applicable). The human approves THIS.
  - `.quality-kernel/acceptance/<id>.test.mjs` (or per-stack) — the executable form: one assertion per
    invariant id, each asserting the **exact** value from the table (qa-paradigms P4). `tools.json`
    `acceptance` runs it; the referee already refuses an `acceptance` command that executes overlaid
    production (H3), so the oracle stays independent.
  - *Why two files:* the `.md` is diff-reviewable by a human; the `.test.mjs` is machine-checkable. A
    compiler/lint step (D6) checks every invariant id in the `.md` has a matching assertion, and vice
    versa — no orphan intent, no unanchored assertion.

- **D2 — The blind breaker is the P5 confidence layer, invoked with a strict information boundary.**
  A new `breaker-invoke.mjs` builds the breaker's input from the Contract ONLY: `{ qaProcedure,
  invariants[], probeCmd, systemUrl }` — and **never** the diff, the coder's tests, or the author's
  reasoning (constitution P3; qa-paradigms P5). It shells out to the host's `pipeline-breaker` agent
  (already designed for exactly this: "receives ONLY the contract + a live URL + probe, NEVER the diff")
  and reads a typed verdict `{ verdict: BREAKER_PASS|BREAKER_FAIL, vectors[], evidence }`. **On the
  critical surface, green REQUIRES `BREAKER_PASS`.** Every falsifying vector the breaker finds is written
  back as a new static assertion in `acceptance/<id>.test.mjs` (qa-paradigms: convert every finding to a
  P2 static spec).

- **D3 — Enforce the breaker in the composed gate (close qk-gate's exit-3 note).** Today `qk-gate.mjs`
  returns exit `3` "breaker required, NOT enforced" on the critical surface. M2 adds `breaker-gate.mjs`
  = `qk-gate` + (if `requiresBreaker`) `breaker-invoke`: `BREAKER_PASS` → exit `0`; `BREAKER_FAIL` →
  exit `1`; breaker could-not-run → exit `2` (fail-closed). qk-gate itself is unchanged (composed, not edited).

- **D4 — Plan-teeth gate BEFORE tasks.** A `plan-gate` step runs `adversarial-critic` against the PLAN
  (spec+plan artifacts, not code) and `/sdd-analyze` for cross-artifact consistency; any unresolved
  CRÍTICO/ALTO blocks task generation. Reused by reference; no new agent.

- **D5 — Research is an explicit first step.** `code-explorer` / `code-architect` (existing) produce a
  research note (patterns, blast-radius, prior incidents) that the specifier consumes when drafting the
  Contract. Output is an input to FR-A2, not a gate by itself.

- **D6 — Contract compiler/lint (`contract-lint.mjs`), deterministic.** Parses `<id>.md`'s invariant
  table and `<id>.test.mjs`; fails (exit 1) if any invariant lacks an assertion or any assertion cites
  no invariant. This is what makes "the plan has teeth" mechanical, not prose.

- **D7 — Run-ledger (`run-ledger.mjs`), minimal.** Appends `{ issue, tokens, usd, wallclockMs,
  humanInterventions, verdict }` per dogfood run to `.quality-kernel/run-ledger.jsonl`. Full metrics +
  cost circuit-breaker are M3; M2 only needs the numbers to evaluate FR-C2/FR-C3.

## 2. Components
| Component | Location | New/Reused | Role |
|---|---|---|---|
| Contract source | `.quality-kernel/contracts/<id>.md` | new (authored) | human-approved EARS/Gherkin/invariants/QA-procedure |
| Acceptance suite | `.quality-kernel/acceptance/<id>.test.mjs` | new (authored) | P2+P4 executable form; run by referee `acceptance` |
| `contract-lint.mjs` | `plugins/quality-kernel/scripts/` | new | invariant↔assertion completeness (D6) |
| `breaker-invoke.mjs` | `plugins/quality-kernel/scripts/` | new | build blind input from Contract; call `pipeline-breaker`; read verdict (D2) |
| `breaker-gate.mjs` | `plugins/quality-kernel/scripts/` | new | qk-gate + enforced breaker on critical (D3) |
| `run-ledger.mjs` | `plugins/quality-kernel/scripts/` | new | per-run cost/intervention record (D7) |
| `pipeline-breaker` | host agent | reused (by ref) | P5 blind live-oracle |
| `adversarial-critic` | host agent | reused (by ref) | plan-critique (D4) |
| `code-explorer`/`code-architect`/`specifier` | host agents/forge | reused (by ref) | research + Contract drafting |
| `/sdd-clarify`,`/sdd-analyze` | host commands | reused (by ref) | elicitation + consistency gate |
| referee / route / qk-gate | `plugins/quality-kernel/scripts/` | reused (built) | P2 re-execution + tiering |

## 3. Pipeline flow (one issue, reusing the spine)
1. **Research** (`code-explorer`/`code-architect`) → research note.
2. **Contract** (`specifier` + `/sdd-clarify`) → `contracts/<id>.md` + `acceptance/<id>.test.mjs`;
   `contract-lint.mjs` green; **human approves** (the one high-value checkpoint).
3. **Plan-gate** (`adversarial-critic` on the plan + `/sdd-analyze`) → 0 CRÍTICO/ALTO → tasks.
4. **Implement** (forge coder→cleaner→architect→hardener) against tasks anchored to the Contract.
5. **QA** — referee re-executes: coder tests (head), base harness × head production, AND the
   **acceptance suite** (P2+P4). Route sets the tier.
6. **Breaker** (critical surface) — `breaker-gate.mjs`: blind `pipeline-breaker` on the live system;
   `BREAKER_PASS` required for green; found vectors → new acceptance assertions.
7. **PR + ledger** — real PR; `run-ledger.mjs` records cost/interventions.

## 4. How each invariant is proven (spec §4 → verification)
| Invariant | How proven |
|---|---|
| INV-M2-1 (contract exists+approved) | pipeline blocks step 3+ without an approved `contracts/<id>.md`; `contract-lint` green (unit-tested) |
| INV-M2-2 (P4 anchor) | test: a coder suite that passes but whose value contradicts the invariant → the acceptance suite (from the Contract) fails. *(Extends the existing ACCEPTANCE-ORACLE regression.)* |
| INV-M2-3 (P5 blind) | test: `breaker-invoke` given a change that passes coder tests but violates a live invariant → `BREAKER_FAIL`, `breaker-gate` non-zero; and an assertion that the breaker input contains NO diff/reasoning fields |
| INV-M2-4 (plan teeth) | test: a plan with an injected CRÍTICO (or a spec↔tasks mismatch) → plan-gate blocks |
| INV-M2-5 (genuine RED) | for each invariant, revert the behavior → its acceptance assertion goes red (scripted) |
| INV-M2-6 (dogfood green+cost) | **one real run** on a chosen repo issue reaches real green (referee + BREAKER_PASS) with `run-ledger` numbers within budget — proven by the run, not a unit test |

## 5. The blind-breaker information boundary (D2, explicit)
Breaker input = ONLY `{ qaProcedure, invariants:[{id,expected}], probeCmd, systemUrl }`. **Excluded:**
the diff, changed files, the coder's tests, any agent chain-of-thought. `breaker-invoke.mjs` constructs
this object and a test asserts the excluded keys are absent (sharing reasoning collapses P5 — qa-paradigms).

## 6. Definition of done
Components in §2 exist; `node --test` green on the unit-provable invariants (INV-M2-1…5); and **one real
dogfooded issue** reaches a real green (referee re-executed + `BREAKER_PASS` on the critical surface) with
recorded cost within budget (INV-M2-6) — or the tripwire (spec FR-C3) fires and we stop. = the M2 spec's DoD.
