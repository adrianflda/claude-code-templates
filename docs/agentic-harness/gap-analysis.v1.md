# Gap Analysis — v1 (FROZEN)

> **Status:** FROZEN. Analyzes the ❌ gaps and critical 🟡 items from
> `stage-tool-map.v1.md`, classifies each, maps dependencies, and groups them into
> priority tiers (P0–P6) by dependency + leverage. Feeds step 4 (sequencing).
> **Versioning rule:** never overwrite; new versions are `gap-analysis.v2.md`, …
> **Work types:** FIX (repair broken) · BUILD (new mechanism) · WIRE (connect an
> existing agent as a stage) · CURATE (human authors data) · UNIFY (merge/delete redundancy).

## The gaps, classified

| # | Gap | Type | Why it matters | Depends on | Leverage / effort |
|---|---|---|---|---|---|
| G1 | **Re-executing referee** — unlocks "done" only by RE-RUNNING verification itself (own subprocess), diff-mapped suite, **fail-closed** | BUILD | The single keystone for trust. Without it the orchestrator judges its own work → the exact scar ("self-report resolves yes", "panel-green ≠ correct"). Experts: reconciling a ledger is gameable; **re-execution is the only non-fakeable design.** | — (self-contained; re-runs, doesn't trust the ledger) | 🔺 highest / M |
| G2 | **Red-team the gate** — feed it a FORGED "pass", confirm it BLOCKS | BUILD (test) | A gate never tested against a fake pass is not a gate. Acceptance criterion for G1. | G1 | 🔺 high / S |
| G3 | **Fix evidence-gate** — real exit-code field (probe real payload) + regex matches the command token, not prose in heredocs | FIX | Today 112/112 "unknown-schema"; matched a PR comment as "verification". Needed for **metrics/audit** (not as the gate — G1 re-executes). | — | high / S |
| G4 | **`critical-surface.json`** (per repo) — the risk globs | CURATE | The keystone config that route.mjs reads. Does not exist (only `.example`). Human judgment, ~1h/repo. | — | high / S (human) |
| G5 | **`route.mjs`** — deterministic blast-radius/tier classifier (diff × critical-surface); LLM may raise, never lower the floor; runs recursively per subproject | BUILD | Makes rigor a mechanism, not prose. Prevents mis-routing a critical change to a cheap lane. Nests tiering into decomposition. | G4 | 🔺 high / M |
| G6 | **Validate route.mjs by replay** — run it against the REAL past-bug diffs (PHI/IDOR, inhaler #560); must force critical on both | BUILD (test) | Falsify the classifier against ground truth before trusting it. Kill-condition if it fails. | G5, G4 | high / S |
| G7 | **Breaker non-optional on the critical surface** — wire `pipeline-breaker` as a forced gate when route.mjs flags critical; blind (spec-derived oracle, not the coder's tests); ideally a different model family | WIRE | The independent live oracle. Exists as an agent but is by-reference/skippable today. Catches live-only bugs code-reading misses. | G5, G1 | 🔺 high / M |
| G8 | **Reproduction mechanism (B.3)** | BUILD | The engineering crux of issue resolution; no reliable fix without a repro. Also the seed of the regression fixture. | — | high / M |
| G9 | **Regression-fixture mechanism (B.7)** — each fixed bug becomes a permanent canary; seed from OUR real bugs (PHI/IDOR, inhaler #560, RAG faithfulness 0.00) | BUILD + CURATE | Turns history into the acceptance oracle (SWE-bench-style). The referee runs these every time. | G1, G8 | 🔺 high / M |
| G10 | **Unify SDD-spec + forge `specifier`** — one spec phase/engine | UNIFY | Removes a duplicated "define" mechanism; makes SDD the method and forge the engine inside it. | — | med / M |
| G11 | **Measurement** — cost/issue, false-green rate, gate-execution rate, human-intervention rate; cost circuit-breaker (budget/issue → escalate) | BUILD | You cannot trust or tune what you don't measure. Cost of a full run is unknown today (can blow up 3–10×). | G3 | high / M |
| G12 | **config-by-target (local/staging/prod)** — one config selecting gate strictness + probe URL + E2E base-URL per target | BUILD | Threads target through routing, breaker, deployment, dashboard E2E. Prod forces max rigor. | G5 | med / M |
| G13 | **Deployment + post-deploy verification (5.2/5.3)** | BUILD | Release stage; smoke/breaker in the real target. | G12 | med / M |
| G14 | **Threat-modeling/security stage (2.3)** — wire `security-auditor`/`api-security-audit`, triggered by blast-radius | WIRE | SWEBOK v4 KA; the recent PHI/IDOR shows this matters. Agents exist, not wired. | G5 | med / S |
| G15 | **Non-functional testing (4.3)** — wire `accessibility-tester`/perf, triggered by target/blast-radius | WIRE | Coverage gap; agents exist, not wired. | G5, G12 | med / S |
| G16 | **Dashboard/UI agentic E2E (relaymint)** — copy `frontend-qa` model, config-by-target, live-not-mocked | BUILD | First-class UI pillar (maintain + improve). | G12 | med / L |
| G17 | **Demote the hierarchy redundancy** — collapse `subproject-pm` handoff; keep decompose/contract/integrate behind a flag (reversible, don't delete) | UNIFY | Removes duplication once forge spine is proven. Reversible. | G1 proven | low / M |
| G18 | **Autonomy dial + human checkpoints** — one status line; checkpoints fired by blast-radius (irreversible/prod), not fixed count | BUILD | "Zero LOW-value human interaction" (not "minimal"); legibility + trust. | G5, G11 | med / M |

## Priority tiers (by dependency + leverage)

- **P0 — Make "green" mean something (foundation; unblocks all):** G1 (referee) + G2 (red-team it) + G3 (fix evidence-gate for metrics). *Nothing downstream is trustworthy until this exists and is proven to block a fake pass.*
- **P1 — Make rigor deterministic (safety routing):** G4 (critical-surface) → G5 (route.mjs) → G6 (replay against real bugs).
- **P2 — Independent verification depth:** G7 (breaker mandatory) + G8 (reproduction) + G9 (regression fixtures from our bugs).
- **P3 — Instrument it:** G11 (measurement + cost circuit-breaker).
- **P4 — Method consolidation:** G10 (unify SDD-spec + specifier).
- **P5 — Targets, release, coverage:** G12 (config-by-target) → G13 (deploy) ; G14 (security), G15 (non-functional), G16 (dashboard E2E).
- **P6 — Cleanup + human layer:** G17 (demote hierarchy, reversible), G18 (status line + blast-radius checkpoints).

## Notes carried from the think-tank (constraints on the build)
- The referee **re-executes**; it does not trust an LLM/ledger claim (non-gameable).
- Deterministic gates **fail-closed on the critical surface**, fail-open on trivial.
- Rigidity lives in the **gates**; agents get **task + guardrails + done-criterion** (right altitude, no hobbling).
- Reframe: **"zero low-value human interaction"**, not "minimal" — clinical/irreversible checkpoints are the product.
- Prove each piece by **execution against real ground truth**, not synthetic happy-paths.
