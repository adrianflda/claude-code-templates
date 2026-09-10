# quality-kernel

A quality-assurance **kernel** for agentic development. It does not replace your
pipeline — it wraps it with the parts that turn "I think it's good" into a
declared residual: a six-agent engine, deterministic quality tools, a blind
live-oracle verifier, and epistemic-discipline gates. Scales from a one-line
issue to a large feature.

> Status: **v0.4.0.** The deterministic **quality gate** (`/gate`) is built and was
> reworked after an independent red-team panel broke v1 (see `docs/agentic-harness/validation-panel.*`).
> It now anchors verification to committed history and an inverted trusted tree. The six agents, the
> `/forge` orchestrator and the two hooks are in place; the epistemic hook ships in **log-mode** by
> design. The live breaker (M2) is the next milestone — and, importantly, the ONLY thing that closes
> the honest limit below. Design chain: `docs/agentic-harness/`.

## The Quality Gate (`/gate`) — the deterministic teeth

The reusable core. It answers "is this change actually done?" **by mechanism, not by trusting
the agent's word** — it re-runs your tests itself, against committed history, and reads the real result.

- **Router** (`scripts/route.mjs`) — deterministic blast-radius/tier from `.quality-kernel/critical-surface.json`
  (read from the **base ref**, not the worktree). The changeset is `git diff -z base..head` between two
  committed refs; a renamed-away path counts as a deletion. A change touching the critical surface, or
  deleting a test, or touching `.quality-kernel/**`, is forced critical; editing a test is never trivial.
  Fail-safe: no config => critical.
- **Referee** (`scripts/referee.mjs`) — verifies a committed `base..head` (never the worktree) with
  **two mandatory runs** that must both be green: (1) the base harness run against the head's
  **production code only** (paths in `productionGlobs`) — tests/fixtures/helpers/runners/manifests/
  configs the PR did NOT touch stay at base, so **breaking covered code without editing its test is
  mechanically blocked**, and neither a swapped runner nor a hidden helper can force a green; plus
  (2) the **head as-is**, so bugs outside `productionGlobs` and the head's own new tests run too.
  **Test evolution (Option B):** the tests the PR *modifies* are taken from head (so a legitimate
  behavior change — code + its test updated together — verifies green), and the router forces any
  test change to **critical → human review** (a test edit is a contract change; the human owns the
  contract). So neutering a test is never a silent pass — it is **visible in the diff and gated by a
  human**, not mechanically impossible. An optional **acceptance oracle** (`acceptance` in
  `tools.json`, human-approved, distinct from the coder's tests — Constitution P3) runs against the
  base-immutable tree — and the gate **refuses (indeterminate)** if the `acceptance` command executes
  a file under `productionGlobs` (which head could overlay), keeping the oracle independent.
  Fail-closed on any uncertainty (missing/ambiguous contract, symlink, stripped tests, an undeclared
  changed path, a harness mutation, a case-collision, a command that can't run).
- **Composed gate** (`scripts/qk-gate.mjs`) — `route` + `referee` in one verdict. Exit `0` pass ·
  `1` fail · `2` indeterminate · `3` green-but-critical-needs-breaker.
- **Invoker** (`hooks/pre-push.sample`) — a git pre-push hook that gates the exact **pushed sha**
  against a **remote-anchored base** and blocks the push on a non-zero gate.

Every red-team attack the panel used to break v1 — forged pass, weakened `tools.json`, deleted /
neutered / renamed-away test, in-place test-neuter, non-`.sh` runner swap, golden re-goldening,
committed symlink (incl. an arbitrary write outside the repo), non-ASCII path, worktree/HEAD
divergence, co-located test overlay, bug outside `productionGlobs`, export-ignore-stripped tests,
untracked config/tools fallback, pushed-sha-vs-worktree, forged base ref — is now a permanent
regression test (`scripts/attacks.test.mjs`, `route.test.mjs`, `pre-push.test.mjs`).

### Honest limits (what M0+M1 do NOT cover — the M2 live-breaker's job)
The referee is an **in-process test oracle** that re-executes the committed change. It cannot, by
mechanism alone, defend against the change's own code **executing and being trusted**:
- **In-process oracle subversion** — production code the tests import can monkeypatch the assertion
  library or call `process.exit(0)` before assertions report.
- **Gate-environment fingerprinting** — code that behaves correctly only when it detects the gate.
- **Execution-trust** — a build/`verifySetup`/codegen step (overlaid head code) that fabricates or
  vendors what the tests then consume; keep such scripts as immutable harness (outside
  `productionGlobs`) and provision deps hermetically.
- **A baseline with genuinely no tests** — the gate verifies the suite you have; it cannot invent one.
- **Test changes are human-reviewed, not mechanically certified** (Option B): a neutered test is
  routed to review (exit 3), where the diff is visible; the gate does not decide whether a test edit
  is legitimate — the human does.
- **A client-side hook is not enforcement.** Locally, exit 3 blocks the push, but a determined
  developer can `git push --no-verify`; the "human review" is a workflow, not a mechanical lock. Real
  enforcement is server-side (a protected branch / required check), which is out of this local-first
  tool's scope. Read "gated" as "surfaced for review," not "impossible to bypass."

Closing the first three in general needs a **black-box probe in an environment indistinguishable from
production** — the **M2 live breaker**. Until M2, treat a green as "the committed suite and acceptance
oracle re-executed clean, and any test change was surfaced for human review", not "the code cannot be
malicious." Every attack above is reproduced and tracked in `docs/agentic-harness/validation-panel.*`.

### Use it
Per repo, once, create and **commit** `.quality-kernel/tools.json` (copy `config/tools.example.json`):
`{ "verify": "npm test", "productionGlobs": ["src/**"], "acceptance": null }` — `verify` is your test
command (`pytest -q`, `node --test`, ...); `productionGlobs` declares your production source; set
`verifySetup` (e.g. `npm ci --ignore-scripts`) if the suite needs dependencies. Also commit
`.quality-kernel/critical-surface.json` (copy `config/critical-surface.example.json` and author its
globs from the repo's own past incidents). Both are read from the base ref, so they must be committed.
Then:
- In Claude Code (plugin enabled): **`/gate`** — runs the gate on the current committed change and reports.
- CLI: `node scripts/qk-gate.mjs --repo . --base <base-sha> --head <head-sha>`
- Auto on push: `cp hooks/pre-push.sample .git/hooks/pre-push && chmod +x .git/hooks/pre-push`

Verify the gate itself: `node --test scripts/*.test.mjs` and `python3 hooks/test_hooks.py`.

## M2 — plan-with-teeth + agentic QA (P2·P4·P5)

The gate above makes *re-execution* trustworthy (qa-paradigms **P2**). M2 adds the two stages with the
most leverage and the least prior mechanism: a **plan that produces a machine-checkable Contract**, and
**QA that ends green by mechanism** anchored to it. Design chain: `docs/agentic-harness/{spec,plan,tasks}-m2-plan-qa.v1.md`.

- **The Contract** — two coupled files: a human-approved `.quality-kernel/contracts/<id>.md` (EARS ·
  Gherkin · an invariants table of **exact** expected values · a QA procedure) and its executable
  `.quality-kernel/acceptance/<id>.test.mjs` (one assertion per invariant — qa-paradigms **P4**, assert
  the value, not the agent's paraphrase). `scripts/contract-lint.mjs` proves the two stay in lockstep
  (no invariant without a check, no check without an invariant). The referee runs the acceptance suite
  via `tools.json "acceptance"` (immutable-from-base).
- **The blind breaker** (qa-paradigms **P5**; constitution P3) — `scripts/breaker-invoke.mjs` builds the
  breaker's input from the **Contract only** (QA procedure + invariants + a live probe + the system URL)
  and **never** the diff, the coder's tests, or any reasoning; it shells to a breaker command (in
  production the host `pipeline-breaker` agent; a stub for tests) and reads a typed verdict.
  `scripts/breaker-gate.mjs` = the composed gate + the enforced breaker: on the critical surface a green
  referee is not enough — the breaker must **PASS**.
- **Cost** — `scripts/run-ledger.mjs` records tokens/$/wall-clock/human-interventions per dogfood run,
  so M2's prove-or-kill economics are measurable.

Status: the M2 **mechanisms are built and unit-tested** (contract-lint, breaker-invoke's blind
boundary, breaker-gate PASS/FAIL, run-ledger). The **dogfood run** (one real issue end-to-end with the
live `pipeline-breaker` and a measured cost — the prove-or-kill) is the human-greenlit final step.

## The idea

Quality is lost in the *seams between agents*, not inside them. quality-kernel
closes those seams with three principles:

1. **Teeth, not prose** — every gate is a hook or a command that runs, not a
   convention you trust.
2. **Independence ≠ another LLM** — the only strong independent checks are the
   **human** (validates intent) and the **live oracle** (a probe that executes
   against the real system and returns a fact).
3. **Rigor ∝ blast-radius** — maximum rigor where it can hurt; the trivial path
   stays fast, so the gates never get bypassed.

## The engine — six agents (a SwarmForge-style chain)

`specifier → coder → cleaner → architect → hardener → qa`

| Agent | Owns | Deterministic tool |
|-------|------|--------------------|
| **specifier** | EARS criteria + Gherkin + e2e QA + external invariants | Gherkin DRY check |
| **coder** | implementation + unit tests (genuine RED) + accept. harness | TDD, oracle-signal check |
| **cleaner** | structure-preserving cleanup | CRAP ≤ 6, jscpd, mutation-site count |
| **architect** (opus) | module boundaries, dependency direction | dependency-cruiser / import-linter |
| **hardener** | mutation hardening, kill survivors | StrykerJS / mutmut, survivor-triage |
| **qa** | final independent verification, UI-only | the QA script **is the breaker's probe** |

Each agent runs a **self-audit before handing off** ("passing checks alone do
not establish completeness"). Roles are fixed; **domain expertise is injected**
(reuse your `backend-developer`, `frontend-developer`, `security-engineer`, …).

## Usage

```
/forge <task description | issue #> [--tier T0|T1|T2]
```

`/forge` is the orchestrator / PM-router. It:

- **routes a tier** automatically (T0 issue/fix · T1 medium · T2 large), with a
  **blast-radius override**: any change touching the critical surface (auth,
  money, external state, voice, migrations, infra, the contract) is forced to
  T1+ regardless of size. You may *propose* a tier; the system may raise it but
  **never lower** it below what blast-radius requires;
- runs the chain for that tier, passing **artifacts + context** (not chat) with
  a PM-router and **voting** (not debate) where a judgment is needed;
- enforces the gates: **intention (human)**, genuine RED, mutation (async),
  **blind breaker (live oracle, default-deny)**, evidence-gate, and the
  `pre-push-review` panel.

## Gates & hooks

Automatic, always on (no invocation needed):

- **`hooks/epistemic-guard.py`** (PreToolUse / `Task|Agent`) — requires the
  `[EPISTEMIC-DISCIPLINE v1]` marker in every agent spawn (fires for whichever
  tool name — `Task` or `Agent` — the host runtime uses to spawn subagents).
  Env `QK_EPISTEMIC_MODE`: `log` (default, warn only) | `block` (exit 2).
- **`hooks/evidence-gate.py`** (PostToolUse / Bash) — records exit codes of
  test/build/verify commands to `.quality-kernel/evidence-ledger.jsonl`, so a
  "done" claim can be checked against a real verification event newer than the
  last edit. v0 records; hard-blocking is future work.

## Gate status — teeth vs. prose (v0.4.0)

Not every gate is a forcing function yet. This is the honest status per gate, so
installing the plugin does not imply the full guarantee.

| Gate | Status today | Notes |
|------|--------------|-------|
| Epistemic guard (G1) | **wired (teeth)**, advisory | hook; `log` by default, `block` via env |
| Evidence-gate (G2) | **wired, record-only** | hook writes a ledger; hard-block is v1 |
| CRAP gate | **wired (teeth)** | deterministic script, non-zero exit over threshold |
| Pre-push panel | **wired (teeth)** | the existing `pre-push-review` plugin |
| Re-executing referee | **wired (teeth)** | `scripts/referee.mjs`; commit-anchored, two-run, fail-closed; red-team suite in `scripts/attacks.test.mjs` |
| Blind breaker (live oracle) | **by-reference** | invokes the host's `pipeline-breaker`, not bundled; **the only thing that closes the in-process limit (M2)** |
| Adversarial critic (Opus) | **by-reference** | invokes the host's `adversarial-critic` |
| Intention gate (G0) | **prose** | instruction to the orchestrator in `/forge`; forcing function is v1 |
| Tier router | **wired (teeth)** | `scripts/route.mjs`, deterministic classifier; LLM may raise, never lower the floor |
| Mutation as CI gate | **script only** | `crap.mjs` / mutation ship; wiring into CI is v1 (F3) |

## Configuration (per project)

Copy the examples into your repo's `.quality-kernel/`:

- **`config/tools.example.json`** → the per-language deterministic tools
  (mutation, CRAP, DRY, deps). Default order: TypeScript → Node → Python.
- **`config/critical-surface.example.json`** → the globs that trigger the
  blast-radius override. If absent, `/forge` treats anything outside
  docs/tests/styling/tooling as critical (fail-safe).

## Tools

- **`scripts/crap.mjs`** — CRAP calculator: `CRAP = c² · (1−cov)³ + c`. Feed it
  a JSON array of `{ name, file, complexity, coverage }` (from your coverage +
  complexity tools); exits non-zero if any function exceeds the threshold
  (default 6).

## Tests

- `scripts/crap.test.mjs` — `node --test plugins/quality-kernel/scripts/crap.test.mjs`
- `hooks/test_hooks.py` — `python3 plugins/quality-kernel/hooks/test_hooks.py`

They cover the deterministic gate (CRAP formula + CLI exit codes) and the hook
behavior (marker/exempt detection, log-vs-block mode, fail-open, and the ledger
recording including the `unknown-schema` sentinel).

## Design docs

The full design (why each gate exists, the communication model, the graduation
by tier, the reconciliation with the existing agent arsenal) lives in the
"Fragua" artifact series. This plugin is its materialization.

## Still open

- Wire the epistemic guard from `log` to `block` once the `[EXEMPT]` rate is low.
- Evidence-gate hard-block on unverified completion claims.
- Per-stack adapters that emit the `crap.mjs` input from nyc/coverage.py + eslint/radon.
- Port the Gherkin DRY-checker and Gherkin mutator (no TS/Python equivalent yet).
- Judge calibration (Cohen's kappa ≥ 0.6 over a gold set) for probabilistic judgments.
- Optional GitHub Project integration (one issue per task).
