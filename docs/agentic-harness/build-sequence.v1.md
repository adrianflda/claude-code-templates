# Build Sequence — v1 (FROZEN)

> **Status:** FROZEN. Turns the P0–P6 tiers of `gap-analysis.v1.md` into an ordered
> set of milestones (M0–M6), each with a **GREEN criterion** (verifiable by execution)
> and, where relevant, a **tripwire** (prove-or-kill / stop condition). This is the
> direct input to step 5 (the SDD constitution → spec → plan → tasks).
> **Versioning rule:** never overwrite; new versions are `build-sequence.v2.md`, …
> **Altitude:** milestones state WHAT + DONE, not step-by-step HOW. Agents get freedom
> within the gates.

## Ordering principle
Dependency first, leverage second. M0→M2 is the cheap, self-proving core (prove the
foundation + spine on ONE real issue) — it either validates the whole vision or kills it
early. M3–M4 harden it and make it SDD-native. M5–M6 scale and polish. Human-CURATE
items (critical-surface, fixtures) can start earlier in parallel.

---

## M0 — Make "green" mean something *(foundation; unblocks everything)*
**Builds:** G1 (re-executing referee), G2 (red-team it), G3 (fix evidence-gate for metrics).
**🟢 Green when:**
- The referee is a Stop-hook/script that **re-runs the diff-mapped suite in its own
  subprocess**, reads the real exit status itself, and **fails closed** (unknown = FAIL).
- **Red-team passes:** given a FORGED "done" (orchestrator claims pass but the suite is red,
  or only a trivial single test ran), the referee **BLOCKS** — demonstrated by execution.
- Given a genuine green, it **passes**.
- evidence-gate records a **real integer exit code** on a real bash run (not `unknown-schema`)
  and no longer logs prose/PR-comment matches.
**🛑 Tripwire:** if the referee can't reliably re-execute or can't be made non-gameable →
stop and rethink the gate before building anything on it.

## M1 — Deterministic routing *(safety rigor)*
**Builds:** G4 (critical-surface.json, CURATE), G5 (route.mjs), G6 (replay validation).
**🟢 Green when:**
- `critical-surface.json` authored for one repo.
- `route.mjs` is a pure function `diff × globs → {tierFloor, requiresBreaker}`, unit-tested,
  LLM may raise never lower the floor, fail-closed on undetermined surface.
- **Replay validation:** run route.mjs over the REAL PHI/IDOR diff and the inhaler #560 diff
  → **both forced to critical / T1+.**
**🛑 Tripwire:** if the replay does NOT force critical on both real bugs, the globs/approach
are wrong — fix before proceeding. (Parallelizable: G4 can start during M0.)

## M2 — First gated slice (dogfood the spine) *(prove-or-kill the whole vision)*
**Builds:** wire M0+M1 into a minimal end-to-end run; G7 (breaker mandatory on critical),
G8 (reproduction, minimal), G11 (measurement, minimal).
**🟢 Green when:**
- ONE real T1 issue from the backlog runs end-to-end through the forge pipeline, **routed by
  route.mjs, gated by the referee, with the breaker actually executed** on the critical surface,
  producing a real PR.
- "All gates green" is **real green** (referee re-executed, not self-reported).
- **Cost measured** (tokens / $ / wall-clock) and within an acceptable budget.
**🛑 Tripwire (the big one):** if cost is absurd (a large multiple of a reasonable manual fix)
or the pipeline can't produce a real green on a real issue → **stop and reassess economics/design
before scaling.** This milestone is where the vision is proven or killed, cheaply.

## M3 — Verification depth + instrumentation
**Builds:** G9 (regression fixtures from our real bugs), G11 (full measurement + cost circuit-breaker).
**🟢 Green when:**
- The canary fixtures (PHI/IDOR, inhaler #560, RAG faithfulness 0.00) **run on every referee
  invocation** and block on regression.
- Metrics tracked per run: false-green rate, gate-execution rate, cost/issue, human-intervention rate.
- Cost circuit-breaker escalates to human on budget breach (no runaway).

## M4 — SDD-native methodology *(assemble the whole)*
**Builds:** G10 (unify SDD-spec + forge `specifier`); wire the pipeline under SDD.
**🟢 Green when:**
- A real issue/feature is driven from **SDD (constitution → spec → plan → tasks)** into the
  **gated implement pipeline** — one spec phase (no duplication), tasks carrying acceptance
  criteria the referee enforces.
- The harness is now, end to end on one real case: **SDD (method) + forge (engine) + gates (teeth).**

## M5 — Scale, targets, coverage
**Builds:** G12 (config-by-target), G13 (deploy + post-deploy), G14 (security stage),
G15 (non-functional), G16 (dashboard/relaymint agentic E2E), + epic decomposition (issue↔epic).
**🟢 Green when:**
- config-by-target works (local/staging with different gate strictness; prod forces max rigor).
- Security + non-functional stages fire by blast-radius/target.
- The dashboard has a **live agentic E2E gate** (maintain + improve), not mocked.
- An **epic decomposes** into parallel issues, each gated green, + integration gate green.

## M6 — Consolidation + human layer
**Builds:** G17 (demote hierarchy redundancy, reversible), G18 (status line + blast-radius
checkpoints + autonomy dial).
**🟢 Green when:**
- One legible **NOW / NEXT / WAIT** status line is the human's only required surface.
- Human checkpoints fire **only** on irreversible/prod/blast-radius (zero low-value interaction).
- Redundant hierarchy tier demoted **behind a flag** (reversible); autonomy dial per surface.

---

## At-a-glance
| Milestone | Theme | Proves |
|---|---|---|
| M0 | "green" is real | the gate can't be faked |
| M1 | rigor is deterministic | risk routing works on real bugs |
| M2 | spine works on 1 real issue | **the vision, cheaply (or kills it)** |
| M3 | depth + metrics | regressions caught; cost known |
| M4 | SDD-native | method + engine + teeth, unified |
| M5 | scale + coverage | issue↔epic, backend+UI, multi-target |
| M6 | consolidation + UX | legible, reversible, right-altitude |

M0–M2 is the **critical path** and the cheapest honest test of the whole idea. Everything
after only makes sense once M2 is green.
