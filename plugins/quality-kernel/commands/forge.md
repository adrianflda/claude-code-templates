---
description: Entry point of the quality-kernel — run the quality-kernel agent pipeline scaled to the task (from a one-line issue to a large feature), with automatic tier routing and a blast-radius override.
argument-hint: <task description | issue #> [--tier T0|T1|T2] [--design-settled <path to design.md>]
---

Run the quality-kernel pipeline for the task described in `$ARGUMENTS`.

You are the **orchestrator / PM-router**: you route the work, dispatch the agents,
enforce the gates, and relay results. You do **not** do the feature work yourself.

## Step 0 — Tier routing (automatic, with blast-radius override)

Classify the task into a tier from cheap signals: estimated change size, number of
files / subprojects, and whether it is new behavior vs. a fix.

- **T0 — issue / small fix:** a single agent, or the two-pack `coder → cleaner`.
- **T1 — medium feature:** `specifier → designer → coder → cleaner → architect`.
- **T2 — large / multi-subproject:** the full chain
  `specifier → designer → coder → cleaner → architect → hardener → qa` under hierarchical
  orchestration.

The designer runs for T1 and T2 only. Skip it when `--design-settled <path>` is passed (the
caller, e.g. `/develop`, already had the human approve the design for this feature); the
`design.md` at that path, with its `## Chosen option` filled in, is then the reference for the
coder and architect, and forge does not stop for a design choice. A path that is missing or has
no chosen option means not settled: run the designer. The one exception: if a new design decision
appears during the build that the settled design could not have foreseen (rare), stop and report
it to the caller with the reason and the options; do not pick one yourself.

Rules:
- The human MAY propose a tier (e.g. `--tier T1`). The system may **raise** the tier but
  **never lower** it below what blast-radius requires.
- **Blast-radius override:** if the change touches the project's *critical surface* —
  authentication / tenant isolation, money / billing, external state (DB writes, queues,
  outbound calls / email / SMS, third-party effects), live voice / telephony, migrations,
  infra / IaC, or **the contract itself** — force **T1 or higher** regardless of size.
  A one-line change in `auth` is never T0. (Critical-surface globs are per-project config;
  if none is set, treat any change outside docs / tests / styling / tooling as critical.)

State the chosen tier and the reason in one line before proceeding.

**System view (only inside an org folder with an org guide** — the `org-workspace` block of the
org-root `CLAUDE.md`, data in `<org>/.claude/org-workspace/guide.json`): name the repos the task
touches and read only their sections of `<org>/SYSTEM-MAP.md`. A change to something another repo
consumes (an endpoint, a payload field, a shared bucket) is cross-repo blast radius: raise the tier
to at least T1 and pass the consumers, with their citations, to the specifier. Use one branch name in
every touched repo, and close with `qk-org-gate --org <org> --branch <branch>`.

## Step 1 — Run the chain for the tier

Dispatch each role as a subagent (`specifier`, `designer`, `coder`, `cleaner`, `architect`,
`hardener`, `qa`), in order, skipping the ones the tier does not include. Inject the
domain expertise the task needs (backend / frontend / security / db) into each role's
context — **the roles are fixed, the expertise is injected**.

Communication model:
- **Handoff of artifacts + context, not chat:** each agent passes the artifact + its
  trace + the deterministic-tool evidence to the next, by reference (files in the
  worktree). Each agent runs its **self-audit** before handing off ("passing checks
  alone do not establish completeness").
- **PM-router:** give each agent an explicit goal, output format, allowed tools and
  task boundaries; receive a structured report back. Agents do not chat freely.
- Where a judgment is needed (review, or choosing between implementations in a risk
  zone), **vote** across independent outputs weighted by evidence — do not debate.

## Gates (enforce; do not skip)

1. **Blind contract review, design, then the intention gate (human)** — after the specifier
   produces the contract (EARS + Gherkin + External Observable Invariants), run
   `node <plugin>/scripts/contract-review.mjs --contract <spec.md> --out <spec>.review.md`
   (T1+). Two isolated, tool-less reviewers that see only the contract text report
   gaps as `blocker` / `major` / `nit`. Send each blocker back to the specifier. Then
   (T1+, unless `--design-settled`) dispatch the **designer** with the ticket text and the
   contract; it writes `design.md` in the same folder as the contract: where the contract
   does not fit the ticket, 2–3 options including the simplest one that meets the ticket,
   and a recommendation. If the designer reports it could not read the ticket, or
   `design.md` is missing, that is not "no findings": re-run it or ask the human. Then
   pause, once, for the human with the contract, the review report and `design.md`
   together: the human approves (or edits) the contract against the fit findings **and
   picks the option** (with `--design-settled`, only the contract and review, the settled
   design beside them), before any code is written. If the contract changed, re-run the
   blind review on the new text. Write the pick into `design.md` under
   `## Chosen option`; pass that file to the coder as a constraint and to the architect as
   the reference design. A blocker left in the contract must be waived
   by the human explicitly, never by an agent. Exit 2 (a reviewer could not run or
   answered off-format) means not reviewed: re-run, do not proceed as if it passed.
   *(Optional, per-project:)* if GitHub Project integration is enabled, create one issue
   per task on the dashboard here.
2. **Genuine RED** — the coder's tests must fail for the right reason, anchored to the
   contract.
3. **Mutation (async)** — for T1+, run mutation in CI / async on core modules
   (hardener). Do not block the implementation loop on it.
4. **Blind breaker (live oracle)** — for any change touching the critical surface, run
   the breaker on ONLY the contract + the probe (the QA script), launched isolated:
   `scripts/breaker-invoke.mjs ... --breaker "node <plugin>/scripts/breaker-claude.mjs"`. Do not
   spawn it as an in-session subagent — that inherits this session's CLAUDE.md, memory and hooks.
   Require `BREAKER_PASS` (>=3 executed falsifying vectors, all HOLDS) before merge; no probe =
   `INSTRUMENT-BROKEN` = default-deny.
5. **Evidence-gate** — nothing is "done" without a verification event (exit 0) after the
   last edit.
6. **Pre-push panel** — the `pre-push-review` plugin blocks the push on critical findings.

## Loop discipline

Every repair loop is bounded (cap 3) and **escalates to the human on cap** — never retry
blindly, never weaken a test to pass. When two fixes resting on the same premise fail the
same gate, require the agent to **attack the premise** (state it in one sentence, remove
the wrong assignment) before any further fix. Cap the number of agents and messages; no
free lateral chat between agents.

## Practice

- **Action log.** Keep a log of every dispatch, gate run and decision, each with the
  reason it was taken; it goes in the final report.
- **Guard the context window.** Keep this thread small: agents return a structured
  summary and reference their bulk output by file path; do not paste it here.
- **Sequence into verifiable units.** Finish and verify one task before starting the
  next; a planned intermediate break is allowed only if it can be undone.
- **Commit small, ordered commits.** Each commit message states why, what changed, and
  how it was proved — the `Proof:` trailers from `scripts/proof.mjs`, never hand-written.
- **Worktree cleanup.** At the end, list the worktrees and branches this run created.
  Remove only those that are merged and clean, after confirming nothing still uses
  them; any with uncommitted or unmerged work waits for the human's decision.

## Output

Report: the **residual risk, stated first**, then the chosen tier and why, the agents
run, the designer's fit findings and how each was resolved, the option the human chose
(or "design settled upstream"), each gate's result, the mutation / coverage / CRAP / DRY figures where run, the
`Proof:` trailers, and the action log.
