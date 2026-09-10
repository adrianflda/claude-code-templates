# HANDOFF — Agentic Software-Development Harness — v2 (read this first)

> Supersedes `HANDOFF.v1.md`. v1 was written by a session that overstated results; an independent
> panel later re-validated everything **by execution**. This v2 states the honest state. Cold-start:
> read this, then `validation-panel.v1.md` (what was broken) and `validation-panel.v2.md` (how it was
> rebuilt + the final guarantee/limits).

## 1. What we are building (unchanged, and validated as sound)

One definitive, **domain-agnostic** agentic software-development harness for the Claude Code CLI:
**SDD (method) + forge (engine) + gates (teeth), unified.** An independent architecture review (see
`validation-panel.v1.md`) judged the plan **sound — keep it**. The frozen design docs
(`lifecycle-backbone`, `stage-tool-map`, `gap-analysis`, `build-sequence`, `constitution`) stand;
amend only via new versions, never overwrite.

## 2. What actually happened this cycle

A 4-expert panel re-checked the plan and the v1 gate by execution. The **plan held**; the **v1 gate's
"non-fakeable" claim was false** (score 25/100, fooled 9 ways). The gate was then **rebuilt and
hardened across ~10 adversarial rounds** with an independent breaker re-attacking each version. Result:
the static file-tampering surface is closed; the gate is usable and honest. Full record:
`validation-panel.v2.md`.

## 3. The gate as it stands (the teeth) — `plugins/quality-kernel/`

- `scripts/route.mjs` — deterministic risk router: `git diff -z base..head` (committed refs, never the
  worktree), config from the base ref, renames/type-changes handled; a **test change → critical**
  (human review); `.quality-kernel/**` and deleted tests → critical; fail-safe critical.
- `scripts/referee.mjs` — commit-anchored re-executing referee. Full BASE tree + head **production
  overlay** (`productionGlobs`), two mandatory runs (base-harness × head-production, and head-as-is),
  optional **acceptance oracle**, and **Option B** (tests the PR modifies are overlaid so legitimate
  behavior changes verify green; breaking covered code without touching its test stays mechanically
  blocked). Every changed path gets an explicit disposition; anything unverifiable → indeterminate.
  Harness-integrity: symlink/oracle-component/ctime/path-set/case-collision/export-ignore guards.
- `scripts/qk-gate.mjs` — composed gate. Exit `0` pass · `1` fail · `2` indeterminate · `3`
  blocked-needs-breaker (critical surface or a test change → human/M2 review before merge).
- `hooks/pre-push.sample` — gates the pushed sha against a remote-anchored base.
- `commands/gate.md` — the `/gate` command. `config/{tools,critical-surface}.example.json` — per-repo config.
- `scripts/*.test.mjs` — **82 node tests** (every reproduced attack is a permanent regression) +
  `hooks/test_hooks.py` (17). `README.md`, `CHANGELOG.md` (v0.4.0), `.claude-plugin/plugin.json`.

Global install refreshed: `~/.claude/quality-kernel/` + `~/.local/bin/qk-gate` + `~/.claude/commands/gate.md`.

## 4. The honest guarantee (what a green means) — DO NOT overstate

**Breaking covered production code without editing its test is mechanically blocked; any test change
is forced to human review; the change is verified against the immutable base harness + optional
acceptance oracle, re-executed.** It does NOT mean "the code cannot be malicious."

**Declared limits (M2 live-breaker's job, reproduced not closed):** in-process oracle subversion
(monkeypatch `node:assert` / `process.exit(0)`), gate fingerprinting, execution-trust (build/verifySetup
running overlaid code), no-baseline-tests, opt-in `linkPaths` write-through. See `validation-panel.v2.md`.

## 5. Milestone status (honest)

- **M0 — done and hardened** (was falsely "done" in v1; the rebuild + 10 red-team rounds make it real).
  Its GREEN criterion (the gate blocks a forged/gamed pass, demonstrated by execution) holds for the
  static class; the residual is M2's domain and is declared.
- **M1 — done** (route.mjs deterministic; domain-agnostic fixtures; recall/precision + hold-out framing).
- **M2 — REORIENTED (plan-with-teeth + agentic QA P2·P4·P5) and its MECHANISMS BUILT + tested.** SDD chain
  frozen: `spec/plan/tasks-m2-plan-qa.v1.md`. Built + unit-tested (100 node tests total): `contract-lint.mjs`
  (invariant↔assertion lockstep), `breaker-invoke.mjs` (blind P5 boundary — Contract only, never the diff),
  `breaker-gate.mjs` (enforced breaker on the critical surface), `run-ledger.mjs` (cost). The Contract format
  + a runnable example live under `scripts/fixtures/m2/`. **Remaining: the dogfood run (T10 / INV-M2-6)** —
  one real issue end-to-end with the LIVE `pipeline-breaker` and a measured cost (prove-or-kill). It is the
  designed human checkpoint and spends real tokens / invokes live agents, so it is **greenlit by the human**;
  recommendation stands to dogfood on THIS repo (self-hosting).
- **M3–M6 — not started.**

## 6. Immediate next steps

1. **M2 breaker**: a black-box probe that exercises the built artifact in a prod-indistinguishable
   environment (different process, no gate fingerprint), derived from human-approved acceptance
   criteria — this is what closes the declared in-process/execution-trust class.
2. **Acceptance-criteria artifact** (already supported by `referee.mjs` `acceptance`): make authoring it
   part of the SDD spec → the independent oracle distinct from the coder's tests (Constitution P3).
3. Then M2's economic prove-or-kill: one real issue end-to-end, cost measured.

## 7. Working rules (persist)

- Reply to Adrián in **Spanish**; all repo content in **English**.
- **Verify by execution**, against real ground truth; panel-green ≠ correct; independence ≠ another LLM
  (the human and a live probe are the only strong oracles).
- **Never overwrite** a frozen doc — version it. **No remote** until explicitly asked (local git only).
- Keep the harness **domain-agnostic**; do not modify/delete forge, the orchestrator hierarchy, or the
  SDD commands — build alongside for comparison.
- Do **not** overstate a guarantee. State what is mechanically enforced vs. human-reviewed vs. declared-open.
