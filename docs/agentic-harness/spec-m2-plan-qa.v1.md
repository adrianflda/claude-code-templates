# Spec — M2 (reoriented): Plan-with-Teeth + Agentic QA (P2·P4·P5) — v1

> **Status:** SDD spec. **Reorients** milestone M2 of `build-sequence.v1.md` (originally "first gated
> slice / dogfood the spine — prove-or-kill"). It keeps M2's essence — drive ONE real issue end-to-end,
> gated, on the critical surface, cost measured — but sharpens the focus onto the two stages that today
> have the LEAST mechanism and the MOST leverage: **(A) the plan / research** and **(B) the QA that ends
> green**. Coding and clean-up are already well-served (forge coder → cleaner → architect → hardener);
> they are not where the risk is. Governed by `constitution.v1.md` (P1 teeth, P2 verify-by-execution,
> **P3 independence≠another-LLM**, P4 rigor∝blast-radius, P10 ground-truth). QA design follows the
> `qa-paradigms` skill (the 5 paradigms). **Versioning:** never overwrite → `spec-m2-plan-qa.v2.md`.

## 1. Purpose

Make the **front half (plan/research)** and the **back half (QA)** trustworthy **by mechanism**, not by
an agent's prose. Today the plan is prose an LLM writes and nothing checks; QA correctness rests on the
coder's own tests. This milestone gives both **teeth**, proven on **one real issue in this repo**
(self-hosting — ground-truth without pulling in any external application), with cost measured.

The keystone that unifies both halves is a single artifact:

> **The Contract** — a human-approved, machine-checkable statement of *what correct means*, produced by
> the plan and consumed by QA. Everything downstream anchors to it (qa-paradigms P4); the coder cannot
> silently change it.

## 2. What it does (functional requirements)

### A. The plan produces a machine-checkable Contract (front-half teeth)
- **FR-A1 — Research before design.** A change begins with an explicit research/analysis pass
  (reuse `code-explorer` / `code-architect` / `deep-research-team`): existing patterns, blast-radius,
  prior incidents. Output feeds the spec; it is not skipped.
- **FR-A2 — The Contract artifact.** The plan's output includes `.quality-kernel/contracts/<id>.md`
  containing: **EARS** acceptance criteria, **executable Gherkin** scenarios, a table of **observable
  invariants** (exact values/codes, not paraphrase), and an **end-to-end QA procedure** (UI-only where
  applicable — it becomes the breaker's probe). Authored by the specifier, **approved by the human**.
- **FR-A3 — The Contract is executable.** It compiles to an **acceptance suite** the referee runs via
  `tools.json "acceptance"` — DISTINCT from the coder's tests, immutable-from-base (already enforced:
  the referee refuses an `acceptance` command that executes overlaid production code).
- **FR-A4 — The plan survives an independent critic (teeth on the plan).** Before tasks are generated,
  an **adversarial critic** attacks the PLAN (not the code) for gaps/ambiguity/missing NFRs, and
  `/sdd-analyze` checks cross-artifact consistency (spec↔plan↔tasks). Unresolved CRÍTICO/ALTO blocks.

### B. QA ends green by mechanism, composing the 5 paradigms (back-half teeth)
- **FR-B1 — P2 (static, re-executed).** QA is a static suite the **referee re-executes** deterministically
  (no LLM in the pass/fail loop). Already built.
- **FR-B2 — P4 (contract-anchored).** Every assertion maps to an invariant in the Contract (FR-A2) —
  **exact values/codes, not the coder's restatement of intent.** An assertion not traceable to the
  Contract is a QA defect.
- **FR-B3 — P5 (blind adversarial validation).** On the critical surface, a **blind breaker**
  (`pipeline-breaker`, ideally a different model family) receives **ONLY the Contract + a live probe** —
  never the diff, the coder's tests, or the author's reasoning — derives falsifying vectors, EXECUTES
  them against the running system, and returns a typed verdict. **Green requires `BREAKER_PASS`.**
- **FR-B4 — P1 avoidance / P3 discipline.** Selectors are stable (testid→role→label; no self-heal — a
  broken selector must FAIL). A runtime agent (P3) may explore but **never** decides pass/fail.
- **FR-B5 — Genuine RED.** Each acceptance/QA test is proven to fail on the broken/absent behavior and
  pass only on the correct one (revert-the-behavior → red).

### C. End-to-end on one real issue, cost measured (prove-or-kill)
- **FR-C1 — Dogfood.** Drive ONE real issue from THIS repo: research → Contract (human-approved) →
  implement (forge) → QA(P2·P4·P5) → gate green by re-execution + blind breaker on the critical surface
  → a real PR.
- **FR-C2 — Measure.** Record tokens / $ / wall-clock and human-intervention count for the run.
- **FR-C3 — Tripwire.** If cost is a large multiple of a reasonable manual fix, or the pipeline cannot
  produce a real green on a real issue → **stop and reassess** before scaling (the M2 kill-condition).

## 3. Non-functional
- Local-first; language/stack-agnostic. The Contract format is human-writable and diff-reviewable.
- **Zero low-value human interaction (P8):** the human touches exactly two points — **approve the
  Contract** (intent) and **resolve escalations** — nothing ceremonial.
- Independence is real (P3, qa-paradigms P5): the validator sees only the Contract + probe, never the
  author's chain-of-thought — otherwise consensus is fake.

## 4. Observable invariants (the contract of THIS milestone — proven by execution)
- **INV-M2-1 (Contract exists & is approved).** No implementation task runs until an approved
  `contracts/<id>.md` exists; its acceptance suite runs under the referee as `acceptance`.
- **INV-M2-2 (P4 anchor).** A coder test whose expected value contradicts the Contract's invariant is
  caught: the acceptance suite (from the Contract) fails even though the coder's own suite passes.
  *(Already demonstrated by the ACCEPTANCE-ORACLE regression in `attacks.test.mjs`.)*
- **INV-M2-3 (P5 blind).** The breaker is invoked with the Contract + probe only; given a change that
  passes the coder's tests but violates a Contract invariant on the live system, the breaker returns
  `BREAKER_FAIL` and the gate does **not** go green. A breaker that received the diff = spec violation.
- **INV-M2-4 (plan teeth).** A plan with an unresolved CRÍTICO from the plan-critic, or a spec↔tasks
  inconsistency from `/sdd-analyze`, blocks task generation.
- **INV-M2-5 (genuine RED).** For each Contract invariant, reverting the implemented behavior turns its
  acceptance test red (proven, not assumed).
- **INV-M2-6 (dogfood green + cost).** One real issue reaches a real green (referee re-executed + blind
  breaker passed on critical) and its cost is recorded and within budget.

## 5. Out of scope (later milestones)
- Full metrics dashboard / cost circuit-breaker (M3); epic decomposition + config-by-target (M5);
  non-functional/security stages wired by target (M5); consolidating the forge/orchestrator layers (M6).
- M2 delivers: the Contract mechanism, the QA(P2·P4·P5) stage, and one measured dogfood run.

## 6. Definition of done (M2 GREEN)
INV-M2-1…INV-M2-6 pass **by execution** on one real issue from this repo — above all **INV-M2-3**
(the blind breaker, P5, blocks a change that violates the Contract on the live system) and **INV-M2-6**
(a real green at a known, acceptable cost). When green: the plan has teeth (an approved, executable
Contract), QA is P2·P4·P5 by mechanism, and the vision is proven — or the tripwire kills it cheaply.
