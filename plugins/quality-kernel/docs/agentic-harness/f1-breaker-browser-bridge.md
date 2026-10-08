# F1 — Breaker ↔ browser bridge (the live UI oracle)

Status: **MVP built and verified live.** Shell-out engine, hand-written steps, local fixture. The
live E2E ran green against a real compiled `$B` + Chromium (build 1234); it self-skips when no binary
is provided.

## What it closes

Our `pipeline-breaker` already takes a `--probe "<cmd>"` and `scripts/breaker-invoke.mjs` already
shells to it and reads a typed verdict — but a probe could only reach the system over **HTTP/CLI**.
An invariant that is only observable **through the UI** had no executable probe. F1 adds one, by
driving gstack's `$B` browser engine. The breaker's information boundary is unchanged: it still sees
only the contract (QA procedure + invariants + probe + URL), never the diff/tests/reasoning
(qa-paradigms P5). We **consume** gstack's engine; we do not modify the fork.

## Pieces

- `scripts/resolvers/gstack-browse.mjs` — locates the `$B` binary (arg > `GSTACK_BROWSE_BIN` >
  `config.browserEngine.bin`) and runs one command; `$B` auto-spawns/reuses its own Chromium daemon.
  `isLocalTarget()` is the consent gate.
- `scripts/gstack-probe.mjs` — the `--probe` for ONE invariant. Navigates a **local** URL, runs the
  vector's steps, reads the observed value, returns a typed result.
  Exit `0=HOLDS · 1=VIOLATED · 2=INSTRUMENT-BROKEN`. Accepts a `stepsFile` OR an inline `spec`.
- `scripts/gstack-breaker.mjs` — the deterministic **UI breaker**: runs a set of falsifying VECTORS
  (each authored from the contract) through `gstack-probe`, anchors every vector to a contract
  invariant id, and returns the pipeline-breaker verdict (`BREAKER_PASS` iff ≥3 vectors executed and
  all HOLDS; any VIOLATED → `BREAKER_FAIL`; any broken/unanchored → `INSTRUMENT-BROKEN`, blocks).
  This is the executable instrument the blind `pipeline-breaker` agent drives — or a standalone
  deterministic breaker for UI-observable contracts. Exit `0=PASS · 1=FAIL · 2=else`.
- `scripts/gstack-probe.test.mjs`, `scripts/gstack-breaker.test.mjs` — pure-function + stub-`$B` CLI
  branches + a live E2E (real `$B` against a `node:http` fixture, separate process) that self-skips
  unless `GSTACK_BROWSE_BIN` is set.
- `config/tools.example.json` → `browserEngine` key (default `null` = UI probes unavailable).

## Truth model (verified against the real binary)

The `GSTACK_STEP_OK` sentinel belongs to the wrapper-script cookbook, NOT the compiled CLI. The `$B`
**binary reports through its EXIT CODE**: 0 = ran, non-zero = failed (bad selector, nav timeout,
browser could not launch). A non-zero exit is **INSTRUMENT-BROKEN**, never a VIOLATED invariant — the
breaker's mandatory instrument check (never report a broken instrument as a broken system).

Observed output shapes (build 1234):
- `goto <url>` → `Navigated to <url> (200)`, exit 0.
- `text <sel>` → value wrapped in `--- BEGIN/END UNTRUSTED EXTERNAL CONTENT ---`; `extractValue()`
  returns what is between the markers, as data — never an instruction.
- `is <prop> <sel>` → plain `true`/`false`, exit 0.

Only `is <prop>` is a native assertion; value/text oracles are composed in `assertInvariant()`.

**Cold-start warmup.** The first command against a cold daemon can exit non-zero ("Daemon busy — did
not answer /health within ~8s") while Chromium launches (first launch also pays macOS XProtect
verification). `ensureDaemon()` retries a cheap `goto about:blank` until ready (budget
`warmupBudgetMs`, default 60s) so a boot race is not misreported as INSTRUMENT-BROKEN. After warmup,
commands are ~sub-second.

## steps.json (derived from the contract invariant, not the diff)

```json
{
  "expected": "5",
  "assert": { "mode": "value", "cmd": "text", "args": ["#result"] },
  "steps":  [ { "cmd": "click", "args": ["#add"] } ]
}
```

The probe always runs `goto <url>` first, then `steps[]`, then the `assert` read. `mode` ∈
`value|equals` (exact), `text|contains` (substring), `is|bool` (boolean prop).

## Build the `$B` binary (macOS-arm64, verified)

```bash
cd <gstack-fork>
bun install                                                   # optional @ngrok/@claude-agent-sdk extract errors are harmless
bun build --compile browse/src/cli.ts --outfile browse/dist/browse
node node_modules/playwright/cli.js install chromium-headless-shell   # fetches the patched revision (1234)
```

## Run it

```bash
# unit + stub CLI (free, no browser):
node --test scripts/gstack-probe.test.mjs

# live, with the compiled binary:
GSTACK_BROWSE_BIN=<gstack-fork>/browse/dist/browse node --test scripts/gstack-probe.test.mjs

# one invariant:
node scripts/gstack-probe.mjs --url http://127.0.0.1:5173/ --steps steps.json \
  --invariant "INV-UI-1: the total updates after add" --config .quality-kernel/tools.json

# a full deterministic UI breaker (≥3 vectors, contract-anchored):
node scripts/gstack-breaker.mjs --contract contract.md --url http://127.0.0.1:5173/ \
  --vectors vectors.json --config .quality-kernel/tools.json
```

## Deferred (next after MVP)

- **Have the blind `pipeline-breaker` agent DERIVE the vectors** (novel falsifying inputs) and drive
  `gstack-breaker` as its instrument — the deterministic runner already executes + judges them.
- **Auto-generate the vectors/steps from the `qa` agent** (stage 6) instead of hand-writing them.
- **Build `$B` in Linux CI from source** (Bun + patched Playwright + Chromium); MVP dev uses the
  macOS-arm64 binary built above.
