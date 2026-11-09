# Design — qk-breaker-robust-input

Scope read: ticket `cct_breaker_issue.md`, contract `specs/qk-breaker-robust-input/spec.md`
(§4 D1-D4 settled, not reopened here), blind review `spec.review.md`, and the six files it covers
plus their tests and fixtures. OBSERVED claims cite file:line; everything else is INFERRED.

## 1. Fit to the ticket

**No under-scope findings.** All three ticket items are covered: heading tolerance + fail-loud-empty
(EARS-H1/H2/H6), per-vector drop/report + Host handling + prompt update (EARS-V1-V9, V8), and the
breaker-not-executed marker (EARS-M1-M5).

Over-scope / outside-ticket items found, in order of weight:

- **OPEN — not one of D1-D4, needs the human's yes/no.** EARS-M1's write protocol: "write to a
  temporary file ... named `breaker-not-executed.json.<pid>-<random-hex>.tmp` ... then rename" PLUS
  two dedicated Gherkin scenarios ("A crash immediately after the temp-file write..." and "Two
  concurrent breaker-gate.mjs runs against the same repo never collide..."). Ticket line: "add a
  machine-readable 'breaker not executed' marker" — nothing about concurrency or crash-safety. A
  plain atomic temp+rename (no pid/random, since the ticket never raises concurrent runs) still
  protects against a half-written file; what goes beyond the ticket specifically is the
  **pid+random-hex uniqueness and its 2 dedicated tests**, which only matter if two
  `breaker-gate.mjs` processes ever run against the SAME `--repo` at once. I found no OBSERVED
  evidence that happens in this pipeline (each push/PR runs one gate). If dropped: save ~10-15 lines
  and 2 tests; the file write stays atomic (temp+rename) but a theoretical concurrent-run collision
  is not specifically guarded. This is cheap either way — flagging for the record, not blocking.
- **Justified, no finding.** EARS-H4's id-grammar widening (`INV-` → any `letters/digits-hyphen-...`)
  is not in the ticket's literal heading-only wording, but spec §0 ties it to the SAME real contract
  and the SAME mechanism (table-row parsing) that triggered the ticket — it is required for INV-14/16
  to pass at all (contract-lint's declared-id extraction stays empty otherwise). Keep.
- **Already settled (D2), noted only for context.** `contract-lint.mjs`/`gstack-breaker.mjs` in scope
  — grounded in the review's blocker #2 (breaker-gate.mjs's own call chain hits contract-lint.mjs
  BEFORE breaker-invoke.mjs, so fixing only breaker-invoke.mjs reproduces the bug end-to-end). Not
  reopening.
- **Already settled (D3), noted only for context.** EARS-V6's registrable-domain rule is wider than
  the ticket's literal "allow sub-domains of the system URL": it accepts any host ending in
  `.<last-two-labels-of-systemUrl>`, i.e. sibling domains too (e.g. `other-app.example.com` when
  `systemUrl` is `mbvs-server-development.example.com`), not just subdomains of that specific host.
  Adrian ratified this as drafted 2026-11-08. Not reopening.
- **Cheap, recommend keep as-is in every option.** EARS-H2b/H4b (first-match-wins for a duplicate
  heading or duplicate table id) is review-driven, not in the ticket text, and the real contract that
  triggered the ticket has no duplicates. But a correct single-pass top-to-bottom parser produces
  first-match-wins for free — there is no cheaper alternative to build, so this adds no real cost.

## 2. Options

All three options do the SAME work for vector validation (EARS-V1-V9 in `vector-breaker.mjs` +
Host rule in `http-probe.mjs`), the prompt (`breaker/vector-author.md`, EARS-V8), and the
not-executed record (`breaker-gate.mjs`, EARS-M1-M5). They differ only in how the heading/table-row
parser (EARS-H1-H6, H2b, H4, H4b, H5) is shared between `breaker-invoke.mjs` and `contract-lint.mjs`
— the piece the review's blocker #2 shows failed identically, independently, in two places. This is
the one place "share vs. duplicate" matters, since `gstack-breaker.mjs` already gets its sections by
calling `buildBlindInput()` (OBSERVED `gstack-breaker.mjs:56`) and only needs a 3-line emptiness
guard (EARS-H9) in every option.

### Option A — patch each file in place (duplicate the parser)

Rewrite `section()`/`invariants()` in `breaker-invoke.mjs` to the new rules, and separately rewrite
`contractIds()` in `contract-lint.mjs` with its OWN copy of the same heading-match + table-row-split
+ id-normalize logic. Files touched: `breaker-invoke.mjs`, `contract-lint.mjs`, `vector-breaker.mjs`,
`http-probe.mjs`, `gstack-breaker.mjs` (guard only), `breaker-gate.mjs`, `breaker/vector-author.md`,
plus their `*.test.mjs` (~9 files, ~250-300 changed lines, ~50 lines of parser duplicated twice).
Effort: INFERRED low-medium. Risk: INFERRED medium — two independent copies of the exact mechanism
the ticket is about (one file's heading/table parsing silently diverging from another's) can drift
again on the next contract-shape surprise; this is the precise failure class blocker #2 named.
Leaves out: any structural guarantee that the two parsers stay identical.

### Option B — a shared parser module

New `plugins/quality-kernel/scripts/contract-sections.mjs` exporting the heading matcher and the
table-row scanner; `breaker-invoke.mjs` and `contract-lint.mjs` both become thin wrappers over it.
Files touched: Option A's list + 1 new module + 1 new test file (~11 files, similar aggregate size,
~70-90 lines concentrated in one tested module instead of duplicated). Effort: INFERRED
low-medium, marginally above A (mostly mechanical extraction). Risk: INFERRED low — removes the
drift risk permanently; the only cost is one more file for the pre-push panel's Maintainability
reviewer to judge as a real seam vs. an abstraction for only 2 call sites.

### Option C — direct cross-import, no new file (the simplest option that meets the ticket)

`breaker-invoke.mjs` exports its rewritten `section()`/`invariants()` next to its existing
`buildBlindInput` export; `contract-lint.mjs` deletes `contractIds()` and imports those functions
directly, keeping only a 3-line adapter (it needs just the `id`s, not `expected`). This reuses a
pattern already in this codebase — `gstack-breaker.mjs` already imports `buildBlindInput` from
`breaker-invoke.mjs` (OBSERVED line 24) — rather than inventing a new file. Files touched: Option
A's list minus the duplicated code in `contract-lint.mjs` (~9 files, no new file, smallest diff of
the three). Effort: INFERRED lowest. Risk: INFERRED low — same drift-elimination as B; the only
wrinkle is direction (`contract-lint.mjs`, a precondition/lint file, now depends on
`breaker-invoke.mjs`, the instrument-invoking file it gates) — harmless at runtime since
`breaker-invoke.mjs`'s process-spawning code only runs inside its `isMain()` guard (OBSERVED line
41), but a reader has to notice that. Leaves out: a standalone, breaker-invoke-independent place to
unit-test the parser (tests stay in `breaker-invoke.test.mjs` plus one cross-check case added to
`contract-lint.test.mjs`).

### The 6 carried majors → tests (same mapping regardless of option; file names below use Option C's layout)

1. "Referee gate" undefined → not a behavior test; add/extend one `breaker-gate.test.mjs` assertion
   that documents `refereeGate`'s pass-through shape, and a one-line Glossary note.
2. EARS-V4 step (3) sub-order unpinned → add an `http-probe.test.mjs`/`vector-breaker.test.mjs` case
   with a vector that fails BOTH an unknown-method check and the Host rule at once; assert which
   single reason string wins (pins the order the code already has: shape/method/path checks run
   before the headers/Host loop, OBSERVED `http-probe.mjs:34` vs `:44-49`).
3. EARS-V4 step (4) plumbing unnamed → already exists as `blind.probeCmd` (OBSERVED
   `vector-breaker.mjs:81`); add the missing test: an HTTP vector with no `expect` and
   `blind.probeCmd` falsy is dropped with a reason naming "expect"/no contract probe.
4. INV-3/4/12 probe internals, not CLI output → rewrite as `breaker-invoke.test.mjs` cases using a
   `--breaker` stub that echoes the parsed `qaProcedure`/`invariants` fields back in its verdict JSON
   (the way INV-1 already does), asserting on `breaker-invoke.mjs`'s own stdout.
5. EARS-H2/H2b vs EARS-H3 precedence unresolved → add a `breaker-invoke.test.mjs` fixture with a
   `###` sub-heading inside the QA-procedure body that lexically matches "Invariants" (e.g. "### Known
   invariants to recheck"); assert it is swallowed into the QA-procedure body, never picked as the
   Invariants section opener.
6. EARS-V6 branch (a) untested → add an `http-probe.test.mjs` case: Host header exactly equal to the
   systemUrl's own hostname (no subdomain) is accepted, not dropped.

## 3. Recommendation

Option C. It removes the exact duplication risk the review's blocker #2 names, at the lowest diff
size of the three, by reusing a dependency direction this codebase already has
(`gstack-breaker.mjs` → `breaker-invoke.mjs`). Option B is the fallback if the human prefers the
parser not to live inside the CLI-invoking file at all. Before coding, confirm the one open fit
finding above (EARS-M1's concurrent-run uniqueness guarantee) — keep as specified or trim; it does
not change which build option to pick either way.

## Chosen option

**Option B** — new shared module `contract-sections.mjs` (heading + invariant-table parser) with its own
test; `breaker-invoke.mjs`, `contract-lint.mjs` and `gstack-breaker.mjs` consume it. Chosen by Adrian,
2026-11-08, over the designer's Option C, so that the contract-lint precondition does not depend on
the breaker invoker (dependency direction: both depend on the small parser, not on each other).

Also decided: keep the EARS-M1 write protocol as specified (temp name unique per process with
pid + random hex, then rename, plus the two crash/concurrency tests). The gate can run concurrently
(pre-push hook and a manual run on the same repo).
