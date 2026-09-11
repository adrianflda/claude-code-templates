# Plan — M0: Re-executing Verification Referee — v1 (FROZEN)

> **Status:** FROZEN technical plan (SDD). Implements `spec-m0-referee.v1.md` under
> `constitution.v1.md`. **Versioning:** never overwrite → `plan-m0-referee.v2.md`.
> **Altitude:** design decisions + components + how each invariant is proven. Actual code
> is the next artifact (tasks → implement).

## 1. Key design decisions (with rationale)

- **D1 — A standalone CLI, not a hook (yet).** M0 ships as `referee.mjs` — a pure CLI:
  `referee.mjs --repo <dir> --base <ref>` → prints the typed verdict JSON, exits `0`=PASS,
  `1`=FAIL(real), `2`=FAIL(indeterminate). *Why:* it is directly testable against fixtures (INV1–5
  become "run the script, assert the verdict"), it has no dependence on the harness, and wiring it
  (Stop hook / into the forge pipeline) is a later, trivial step. Right altitude: build the
  mechanism first, wire it later.

- **D2 — Config-declared verify command, never a regex.** The referee reads the project's test
  command from config (extend the existing `.quality-kernel/tools.json`: a `verify` command per
  language, reusing the `coverage`/test entries already there). *Why:* the eval expert's finding —
  the hardcoded `VERIFY_RE` whitelist is brittle and silently passes unlisted runners. The verify
  command is data, not a guessed pattern.

- **D3 — Re-execute in our own subprocess.** `spawnSync(verifyCmd, {cwd: repo})`, read `status`
  (the real exit code) directly. Prefer a structured reporter (`--json`) to also capture
  passed/failed counts; exit code is the minimum. *Why:* Constitution P2 — the referee produces the
  fact, the entity under review never does.

- **D4 — Fail-closed toward MORE tests.** Diff→suite mapping is best-effort; when the mapped subset
  is uncertain, run the **full** suite (never a subset). *Why:* a subset is the scope-gaming hole
  (INV3). Running more is the safe direction. Indeterminate exit / spawn error → exit 2 (FAIL).

- **D5 — Node/`.mjs` + `node --test`.** Matches `crap.mjs`, the plugin's existing tooling, and the
  existing self-tests (`crap.test.mjs`, `test_hooks.py`). No new dependencies.

- **D6 — Language/stack-agnostic.** The referee only knows "run this verify command and read the
  exit"; it works for any project because the command comes from config (D2). The tool is
  domain-agnostic by construction.

## 2. Components (what gets built)

| Component | Location | Role |
|---|---|---|
| `referee.mjs` | `plugins/quality-kernel/scripts/` | The gate: diff → map → re-execute → typed verdict → exit code |
| `referee.test.mjs` | `plugins/quality-kernel/scripts/` | Drives the referee against fixtures; asserts INV1–INV4 (`node --test`) |
| `fixtures/` | `plugins/quality-kernel/scripts/fixtures/` | Tiny fake repos: `green/`, `red/`, `trivial-scope/`, `indeterminate/` |
| `verify` config | extend `config/tools.example.json` + `.quality-kernel/tools.json` | Declares the project's verify command(s) |
| evidence-gate fix | `hooks/evidence-gate.py` + `hooks/test_hooks.py` | Real exit-code field + command-token-scoped regex (INV5) |

## 3. Flow of `referee.mjs`
1. Resolve changed files: `git -C <repo> diff --name-only <base>...HEAD` (fail-closed: git error → exit 2).
2. Load the verify command from config (missing config → exit 2, fail-closed).
3. Map diff → suite: if the runner supports file-scoped selection AND mapping is confident, scope;
   otherwise run the full verify command (D4).
4. `spawnSync` the command; read real `status` + parse the structured report if present.
5. Build the typed verdict `{ pass, evidence:{command, exit_code, tests_passed, tests_failed}, reason }`.
6. Print JSON; exit `0` (pass) / `1` (real fail) / `2` (indeterminate → fail).

## 4. Evidence-gate fix (G3, the audit layer — INV5)
- **Bug A (exit code):** first, a throwaway task captures a REAL Claude Code PostToolUse `tool_response`
  payload for a Bash command to discover the actual exit-code field; then read that field. Keep
  `unknown-schema` only for a genuinely absent field, and add a `test_hooks.py` regression fixture
  asserting a real payload yields an integer.
- **Bug B (regex scope):** match `VERIFY_RE` against the parsed leading command token(s) of each
  pipeline segment, not a substring over the whole command string — so a test-word inside a
  `gh pr comment` heredoc body no longer registers as evidence.

## 5. How each invariant is proven (maps spec §5 → tests)
| Invariant | Fixture | Assertion |
|---|---|---|
| INV1 (forged pass blocked) | `red/` + a "done" claim | referee exit ≠ 0 |
| INV2 (genuine pass) | `green/` | referee exit 0, evidence.exit_code 0 |
| INV3 (scope not gameable) | `trivial-scope/` | referee exit ≠ 0 (full suite red) |
| INV4 (indeterminate → fail) | `indeterminate/` | referee exit 2 |
| INV5 (evidence integrity) | real verify cmd vs `gh pr comment` | ledger has real int / records nothing |

## 6. Decisions to confirm with the human
- **DC1:** verify command source — extend `tools.json` (recommended, reuses what exists) vs a new `.quality-kernel/verify.json`.
- **DC2:** for M0, is "run the full verify command when mapping is uncertain" acceptable (safe but slower), or do we want diff-scoping from day one? (Recommendation: full-suite for M0; add scoping in M3 with coverage data.)
- **DC3:** exit-code convention `0/1/2` (pass / real-fail / indeterminate) — OK?

## 7. Definition of done (plan → green)
`referee.mjs` + `referee.test.mjs` + fixtures exist; `node --test` runs green on INV1–INV4; the
evidence-gate fix makes INV5 green. This equals the M0 spec's Definition of Done.
