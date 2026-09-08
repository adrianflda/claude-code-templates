# Constitution — Agentic Dev/Issue-Resolution Harness — v1 (FROZEN)

> **Status:** FROZEN governing document (SDD constitution for this project).
> **Versioning rule:** never overwrite; amendments create `constitution.v2.md`, …
> **Precedence:** this document overrides specs, plans, tasks, and agent prose when they
> conflict. It is deliberately short — principles, not procedures (see Principle 6).
> **Method / engine / teeth:** SDD is the method (spec → plan → tasks → implement); forge
> is the engine (the role pipeline); the deterministic gates are the teeth.

## Purpose
One tool that takes any input — a one-line issue or a large feature — through every
professional stage of software engineering (per `lifecycle-backbone.v1.md`) to a
verified, shipped result, with quality and trust enforced by mechanism at each step, and
the human engaged only where their judgment is irreplaceable.

## Principles (non-negotiable)

1. **Teeth, not prose.** Every quality/safety gate is an executable mechanism (script/hook)
   that returns pass/fail. Prose guides agents; it never *enforces*. If a rule matters, it is code.

2. **Verify by execution.** "Done" is established only by re-executing verification and reading
   real results — never by self-report, and never by an LLM judging its own or another's work.
   Panel-green ≠ correct.

3. **Independence is not another LLM.** The only strong oracles are the **human** (for intent
   and the contract) and a **live executable probe** (for fact). Verification is blind to the
   implementer's reasoning and tests; the oracle is derived from the acceptance criteria.

4. **Rigor ∝ blast-radius.** How much rigor a change receives is decided **deterministically**
   by its risk (the critical surface), not by model judgment. The floor may be raised, never lowered.

5. **Fail-closed on the critical surface.** When a deterministic gate is uncertain about a risky
   change, it blocks. It may fail-open only on the trivial surface. A gate whose failure mode is
   "allow" manufactures false trust and is worse than no gate.

6. **Right altitude — no hobbling.** Agents receive **task + guardrails + done-criterion**, not
   step-by-step procedures. Rigidity lives in the gates; freedom lives in the agents. Prune any
   prose a capable model already knows (the 3R discipline).

7. **Config-by-target.** Behavior and strictness are **data** keyed to the target
   (local/staging/prod). Prod forces maximum rigor and a stop-and-ask before any irreversible or
   outward action.

8. **Zero low-value human interaction** (not "minimal"). The human is engaged **only** at
   high-value points: approving the contract, authorizing irreversible/outward actions, and
   resolving escalations. Never for ceremony. These checkpoints are the product, not friction.

9. **One spine, two doors.** A single lifecycle backbone; features and issues differ only at the
   entry (elicit/analyze vs detect/reproduce/RCA) and the exit (retrospective vs regression
   fixture). No stage is skipped; the router decides how *much* of each applies.

10. **Ground truth over synthetic.** Mechanisms are validated against **real** past bugs and
    incidents, not happy-path fixtures. Every fixed bug becomes a **permanent regression fixture**
    the gates run forever.

11. **Bounded, reversible, proven before scaled.** Every loop has a hard cap + timeout and
    escalates on cap — never loops or spends past budget autonomously. Prefer reversible moves
    (flags, backups, demote-not-delete). A mechanism is trusted only after it is demonstrated on
    real ground truth — including red-teaming the gate itself (prove it blocks a forged pass).

## Constraints
- **Local-first:** no CI infrastructure; gates run locally and at pre-push.
- **Everything versioned, never overwritten** (v1/v2/v3…).
- **The spine is authoritative:** `lifecycle-backbone.v1.md` defines the stages; nothing ships
  by skipping a required stage — only by the router legitimately setting its depth to zero.

## Governance
- **Amendments** create a new version (`constitution.v2.md`); the prior version stays frozen.
- **The human owns:** the contract (intent), irreversible/outward actions, and constitution amendments.
- **Prove-before-scale:** milestones M0→M2 of `build-sequence.v1.md` (make "green" real →
  deterministic routing → dogfood the spine on one real issue) must pass before the rest is built.
