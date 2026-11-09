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
1. **Research** the shape of the solution (the built-in `Explore` / `Plan` agents for patterns;
   for a greenfield app, decide the module/subproject split: e.g. web (Next.js frontend), api (route
   handlers/server), db (schema/migrations), auth).
2. **Plan** via the SDD chain (`/sdd-init`, `/sdd-specify`, `/sdd-plan`, `/sdd-tasks`) — spec, stack,
   architecture, tasks. Keep it right-altitude (task + guardrails + done-criterion), not step-by-step.
3. **Contract** — write `.quality-kernel/contracts/<id>.md` per component: EARS acceptance criteria,
   Gherkin for the must-have flows, an **invariants table with EXACT expected values**, and an
   end-to-end QA procedure. Scaffold `.quality-kernel/tools.json` (`verify`, `productionGlobs`,
   `acceptance`, `testGlobs`), `.quality-kernel/critical-surface.json`, and add
   `.quality-kernel/*.jsonl` to `.gitignore`. Inside an org folder with an org guide, put the gate
   config in `<org>/.quality-kernel/repos/<repo>/` instead (never inside the product repo) and list
   the repos the system touches from the guide and `SYSTEM-MAP.md`.
4. **Design options** — run the `designer` agent at system level with the description, the
   Phase 0 answers and the plan; it writes `system.design.md` in the contracts folder: the plan
   and contracts checked against what was asked, and 2–3 options for the architecture, stack and
   subproject split (always including the simplest one that meets the description) with a
   recommendation. Then list every feature whose "how" that does not decide, and run the
   designer for each of them too, on its contract (`<id>.design.md` beside it). In the plan,
   write next to each feature the design file that decides it. All of this happens now, so the
   one approval below settles every design. If many features need their own file, group
   features that share one decision into one file rather than one file each.

## Phase 2 — APPROVAL GATE (stop here)
Present, concisely: the scope + non-goals, the designer's fit findings and options with its
recommendation, the stack, the subproject split, the Contract's must-have invariants (what "working"
will mean), and a rough cost/effort expectation. Show the per-feature design files with the
system one, all together. The human picks an option for each in this same gate; write each pick
under `## Chosen option` in its file. Before building, check that every feature's design file
exists and has a filled `## Chosen option`; a missing or empty one is not approved: go back to
the human, do not start. Then **STOP and ask the
human to approve, adjust, or reject** (use `ExitPlanMode` or a direct approve/adjust question). **Do
NOT write any implementation code before approval.** This is the one required checkpoint.

## Phase 3 — Build autonomously (after approval)
- Scaffold the project (e.g. `create-next-app`, Prisma/DB, auth) and commit a baseline.
- Decompose and build: drive `/forge` per feature yourself, one task at a time, with the run journal
  (below) as the run's state — across one repo or several repos of an org folder. Every
  feature is `design: settled` after approval: call forge with `--design-settled <its design
  file>` (the feature's own, or `system.design.md` when the system design decides it), so forge
  runs no designer and does not stop for a design choice. Forge stops only if a new design decision
  appears during the build that the approved plan could not have foreseen; this should be rare.
  When it happens, that feature pauses (journal it `blocked` with the reason) and the others carry
  on; it never waits silently. Tell the human which decision, why the
  plan did not settle it, and the options. Add the pick to that feature's design file under
  `## Chosen option`, with the date and the reason, journal a `decision` record pointing at it,
  then call forge again with `--design-settled` on that file. Tests are authored
  **anchored to the Contract** (exact values), following the qa-paradigms decision rule (P2 static +
  P4 contract-anchored + P5 independent validation); a broken selector/test must FAIL, never auto-heal.
- Bounded loops: cap retries per task; on cap, escalate (stop + report), never loop forever.

### Run journal — the run's state lives outside this conversation
A run lasts days and this context is compacted many times; progress is never kept only in memory.
Spec: `docs/agentic-harness/spec-run-journal.v1.md`. `J="${CLAUDE_PLUGIN_ROOT}/scripts/run-journal.mjs"`,
`<org>` = the org folder (the journal is refused inside a product repo).
- **Start**, right after approval: run id `openssl rand -hex 8` (16 lowercase hex); append
  `{"v":1,"type":"run_started","run_id":"<id>","plan_ref":"<approved plan file>","repos":[{"name":"<repo>","base_sha":"<40-hex>"}]}`
  with `node "$J" append --org <org> --run <id> --expect-seq 0 --record '<json>'`. Tell the human the
  run id and the org folder: they are what a resume needs.
- **Every task transition** is one append, in this order only: `pending` → `in_progress` →
  `committed` (with `head_sha`) → `gate_green` / `gate_red` (with `gate: {exit, at}` from the gate run on
  that `head_sha`); `gate_red` → `in_progress` to retry, at most 3 `gate_red`, then `blocked` with a
  `reason`. Each record carries `task_id`, `repo`, `branch`, `worktree` (repo and worktree by name).
  `--expect-seq` is the current record count (`fold` returns it as `seq`); exit 3 means another
  writer moved it — re-`fold`, never retry blindly. Exit 2 = the record is invalid: fix it, do not skip it.
- **Every commit of a task** carries the trailer `QK-Task: <task_id>` (`git commit --trailer
  "QK-Task: <task_id>"`): resume finds commits nobody journaled and commits made after a task went green
  by this trailer.
- **One short-lived subagent per task**: give it the task id, its contract and design file, the repo,
  branch and worktree — not this conversation. It builds, commits with the trailer and returns the
  `head_sha`; you run the gate and write the journal. Its context ends with the task, so a long run
  never depends on one ever-growing context.
- **Finish** in Phase 5: append `{"v":1,"type":"run_finished","verdict":"pass|fail|kill"}`.

### Resuming a run (after a crash, reboot, kill or a `claude --resume`)
Never continue from memory or from a summary. `node "$J" open --org <org>` lists unfinished runs;
then `node "$J" resume --org <org> --run <id>` (read-only: it checks the journal against git and
re-runs the gate once per repo at the latest green SHA):
- exit 0: skip everything in `done`, restart each task in `continue` from its journaled state, and
  report each `blocked` task (`reason`) to the human; the rest of the run continues.
- exit 1: the journal and git (or the gate) disagree — STOP and report every `divergences` entry
  (`sha_unreachable`, `commits_after_green`, `orphan_commits`, `gate_red_now`, ...) to the human.
  Do not repair the journal or the branches yourself.
- exit 2: resume could not decide (`error`) — STOP and report; never treat it as green.

## Phase 4 — Verify with the gate (the arbiter of "tested")
- For every change, run the gate: `node "${CLAUDE_PLUGIN_ROOT}/scripts/qk-gate.mjs" --repo <dir>
  --base <sha> --head <sha>` (or `/gate`). Green = referee re-executed clean. A test change routes to
  human review (exit 3) — surface it. Across several repos of an org folder, gate the feature as a
  whole: `node "${CLAUDE_PLUGIN_ROOT}/scripts/qk-org-gate.mjs" --org <org> --branch <branch>`. On the
  critical surface, run the blind breaker (`scripts/breaker-gate.mjs` with
  `--breaker "node <plugin>/scripts/breaker-claude.mjs"`, the isolated launcher) before calling it done.
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
