---
description: Build a whole system from one description — clarify briefly, plan, get ONE human approval, then run autonomously (decompose → build → verify with the gate → deliver a tested, working local app).
argument-hint: "<a full description of the system to build>"
---

`/develop` is the single entry point that ties the harness together: SDD (method) + forge (engine) +
the quality-kernel gate (teeth). It takes a system description in `$ARGUMENTS`, asks only a few
up-front questions, produces a plan + a machine-checkable Contract, **stops once for human approval**,
then builds and verifies autonomously and hands back a working, tested local project.

The rule that makes "tested and functional" mean something: **nothing is reported done unless the gate
re-executed the tests and read a real green** (constitution P2). Never fabricate a green; if a stage
cannot reach green within its bounded attempts, STOP and report honestly with the failing evidence.

## Phase 0 — Clarify (the ONLY questions; ≤5)
Ask up to five high-value questions with `AskUserQuestion`, then proceed without further interruption.
Cover: (1) auth/users, (2) data & persistence, (3) the 2–4 must-have capabilities (scope) + explicit
non-goals, (4) stack specifics/versions if the description leaves them open, (5) "done" bar (local dev
only? seed data? which flows must demonstrably work end-to-end?). Keep it to what materially changes
the build. If the description already answers a question, don't ask it.

## Phase 1 — Research → Plan → Contract (no building yet)
1. **Research** the shape of the solution (reuse `code-architect` / `code-explorer` for patterns;
   for a greenfield app, decide the module/subproject split: e.g. web (Next.js frontend), api (route
   handlers/server), db (schema/migrations), auth).
2. **Plan** via the SDD chain (`/sdd-init`, `/sdd-specify`, `/sdd-plan`, `/sdd-tasks`) — spec, stack,
   architecture, tasks. Keep it right-altitude (task + guardrails + done-criterion), not step-by-step.
3. **Contract** — write `.quality-kernel/contracts/<id>.md` per component: EARS acceptance criteria,
   Gherkin for the must-have flows, an **invariants table with EXACT expected values**, and an
   end-to-end QA procedure. Scaffold `.quality-kernel/tools.json` (`verify`, `productionGlobs`,
   `acceptance`, `testGlobs`), `.quality-kernel/critical-surface.json`, and add
   `.quality-kernel/*.jsonl` to `.gitignore`.

## Phase 2 — APPROVAL GATE (stop here)
Present, concisely: the scope + non-goals, the stack, the subproject split, the Contract's must-have
invariants (what "working" will mean), and a rough cost/effort expectation. Then **STOP and ask the
human to approve, adjust, or reject** (use `ExitPlanMode` or a direct approve/adjust question). **Do
NOT write any implementation code before approval.** This is the one required checkpoint.

## Phase 3 — Build autonomously (after approval)
- Scaffold the project (e.g. `create-next-app`, Prisma/DB, auth) and commit a baseline.
- Decompose and build: for multi-subproject work use `/orchestrate-project` (one PM per subproject,
  each running SDD → TDD build → review loop), else drive `/forge` per feature. Tests are authored
  **anchored to the Contract** (exact values), following the qa-paradigms decision rule (P2 static +
  P4 contract-anchored + P5 independent validation); a broken selector/test must FAIL, never auto-heal.
- Bounded loops: cap retries per task; on cap, escalate (stop + report), never loop forever.

## Phase 4 — Verify with the gate (the arbiter of "tested")
- For every change, run the gate: `node "${CLAUDE_PLUGIN_ROOT}/scripts/qk-gate.mjs" --repo <dir>
  --base <sha> --head <sha>` (or `/gate`). Green = referee re-executed clean. A test change routes to
  human review (exit 3) — surface it. On the critical surface, run the blind breaker
  (`scripts/breaker-gate.mjs` → the host `pipeline-breaker`) before calling it done.
- Run the acceptance suite (the Contract) via the referee's `acceptance`.
- **Prove it runs**: build the app and start it locally; exercise the must-have flows from the
  Contract's QA procedure (a smoke run), and confirm they work. Record cost with
  `scripts/run-ledger.mjs`.

## Phase 5 — Deliver
Hand back: how to run it locally (commands), the real test/gate results (green/what's pending — never
claimed, always the actual exit codes), the mapping of Contract invariants → passing tests, and the
cost/interventions from the ledger. If anything is not green, say so plainly with the failing evidence
— an honest "these 2 flows pass, this one is blocked because X" beats a fake "all done".

## Guardrails (constitution)
- Verify by execution; the gate is the arbiter, not any agent's word. Panel-green ≠ done.
- Right altitude / no hobbling; independence ≠ another LLM (the breaker/validator is blind).
- Reversible-first; stop-and-ask before anything irreversible or outward (deploys, external services,
  secrets) — local build/test needs no extra approval. Bounded loops, escalate on cap.
