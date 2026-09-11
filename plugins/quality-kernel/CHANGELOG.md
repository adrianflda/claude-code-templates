# Changelog

All notable changes to the **quality-kernel** plugin are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-09-09

### Changed — the gate was reworked after an independent red-team panel broke v1
An independent 4-expert panel re-validated the plan and the built gate **by execution** and refuted
the v0.3.0 claim that "a change cannot pass by weakening, neutering, or deleting its own tests." The
v1 trusted-harness only restored a whitelist of `**/*.sh` among verify runners and read state from the
worktree, so a change could still go green on broken code (non-`.sh` runner swap, helper/golden
neuter, symlink, non-ASCII path, worktree/HEAD divergence, forged base). Full record and every
reproduced attack: `docs/agentic-harness/validation-panel.v1.md` (+ `.v2.md`). The referee and router
were rebuilt:
- **Commit-anchored, base-authoritative.** The gate verifies a committed `base..head` (never the
  worktree). The verify contract (`tools.json`) and the critical surface are read from the **base ref**;
  an absent/invalid contract or an unverifiable ref is **indeterminate**, never a worktree fallback.
- **Inverted trusted tree + a mandatory second run.** Run 1 = the full BASE tree with only the head's
  `productionGlobs` overlaid (an immutable harness denylist — tests, runners, manifests, configs —
  always stays at base). Run 2 = the full head as-is. Both must be green. This closes the whole
  file-tampering class and also executes code outside `productionGlobs` and the head's own new tests.
- **Acceptance oracle (Constitution P3).** Optional `acceptance` command, distinct from the coder's
  tests, run against the immutable tree — an independent, human-approved check.
- **Fail-closed hardening.** Committed symlinks, degenerate `productionGlobs`/`outputGlobs`, tests
  stripped by `.gitattributes export-ignore`, harness mutation (ctime + path-set + created-symlink
  detection), case/normalization-colliding paths, and any changed path that is neither production nor
  a declared test nor a benign manifest change are all **indeterminate**. `linkPaths` is opt-in
  (default `[]`); prefer `verifySetup` (e.g. `npm ci --ignore-scripts`) from the base lockfile. The
  pre-push hook gates the exact pushed sha against a **remote-anchored** base (`git ls-remote`).
- **No path-name allow-list.** Every changed/removed path gets an explicit disposition —
  production (overlaid+verified), declared test (`testGlobs`), manifest (production-field-checked),
  else indeterminate. Docs/prompts/assets/config are declared in `productionGlobs` so anything read
  at runtime is verified (overlaying prose is harmless). "Overlay" and "allowed-unverified" use
  separate sets so a nested test under `productionGlobs` is never overlaid.
- **Option B — test evolution with human review.** The tests a PR modifies are taken from head (so a
  legitimate behavior change verifies green), and any test change is routed **critical → exit 3
  (human review)**. This replaces the earlier "immutable base tests" model, which — as the panel's
  usability probe showed — rejected every legitimate behavior change and would have been disabled in
  practice. The honest guarantee is now: **breaking covered code without touching its test is
  mechanically blocked; a test change is forced to human review** (the human owns the contract);
  neutering is visible-and-gated, not mechanically impossible.

### Known limit (declared, not fixed — this is the M2 breaker's job)
The referee is an in-process test oracle, so production code can still self-declare green by
subverting the oracle in-process (monkeypatching `node:assert`, `process.exit(0)`, or fingerprinting
the gate environment), and a baseline with no real tests cannot be rescued. These are **not** covered
by M0+M1 and are not claimed to be; only the M2 live breaker (a black-box probe in a
prod-indistinguishable environment) closes them.

## [0.3.0] - 2026-09-08

### Added
- **The deterministic quality gate** — the reusable core, red-team-hardened:
  - `scripts/referee.mjs` — re-executes the project's `verify` command in its own subprocess and
    reads the real exit status (never trusts a "done" claim); fail-closed. Loads the verify command
    from the **committed base ref**, and re-runs the **base test-harness against the head code**
    (trusted-harness), so a change cannot pass by weakening/neutering/deleting its own tests.
  - `scripts/route.mjs` — deterministic blast-radius/tier classifier from `critical-surface.json`
    globs. Deleted tests and `.quality-kernel/**` changes are always critical; requires `--base`
    (else fail-closed); fail-safe: no config => critical.
  - `scripts/qk-gate.mjs` — composed gate (route + referee); exit `0`/`1`/`2`/`3`.
  - `commands/gate.md` — the **`/gate`** slash command.
  - `hooks/pre-push.sample` — a git pre-push invoker that blocks a push on a non-zero gate.
- A specialist panel red-teamed the gate and broke it; every attack (lie about the result, weaken
  `tools.json`, delete or neuter a test, invoke without a base) is now a permanent regression test
  (`scripts/{referee,route,qk-gate,attacks,pre-push}.test.mjs`). Design + review chain frozen under
  `docs/agentic-harness/`.

### Changed
- **evidence-gate**: stop fabricating exit codes — Claude Code's Bash `tool_response` has no exit
  code (verified); the referee is now the authoritative exit-code source in the ledger. Verify
  detection is anchored at the command start and quote-aware, so prose in a quoted body (e.g. a PR
  comment) is no longer a false verification event.

## [0.2.0] - 2026-09-03

### Fixed
- **evidence-gate**: recognize Node's built-in test runner `node --test` (with any
  trailing flags, e.g. `--experimental-test-coverage`) in `VERIFY_RE`. Previously,
  runs of the native runner — used by zero-dependency JS projects — were silently
  ignored, leaving no entry in `.quality-kernel/evidence-ledger.jsonl` for an
  otherwise-real verification. Surfaced while exercising the six-agent `/forge`
  pipeline end-to-end on a plain `node --test` repo. ([#21])

### Added
- **evidence-gate**: regression test (`test_node_test_runner_is_recorded`) that
  guards the `node --test` rule in isolation — it uses a bare `node --test` command
  (no `coverage`/`nyc`/other already-matched token), so it fails if the rule is
  removed. Hook test suite: 15 tests.

## [0.1.0] - 2026-09-02

### Added
- Initial release. ([#20])
- Six-agent SwarmForge-style engine: `specifier → coder → cleaner → architect →
  hardener → qa`, each with a self-audit before handoff.
- `/forge` orchestrator with automatic tier routing (T0/T1/T2) and a blast-radius
  override that forces T1+ on the critical surface.
- Two hooks (ship in log-mode by design):
  - `epistemic-guard.py` (PreToolUse / `Task|Agent`) — requires the
    `[EPISTEMIC-DISCIPLINE v1]` marker on every agent spawn; `log` (default) or
    `block` via `QK_EPISTEMIC_MODE`.
  - `evidence-gate.py` (PostToolUse / Bash) — records test/build/verify exit codes
    to a per-project ledger.
- Deterministic tools: `crap.mjs` (CRAP = c²·(1−cov)³ + c, threshold 6) with tests.
- Per-project config examples: `tools.example.json`, `critical-surface.example.json`.

[0.2.0]: https://github.com/adrianflda/claude-code-templates/releases/tag/quality-kernel-v0.2.0
[0.1.0]: https://github.com/adrianflda/claude-code-templates/releases/tag/quality-kernel-v0.1.0
[#21]: https://github.com/adrianflda/claude-code-templates/pull/21
[#20]: https://github.com/adrianflda/claude-code-templates/pull/20
