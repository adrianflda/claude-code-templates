# Changelog

All notable changes to the **quality-kernel** plugin are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.0] - 2026-09-25

### Changed — the gate verifies committed bytes (behaviour change)
- **Base and head trees are written from raw blobs** (`git ls-tree` + `git cat-file --batch`), not
  `git archive`. `git archive` applied checkout conversions driven by uncommitted state, which
  flipped verdicts both ways: a smudge filter declared in `$GIT_DIR/info/attributes` plus local
  config neutered the base harness and turned a real FAIL into PASS; a global `core.autocrlf` turned
  a clean change into FAIL. Now no conversion runs at all — including those the *committed*
  `.gitattributes` asks for: `export-ignore`/`export-subst`, `eol`, `ident`, `working-tree-encoding`
  are not applied, and exec bits come from the tree mode.
- **A path with a `filter` attribute (e.g. Git LFS) is refused as indeterminate** (committed, or
  set in `$GIT_DIR/info/attributes`): its committed bytes are a placeholder, so verifying them would
  not test the file the project uses.
- **Every blob is re-hashed against its committed id**, and every git call runs with
  `GIT_NO_REPLACE_OBJECTS=1` and `core.fsmonitor=false` (new `scripts/safe-git.mjs`, also used by
  the router). A local `git replace`, or a rewritten loose object, turned a real FAIL into PASS.
- **Tree entries git would not check out are refused**: `..`, `.`, empty or `\` components, `.git`
  (and its case/8.3 variants), duplicates. A crafted tree (`hash-object --literally`) with an entry
  named `..` aliased `src/../lib/helper.mjs` onto a base harness helper and forged a PASS.
- **Requires git >= 2.40** (`check-attr --source`), checked up front.
- ATTACK N7/Q7 (`export-ignore` on the tests) now ends in a definitive FAIL (exit 1): the stripped
  harness can no longer be stripped, so it runs and blocks. It was indeterminate (exit 2) before.

### Fixed — gate
- **A contract kept out of the base by an ignore rule is diagnosed.** When `tools.json` is missing
  at base but present in the worktree and ignored, the indeterminate reason names where the rule
  lives (file and line — never its text, which the change controls) and the fix (`git add -f`).
  Negation rules are not reported as ignores; the probe runs with fsmonitor disabled.
- **Temp trees no longer leak on indeterminate exits.** `process.exit` skipped the `finally`
  cleanup; trees are now also removed from an exit handler (each removal isolated).
- **Overlay fidelity**: a production file whose mode changes at head gets the head mode (was a false
  FAIL); a file that becomes a directory, or the reverse, is verified instead of crashing with exit 1.
  Write errors, and blobs above a size cap (`QK_MAX_BLOB_BYTES`, default 256 MiB), are indeterminate.
  The cat-file staging file is created exclusively with mode 0600.
- Known limit, documented: killing the gate with a signal mid-verify still leaks its tree and
  orphans the verify command (blocking `spawnSync`); tracked as a follow-up.

### Fixed — test suite
- The Node suite no longer depends on the developer's git setup. A global `core.excludesfile`
  (or the XDG `git/ignore`) listing `.quality-kernel/` failed 59 of 126 tests; a global
  `core.hooksPath`, `commit.gpgsign` or an outer `git -c` (`GIT_CONFIG_PARAMETERS`) failed
  fixture commits; an inherited `GIT_DIR` (suite run from a git hook) committed fixtures into the
  outer repo. Git-using tests import `scripts/hermetic-git.mjs` first: it pins a temporary global
  config (repo-local config still wins, so attack tests can plant it), sets `GIT_CONFIG_NOSYSTEM`
  and `GIT_ATTR_NOSYSTEM`, and drops every inherited `GIT_*` variable.

### Added
- `scripts/hermetic-git.test.mjs`: eight hostile git environments, each with a control that shows the
  hostile setup takes effect; repo-local config still wins; a child process proves the env rewrite
  and the temp-config cleanup.
- `scripts/test-hygiene.test.mjs`: every test that reaches git (directly, in a shell string, or via
  referee, route, qk-gate, breaker-gate or `hooks/pre-push.sample`) imports the hermetic module
  first; no non-test file imports it.
- `scripts/manifest-consistency.test.mjs`: plugin.json, marketplace.json, the README status lines
  and the newest CHANGELOG entry share one version; every agent file declares a model alias and
  each stage its expected one.

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
