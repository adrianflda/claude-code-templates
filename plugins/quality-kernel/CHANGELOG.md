# Changelog

All notable changes to the **quality-kernel** plugin are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
