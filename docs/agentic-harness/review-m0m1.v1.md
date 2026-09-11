# Specialist Review of M0+M1 — findings, rework, verification — v1 (FROZEN)

> A 3-lens specialist panel (code-correctness, test/eval, adversarial-critic) reviewed the
> delivered M0 (referee) + M1 (route) + qk-gate, **by execution**, and broke the "non-gameable"
> guarantee in three ways in <15 min. This records their verdict, the rework, and the regression
> tests that now keep each attack defeated (Constitution P11: red-team the gate itself).
> **Versioning:** never overwrite → `review-m0m1.v2.md`.

## Panel verdict (before rework): REWORK REQUIRED (~45/100)
Design + honesty genuinely good; fail-closed correctly implemented in covered cases; the
"exit-code not in the Bash payload" finding is real. **But** the milestone-naming property
("non-gameable") was false in the 3 directions an incentivized agent tries first.

## Findings → fixes → regression tests (all now green)

| # | Sev | Finding (verified by the panel) | Fix | Regression test |
|---|---|---|---|---|
| 1 | BLOCK | `tools.json` is agent-writable → set `verify:"true"` (or `\|\|true`, narrow to a green file) → red suite PASSES | Referee reads `verify` from the **committed base ref** (`git show base:.quality-kernel/tools.json`), immutable to the change under test | `attacks.test.mjs` ATTACK 1 |
| 2 | BLOCK | Deleting the red test → classified **trivial** → green | route: a **deleted test is always critical**; `.quality-kernel/**` always critical | `attacks.test.mjs` ATTACK 2; `route.test.mjs` RED-TEAM |
| 3 | BLOCK | Default CLI (no `--base`) → empty `HEAD...HEAD` diff → **trivial** (fail-open) | route: **require `--base`** (else opError=fail-closed); diff **base-vs-worktree** (`--name-status`) | `attacks.test.mjs` ATTACK 3 |
| 4 | BLOCK | Nothing invokes the gate (agent-voluntary) | `hooks/pre-push.sample` — a git pre-push invoker that **blocks the push** on a non-zero gate | `pre-push.test.mjs` (blocks red / allows clean) |
| 5 | HIGH | qk-gate exit 0 on a critical change (breaker requirement was prose) | **Exit 3** = "green but M2 breaker unenforced → do-not-merge"; a critical change never returns 0 | `qk-gate.test.mjs` (critical→3, trivial→0) |
| 6 | HIGH | INV-R5 circular (surface fitted to the 2 bugs); poor precision | Globs **code-scoped** (`*monitoring*.ts` not `.md`); added a **precision** test; documented the **hold-out** validation discipline | `route.test.mjs` PRECISION |
| 8 | HIGH | INV5b broken generally (metachar inside a quoted body → false event) | evidence-gate: **quote-aware** strip before segment split | `test_hooks.py` quoted-metachar test |
| 10/11 | MED | referee mislabels a real 127/126 fail as indeterminate; no timeout | 127/126 = indeterminate **only if no stdout**; `spawnSync timeout: 300000` | covered by INV suites |

## Residual (honest, carried forward)
- **Recall on the NEXT unknown bug is fundamentally untestable** — the critical surface must be
  authored per repo from real incidents (P10). INV-R5 proves *curatability*, not foresight; the
  hold-out method is the discipline going forward.
- **Deeper agentic invocation** (a Claude Code Stop hook / forge integration) beyond the git
  pre-push hook is M2/M4.
- **The ledger still has no consumer** — real records now, but M3 wires the metrics reader.
- FR2 diff-scoping (referee runs the full suite, which is *stronger* vs gaming) — a deliberate
  M0 simplification; M3 may add scoping with coverage data.

## Status after rework (verified by execution)
`node --test` **34/34** · `python3 test_hooks.py` **17/17**. The 3 blocking attacks are permanent
regression tests. Panel's estimate for post-rework: ~75–85; M2 can start on firm ground.
