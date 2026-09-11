# Stage → Tool/Piece Map — v1 (FROZEN)

> **Status:** FROZEN. Maps every stage of `lifecycle-backbone.v1.md` to the specific
> tool — or **piece** of a tool (a role, command, hook, or script) — that serves it.
> **Versioning rule:** never overwrite; new versions are `stage-tool-map.v2.md`, …
> **Legend:** ✅ HAVE (real, usable) · 🟡 PARTIAL (exists but prose / incomplete / not wired) · ❌ GAP (must build).
> "Piece" = the granular unit that actually serves the stage (a forge role, an `/sdd-*`
> command, a gate/hook, a script), not the whole tool.

## FLOW A — Development

| Stage | Tool / piece that serves it | Status | Notes |
|---|---|---|---|
| 1.1 Problem framing & goal | SDD `/sdd-specify` (framing) + `/sdd-constitution` (principles) | ✅ | For large goals, add a think-tank decompose (hierarchical-orchestration Stage A). |
| 1.2 Elicitation | SDD `/sdd-clarify` (one-question-at-a-time) | ✅ | Best-designed human interaction we have; reuse as the universal question protocol. |
| 1.3 Analysis & spec (FR + NFR + acceptance) | SDD `/sdd-specify` **+ forge `specifier`** (EARS/Gherkin/observable invariants) | 🟡 | **Unify** these two — one spec phase, one engine. Today they're separate/duplicated. |
| 1.4 Requirements validation | `/sdd-analyze` (cross-artifact consistency) + `adversarial-critic` | ✅ | |
| 1.5 Planning, estimation, risk | SDD `/sdd-plan` + `/sdd-tasks` **+ `route.mjs` (risk/tier)** | 🟡 | plan/tasks ✅; **`route.mjs` = ❌ not built** (the risk classifier — keystone gap). |
| 2.1 Architecture / ADRs | forge `architect` role + SDD plan | 🟡 | Architect exists; ADR discipline is prose, not enforced. |
| 2.2 Detailed design / contracts | forge `specifier`/`architect` + frozen-contract pattern (hierarchical-orchestration) | ✅ | The frozen contract is the coordination substrate for epics. |
| 2.3 Threat modeling / security | `security-auditor` / `api-security-audit` agents (exist, **not wired as a stage**) | ❌ | SWEBOK v4 new KA; no security/threat-model step in the flow today. |
| 2.4 Test strategy | forge `coder` (test-first) + `qa-paradigms` (loop discipline) | 🟡 | Exists as principle; not a distinct planned artifact. |
| 3.1 Implementation | forge `coder` role | ✅ | |
| 3.2 Unit testing (TDD / genuine RED) | forge `coder` (genuine RED) + `evidence-gate` (should record RED) | 🟡 | Coder ✅; **RED-as-mechanism = ❌** (evidence-gate is broken: 112/112 unknown-schema). |
| 3.3 Code review + static analysis | `code-review` panel + forge `cleaner` + `crap.mjs` | ✅ | crap.mjs is real but has no fuel (coverage/complexity adapters unbuilt). |
| 3.4 Continuous integration | Local build/test + `pre-push-review` panel | 🟡 | By design: local-first, **no CI**. Gate lives at pre-push, not a CI server. |
| 4.1 Integration testing | hierarchical **integration gate** (epics only) | 🟡 | No general integration-test mechanism for single-unit work. |
| 4.2 System / E2E | E2E harnesses (`frontend-qa`, `call-websocket-qa`) + forge `qa` (UI-only) | 🟡 | Per-project harnesses ✅; no unified tool-level E2E; dashboard (relaymint) = ❌. |
| 4.3 Non-functional (perf/sec/a11y) | `accessibility-tester` / security agents (exist, **not wired**) | ❌ | Not part of the flow today. |
| 4.4 Acceptance / validation | forge `qa` + **breaker** (`pipeline-breaker`, independent oracle) + **referee** | 🟡 | qa/breaker exist as agents; **the re-executing referee = ❌ not built** (what makes "done" real). |
| 5.1 Release engineering | `git-workflow-manager` + commit/changelog conventions | 🟡 | Conventions exist; not a driven stage. |
| 5.2 Deployment (config-by-target) | — | ❌ | No deployment mechanism; **config-by-target = not built** (keystone gap). |
| 5.3 Post-deploy verification | breaker could probe live, **needs config-by-target** | ❌ | |
| 6.1 Operations | — | ❌ | SWEBOK v4 new KA; out of initial scope for the harness. |
| 6.2 Monitoring & observability | `evidence-ledger` (closest, **broken**) | ❌ | No real observability/metrics yet. |
| 6.3 Maintenance (4 types) | **= Flow B** (the issue-entry door) | ✅ | Covered by the issue flow below. |
| 6.4 Retrospective / learning | regression fixture (B.7) + post-mortem + memory (`claude-mem`) | 🟡 | Memory ✅; the fixture-as-mechanism = ❌. |

### ⟳ Cross-cutting
| Concern | Tool / piece | Status | Notes |
|---|---|---|---|
| Config & change management | git + `using-git-worktrees` + `task-execution-engine` | ✅ | Worktree isolation for parallel work; durable task state. |
| Quality assurance | the gates + `pre-push-review` | 🟡 | Panel ✅; the deterministic gates are broken/unbuilt. |
| Project & risk management | `route.mjs` (risk) + hierarchical-orchestration (project) | 🟡 | route.mjs = ❌; orchestration = ✅ for epics. |
| Documentation | SDD artifacts (spec/plan/tasks) + doc conventions | ✅ | |
| Measurement | — | ❌ | No metrics (cost/issue, false-green rate, gate-execution rate) — eval-expert gap. |

## FLOW B — Issue resolution

| Stage | Tool / piece | Status | Notes |
|---|---|---|---|
| B.1 Detection / report | failing test / issue report | 🟡 | No monitoring-driven detection. |
| B.2 Logging & triage | `issue-flow` / `sdd-from-issue` + `route.mjs` (severity/blast-radius) | 🟡 | issue-flow ✅; route.mjs = ❌. |
| B.3 Reproduction | breaker/qa could reproduce, **not a defined step** | ❌ | The engineering crux; no reproduction mechanism today. |
| B.4 RCA | debug agents + `adversarial-critic` | 🟡 | Ad-hoc; not a driven step. |
| B.5 Immediate mitigation | — | ❌ | SRE concern; out of initial scope. |
| B.6 Converge into Flow A | the dev spine above | ✅ | |
| B.7 Regression prevention (fixture) | discipline in memory rules, **not mechanized** | ❌ | The eval-expert canary-fixture gap (use our real past bugs). |
| B.8 Post-mortem | memory + blameless notes | 🟡 | |
| B.9 Closure | `issue-flow` (close) | ✅ | |

---

## Summary of coverage (what this map tells us)

- **Front-end (framing → tasks) is well covered by SDD** — ✅ the backbone's start is real.
- **The middle (design → construction → V&V) is covered by forge, but mostly as ROLES/PROSE** — 🟡 the agents exist; the *mechanisms that make their output trustworthy* do not.
- **The reliability gates and the tail (release/operate/measure) are the GAPS** — ❌:
  `route.mjs` (risk router), the **re-executing referee** (real "done"), **config-by-target**,
  **reproduction** + **regression-fixture** mechanisms, **measurement**, and the fix of the
  **broken evidence-gate**.
- Net: **SDD gives the spine; forge gives the engine; the GATES that make it reliable are
  what we must build.** This is the exact input for step 3 (gap analysis) and step 4 (sequencing).
