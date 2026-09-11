# HANDOFF — Agentic Software-Development Harness (read this first)

> **Purpose of this file:** a cold-start briefing so a fresh session can resume the
> work with zero prior context. It states WHAT we are building, WHERE every file is,
> WHAT is done vs. pending, and the RULES that govern the work. Nothing here depends
> on any application repo.

---

## 1. What we are building (the goal)

**One definitive, domain-agnostic agentic software-development harness** for the
Claude Code CLI. Given any input — a whole system to build, a feature to add, or an
issue to diagnose and fix — it runs all professional software-engineering phases and
earns **trust by MECHANISM at each step** (not by an LLM's self-report), with minimal
low-value human interaction.

The north-star definition (frozen in `build-sequence.v1.md`, milestone M4):

> **the harness = SDD (method) + forge (engine) + gates (teeth), unified.**

- **SDD** = the method: constitution → spec → plan → tasks → implement (human-gated).
- **forge** = the engine: the multi-agent chain that does the work.
- **gates** = the teeth: deterministic mechanisms that make "done" mean something.

## 2. How the three existing tools relate (this caused past confusion — read carefully)

We already had three overlapping things. The plan does **NOT** pick one as-is; it
**unifies** them and keeps the others reversible for comparison:

| Tool | What it is | Role in the plan |
|---|---|---|
| **forge** (`/forge`, 6-agent chain: specifier→coder→cleaner→architect→hardener→qa) | a linear engine | becomes the **engine/spine** inside SDD |
| **project-orchestrator / subproject-pm / swarm-worker** (hierarchical looped build) | a 3-tier orchestrator | its unique parts (decompose / freeze-contract / integrate) fold in **behind a flag** at M6 (gap **G17**: *demote, reversible, DO NOT delete*) |
| **the gate** (route + referee, built now) | deterministic verification | the **teeth** — the mechanism the orchestrator only described in prose |

**Hard constraint from the user:** do **NOT** modify or delete the existing tools
(forge, the orchestrator hierarchy, the SDD commands). Build the new spine alongside
them so their progress can be **compared**. Consolidation (G17) is the LAST step and
is reversible.

## 3. The plan (frozen — never overwrite; new versions are v2, v3, …)

All under `docs/agentic-harness/`:

1. `lifecycle-backbone.v1.md` — the real software-engineering stages (the backbone).
2. `stage-tool-map.v1.md` — each stage mapped to the tool that serves it (have / gap).
3. `gap-analysis.v1.md` — the 18 gaps (G1–G18), classified, in priority tiers P0–P6.
4. `build-sequence.v1.md` — the gaps turned into milestones **M0–M6**, each with a
   GREEN criterion (verifiable by execution) and a tripwire.
5. `constitution.v1.md` — the 11 principles (teeth-not-prose; verify-by-execution;
   independence≠another-LLM; rigor∝blast-radius; fail-closed-on-critical;
   right-altitude/no-hobbling; config-by-target; zero-low-value-human-interaction;
   one-spine-two-doors; ground-truth-over-synthetic; bounded-reversible-proven-before-scaled).
6. `spec-m0-referee.v1.md` + `.v2.md`, `plan-m0-referee.v1.md`, `tasks-m0-referee.v1.md`
   — the SDD chain for M0.
7. `spec-m1-route.v1.md`, `plan-m1-route.v1.md`, `tasks-m1-route.v1.md` — SDD chain for M1.
8. `process-diagram.v1.md` — mermaid diagram of the whole process.
9. `usage.v1.md` — how to drive it.
10. `review-m0m1.v1.md` + `.v2.md` — specialist/red-team reviews of M0+M1.

### Milestone map (from `build-sequence.v1.md`)

| Milestone | Theme | Proves |
|---|---|---|
| M0 | "green" is real | the gate can't be faked |
| M1 | rigor is deterministic | risk routing works on real past bugs |
| M2 | spine works on 1 real issue | **the vision, cheaply (or kills it)** |
| M3 | depth + metrics | regressions caught; cost known |
| M4 | SDD-native | method + engine + teeth, unified |
| M5 | scale + coverage | epics, backend+UI, multi-target |
| M6 | consolidation + UX | legible, reversible, right-altitude |

M0–M2 is the critical path and the cheapest honest test of the whole idea.

## 4. What is BUILT so far, and where

The teeth (M0 + M1 + a slice of M3), all green by execution
(35 node tests + 17 python hook tests):

Plugin dir: `plugins/quality-kernel/`
- `scripts/referee.mjs` — **M0 + M3-core.** Re-executes the repo's `verify` command in
  its own subprocess and reads the real exit status (never trusts a "done" claim);
  fail-closed. Reads the verify command from the **committed base ref**, and re-runs
  the **base test-harness against the head code** (trusted-harness) so a change cannot
  pass by weakening/neutering/deleting its own tests. Exit 0/1/2.
- `scripts/route.mjs` — **M1.** Pure `classify(changed, config, proposed, deleted)`:
  blast-radius/tier from `critical-surface.json` globs. Deleted test → critical;
  `.quality-kernel/**` → critical; no config → critical (fail-safe); requires `--base`
  (else fail-closed). `globToRegExp` supports only `**`, `*`, `?` (NO `[...]` classes).
- `scripts/qk-gate.mjs` — composed gate (route + referee). Exit 0 pass · 1 fail ·
  2 indeterminate · 3 green-but-critical-needs-breaker.
- `scripts/*.test.mjs` — referee / route / qk-gate / attacks (red-team) / pre-push tests.
- `scripts/crap.mjs` — pre-existing CRAP complexity tool (not part of the gate).
- `commands/gate.md` — the `/gate` slash command. `commands/forge.md` — pre-existing.
- `hooks/evidence-gate.py` — records honest verification signals (no fabricated exit
  code; Claude Code's Bash tool_response has NO exit-code field — verified).
- `hooks/pre-push.sample` — git pre-push invoker that blocks a push on a non-zero gate.
- `hooks/epistemic-guard.py`, `hooks/hooks.json`, `hooks/test_hooks.py` — pre-existing hooks.
- `config/critical-surface.example.json`, `config/tools.example.json` — per-repo config templates.
- `.claude-plugin/plugin.json` (v0.3.0), `README.md`, `CHANGELOG.md`.

### Global install (usable in any session RIGHT NOW)
- `~/.claude/quality-kernel/` — copy of scripts/hooks/config + a `qk-gate` launcher.
- `~/.local/bin/qk-gate` → symlink to that launcher (on PATH). CLI works today.
- `~/.claude/commands/gate.md` — global `/gate` command (points at the installed CLI;
  no plugin needed). Available as a slash command in a NEW session.

### Git state
- Branch `feat/agentic-harness-m0` in `claude-code-templates`, **9 commits, NOT pushed**
  (user rule: no remote until explicitly asked; a push attempt hangs on the SSH key
  passphrase — the user must run `git push -u origin feat/agentic-harness-m0` themselves).

## 5. Milestone status (honest)

- **M0 — DONE, green by execution.** Referee re-executes, fails closed, red-team
  attacks (forged pass, weaken tools.json, delete/neuter a test, invoke without base)
  are permanent regression tests.
- **M1 — BUILT + unit/red-team tested, but the closing TRIPWIRE is NOT yet run.**
  `build-sequence.v1.md` M1 requires a **replay**: run `route.mjs` over **real
  past-bug diffs** and confirm it forces **critical** on both. That validation has not
  been executed/recorded yet. **Open decision:** use real past bugs from an existing
  work repo as ground-truth (constitution: *ground-truth-over-synthetic*), OR use
  synthetic diffs that imitate the same risk classes (security, clinical/critical
  logic) to keep the harness fully decoupled from any application repo. The user was
  uncomfortable seeing an application repo pulled in; get an explicit choice first.
- **M3 — only a slice done** (trusted-base-harness in the referee). Regression fixtures
  and measurement/cost-circuit-breaker are pending.
- **M2, M4, M5, M6 — NOT started.** M2 (dogfood the spine on ONE real issue, measure
  cost) is the prove-or-kill milestone and requires M0+M1 wired into the forge pipeline
  end-to-end. M4 is where it becomes "the one tool that does everything."

## 6. The immediate next step

**Close M1**: run the replay validation of `route.mjs` and record the result — per the
open decision in §5 (real-ground-truth vs synthetic). If the router does NOT force
critical on the chosen cases, the globs/approach are wrong → fix before proceeding
(that is the tripwire). Then reassess M2.

A visual "ideal tool" diagram was requested and not yet delivered — build it from §1–§3.

## 7. Working rules (persist across sessions)

- Reply to the user (Adrián) in **Spanish**; all **repo content in English**.
- **Do not modify/delete** forge, the orchestrator hierarchy, or SDD commands — build
  alongside for comparison (§2).
- **No remote until explicitly asked** — local git only; never push without an OK.
- **Verify by execution**, against real ground truth — panel-green ≠ correct.
- **Never overwrite** a frozen plan doc — version it (v2, v3, …).
- Keep the harness **domain-agnostic** — no application-specific (e.g. medical) framing
  baked into the tool itself.
- Do **not** push the user to *execute* (spend tokens/touch live systems) before the
  analysis/decision they asked for is done. Analysis and comparison come first.
