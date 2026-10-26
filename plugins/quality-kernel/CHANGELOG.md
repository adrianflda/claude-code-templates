# Changelog

All notable changes to the **quality-kernel** plugin are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.0] - 2026-10-26

### Changed
- **The blind breaker no longer has a shell.** `scripts/breaker-claude.mjs` now runs in two stages:
  a tool-less, context-free `claude -p --tools ""` session writes falsifying vectors (bundled prompt
  `breaker/vector-author.md`, which replaces the bundled `breaker/pipeline-breaker.md`), and the new
  `scripts/vector-breaker.mjs` executes them through deterministic instruments and computes the
  verdict in code; the model's prose verdict is ignored. Closes the residual of the previous launcher,
  whose Bash could read the disk and the environment. Live-checked: asked to `cat` a file, the author
  has no tool to do it.

### Added
- `scripts/contract-review.mjs` + `reviewers/comprehension.md`, `reviewers/critic.md`: blind review
  of a specifier contract before the intention gate (Elephant-Goldfish Model's zero-context
  reviewers). Each reviewer is a separate isolated, tool-less session that sees only the contract;
  replies must be strict JSON findings (`blocker`/`major`/`nit`), and an off-format reply is
  indeterminate (exit 2), never "no findings". `/forge` runs it before the intention gate (T1+).
  Live-checked on sonnet: on a contract with four planted flaws (a vague criterion, an invariant
  without a probe, no payment-failure `IF … THEN`, no re-run invariant for a charge) all four came
  back as blockers; on `docs/specs/gate-process-tree/contract.md` its single blocker was a real
  contradiction, fixed below.
- `scripts/http-probe.mjs`: declarative HTTP instrument for breaker vectors — allowlisted methods,
  paths resolved and required to stay on the system's origin (`//host` and `/\host` are refused),
  redirects never followed, per-request timeout, `expect` on the last response (`status`, RFC 6901
  JSON-pointer `equals`). Non-local systems are refused.
- `scripts/vector-breaker.mjs`: validates a vector set (anchored to contract invariants, no unknown
  keys, at most 30; UI steps limited to same-origin `goto` and `click`, asserts to `text`/`is`/`attrs`),
  runs HTTP vectors through `http-probe.mjs` and UI vectors through the gstack probe, then the
  contract's `probeCmd` (exit 0 holds, 126/127/timeout/signal is instrument-broken), and applies
  `decideVerdict`.
- `scripts/dry-gate.mjs`: pass/fail gate over a jscpd JSON report — differential (`--files`) or
  whole-report, optional `--max-percent`; an unrecognized report is exit 2, never a pass. The
  cleaner, hardener and qa now gate duplication with it.
- `scripts/proof.mjs`: turns the evidence-ledger events since a ref (default `HEAD`) into
  `Proof:` / `Unverified:` / `Unproven:` commit trailers; exit 1 when nothing was proved or any
  command's latest run failed or has no exit code. Only an allowlisted command (plain words, quoted
  strings, simple redirects, `&&` chains) can be `Proof`; any other exit 0 — behind `|`, `;`, `||`
  or `&`, with `$`, backticks, subshells or heredocs, or truncated by the hook — is `Unverified`.
  Commands print escaped on one line so ledger text cannot forge a trailer, and a test pins
  `LEDGER_COMMAND_MAX` to the hook's `_MAX_COMMAND`. qa and `/forge` put its trailers in every commit.
- Principles adopted from Uncle Bob's `ub-mode` (2026-10-25), each placed in the stage that owns it:
  coder — *attack the premise* after two failed fixes on one premise, plus design rules (smallest
  edit, data shape first, redesign instead of bolt-on, parse at the boundary, never silence the
  compiler, fix the cause); architect — a domain-model phase (illegal states unrepresentable,
  boundary discipline, idempotency, single writer for shared state, glossary); cleaner —
  *subtract before you add* and pin → change → prove; hardener — idempotency tests and delete
  unreachable survivors instead of testing them; specifier — re-run invariants and a glossary;
  `/forge` — a Practice section (action log, context-window guard, verifiable units, small
  commits with proof, worktree cleanup).
- `.githooks/pre-push` (source repository): local pre-push gate. When a push touches
  `plugins/quality-kernel/` or `.githooks/`, it runs the Node and hook suites and the gate's own tests
  (`.githooks/quality-kernel-tests.test.mjs`) on the pushed commit in a temporary
  worktree and blocks the push on any failure; there is deliberately no CI job for these suites.
  Enable once per clone with `git config core.hooksPath .githooks`. The suites run without
  `NODE_TEST_CONTEXT`: inherited from a parent `node --test`, it makes the child runner exit 0 on
  failing tests.
- `scripts/breaker-claude.mjs`: isolated launcher for the blind breaker, the production `--breaker`
  command for `breaker-invoke.mjs`: `claude -p --safe-mode --restricted` in a fresh empty temp dir
  with an allowlisted env (cloud credentials only for the active provider), no MCP and no session
  persistence; prepends the epistemic-guard preamble (hooks do not run in safe mode; a test keeps
  the text equal); refuses blind input with extra keys. Opt-in live probe (`QK_CLAUDE_LIVE=1`) with a
  positive control: a CLAUDE.md marker that a plain `claude -p` returns is not visible to it. Idea from
  Google's Elephant-Goldfish Model (tool-restricted, context-free reviewers with a marker leak probe).
- `scripts/manifest-consistency.test.mjs`: static check that plugin.json, marketplace.json, the
  README status lines and the newest CHANGELOG entry share one version, and that each agent
  declares its expected model alias (never a literal ID).
- `scripts/hermetic-git.test.mjs`: proves the hermetic env defeats a hostile global excludesfile
  and XDG ignore (with a control that shows the hostile config does ignore the file).

### Fixed
- Every gate script run through a symlinked path (a symlinked plugin install, macOS `/tmp` ->
  `/private/tmp`) skipped its main() and exited 0: a silent PASS. The entrypoint guard compared the
  realpath-resolved `import.meta.url` with the as-typed `argv[1]`. All 14 scripts and the pre-push gate
  now use `scripts/is-main.mjs`, which compares real paths. Observed: `contract-review.mjs` and
  `crap.mjs` via a symlink exited 0 on a missing input; they now exit 2.
- `docs/specs/gate-process-tree/contract.md` said the Linux MemAvailable threshold was "fixed, no
  override", contradicting Decision 16 and `mem-config.mjs`, which apply `QK_MEM_MIN_LEVEL_PCT`
  (default 15). Found by the new contract review.
- The default local-target pattern is anchored. `isLocalTarget` accepted `localhost.attacker.com`,
  `my-localhost-proxy.example.com` and `127.0.0.1.nip.io`, bypassing the consent gate that limits
  the autonomous breaker to local systems.
- The Node suite no longer depends on the developer's git config. A global `core.excludesfile`
  (or the XDG `git/ignore`) listing `.quality-kernel/` kept fixtures' `tools.json` out of the base
  commit, failing 59 of 126 tests; a global `core.hooksPath` ran personal hooks on fixture commits.
  Git-spawning tests now import `scripts/hermetic-git.mjs`.
- `hooks/test_hooks.py` no longer depends on the developer's git config. A global or XDG excludes
  file listing `.quality-kernel/` made a fixture repo look gitignored, failing 2 evidence-gate tests;
  the suite now pins git's config as `scripts/hermetic-git.mjs` does for the Node suite.

## [0.5.0] - 2026-09-25

### Changed
- **hardener** and **qa** move from the `sonnet` alias to the `opus` alias. Mutation triage and the
  QA script (which becomes the blind breaker's probe) run on the stronger tier. This raises per-run
  cost for stages 5–6.
- All six agents keep declaring model **aliases**, never literal IDs, so the model is chosen by each
  user's `ANTHROPIC_DEFAULT_*_MODEL` (and works on Bedrock, Vertex and gateways). The README
  documents how to pin a tier.
- Removed the model name from the architect's description; the `model:` field is the only source.
- `marketplace.json` entry aligned with `plugin.json` (it had drifted at 0.1.0).

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
