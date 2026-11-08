# Contract — Blind breaker: robust contract parsing, per-vector drop/report, breaker-not-executed record

## 0. Context (OBSERVED)

Three real failures from one tier-1 ("T1": single-contributor change, below the quality-kernel
pipeline's multi-stage tier-2 threshold) run (2026-11-06), root-caused against the plugin's current
code (`<repo>/plugins/quality-kernel/scripts/`):

- OBSERVED `breaker.log`/`breaker2.log`: `{"verdict":"INSTRUMENT-BROKEN","reason":"vectors must be a
  non-empty array",...}` — `breaker-invoke.mjs`'s `section()`/`invariants()` (lines 18-35) match only
  the literal headings `## QA procedure` and `## Invariants`. The real contract that triggered this
  ticket (a machine-local path — not referenced normatively anywhere below; see §0.1) uses `## 5.
  End-to-end QA procedure (UI-only — browser, no internal API)` and `## 6. External Observable
  Invariants` — neither matches, so both extractions are empty and the author gets an empty blind
  input, writes no vectors, and `vector-breaker.mjs`'s `validateVectors` (line 59) rejects the empty
  array.
- OBSERVED `breaker3.log`/`breaker4.log`: `"reason":"vectors[1]: ui.steps[0] goto leaves the system's
  origin; vectors[7]: requests[0].headers may not set host; ..."` — one invalid vector (a `Host`
  header or an out-of-origin `goto`, both legitimate multi-tenant probes) makes `validateVectors`
  reject the **entire** batch (`vector-breaker.mjs:58-87`), even when ≥3 other vectors are valid.
- OBSERVED (code read, `breaker-gate.mjs`/`breaker-invoke.mjs`): on `INSTRUMENT-BROKEN` the gate exits
  non-zero (default-deny holds) but writes nothing to disk; nothing distinguishes "the breaker never
  ran" from any other blocked state for a later reader.
- OBSERVED (code read, `breaker-invoke.mjs:27-35`): the invariant-table row regex requires the literal
  prefix `INV-` (`(INV-[A-Za-z0-9-]+)`). The real contract's table used ids `**EO-0**`, `**EO-1b
  (exhaustive — ...)**`, `**EO-6 (re-run)**` — none start with `INV-`, so even with the heading
  fixed, zero invariants would be extracted. This is in scope here even though the ticket text led
  with headings, because it is the same mechanism (table-row parsing) failing on the same
  real contract.

### 0.1 Fixtures this contract ships and is anchored to (repo-relative; no step below needs anything outside this worktree)

- `plugins/quality-kernel/scripts/fixtures/qk-breaker-robust-input/contracts/contract-1045-shape.md`
  — a sanitized (example.com only, no real hosts/IPs) fixture reproducing the real failing
  contract's exact shape: numbered/parenthetical headings, the literal `## External Observable
  Invariants` heading, bold ids with a trailing parenthetical (`**EO-6 (re-run)**`), and a
  probe-command cell containing a literal pipe (`` `curl ... \| jq .` `` under EO-6).
- `plugins/quality-kernel/scripts/fixtures/qk-breaker-robust-input/acceptance/contract-1045-shape.test.mjs`
  — its sibling acceptance suite (one assertion per declared id: `EO-0`, `EO-6`), for the
  `contract-lint.mjs`/`breaker-gate.mjs` lockstep check (INV-14 below).
- `plugins/quality-kernel/scripts/fixtures/qk-breaker-robust-input/vector-stub.mjs` — the QA
  procedure's deterministic `--breaker` stub: an external OS process, importing the real instrument
  by a **relative** path (`../../vector-breaker.mjs`) exactly the way production's
  `breaker-claude.mjs` is itself an external process that happens to import `vector-breaker.mjs`.
  The operator invokes it only as `--breaker "node <this file>"`, never imports `runVectors` into
  their own shell.
- `plugins/quality-kernel/scripts/fixtures/qk-breaker-robust-input/vector-author-prompt.test.mjs` —
  the executable check for EARS-V8 (INV-13 below): a `node --test` file that reads the real
  `breaker/vector-author.md` via a **relative** path (`../../../breaker/vector-author.md`) and
  asserts its three required substrings.

All four already exist in this worktree (OBSERVED: `node --check` on the `.mjs` files reports no
syntax error; `node --test
plugins/quality-kernel/scripts/fixtures/qk-breaker-robust-input/acceptance/contract-1045-shape.test.mjs`
prints `tests 2`, `pass 2`, `fail 0`; `node --test
plugins/quality-kernel/scripts/fixtures/qk-breaker-robust-input/vector-author-prompt.test.mjs` runs
today and RED-fails tests (b) and (c), OBSERVED, because the real `breaker/vector-author.md` does not
yet contain the literal phrase "only that vector" or every production-cased token). Every QA step and
every Gherkin/probe reference below uses one of these four files, or a value computed from them —
never an absolute path, a path outside this repo, or an internal variable name from the scripts'
source.

This spec covers `breaker-invoke.mjs`, `vector-breaker.mjs`, `breaker-claude.mjs` (the
`breaker/vector-author.md` prompt it loads), `breaker-gate.mjs`, `contract-lint.mjs`, and
`gstack-breaker.mjs`, plus their `*.test.mjs`.

### Scope decision (EARS-H8/H9) — DECIDED by the human (Adrian), 2026-11-08 (see §4, D2)

`contract-lint.mjs` and `gstack-breaker.mjs`, though not named in the ticket's original file list
(`breaker-invoke.mjs`, `vector-breaker.mjs`, `breaker-claude.mjs`, `breaker-gate.mjs`), are now IN
SCOPE for this change. Reason this was needed, not aspirational: without the EARS-H8 fix,
`contract-lint.mjs` still blocks the real contract's shape at `blocked-invalid-contract` (OBSERVED
`breaker-gate.mjs:71,81`) before `breaker-invoke.mjs` is ever reached. EARS-H8 and EARS-H9 below are
therefore plain, unconditional `SHALL` criteria, and their probes are INV-14/INV-15 in the single core
"External Observable Invariants" table (§ below) — there is no separate conditional table anymore.

## 1. EARS acceptance criteria

### 1.0 Vocabulary this contract does not change (enumerated, OBSERVED — cited so no implementer has to infer them from "today's" code)

- Allowed top-level vector keys: `invariant`, `http`, `ui` (OBSERVED `vector-breaker.mjs:24`).
- Allowed UI vector keys: `expected`, `assert`, `steps` (OBSERVED `vector-breaker.mjs:25`).
- Allowed UI step commands: `goto`, `click` (OBSERVED `vector-breaker.mjs:22`).
- Allowed UI assert commands: `text`, `is`, `attrs` (OBSERVED `vector-breaker.mjs:23`).
- Allowed HTTP spec keys: `requests`, `expect` (OBSERVED `http-probe.mjs:20`).
- Allowed HTTP request keys: `method`, `path`, `headers`, `body` (OBSERVED `http-probe.mjs:21`).
- Allowed HTTP methods: `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE` (OBSERVED `http-probe.mjs:18`).
- Allowed HTTP `expect` keys: `status`, `json` (OBSERVED `http-probe.mjs:22`); allowed json-check keys:
  `pointer`, `equals` (OBSERVED `http-probe.mjs:23`).
- Batch/size limits: at most 30 vectors per run (OBSERVED `MAX_VECTORS`, `vector-breaker.mjs:18`); at
  most 20 requests per HTTP vector (OBSERVED `MAX_REQUESTS`, `http-probe.mjs:19`).
- **"Probe command"** (used in EARS-V4 below) means exactly the `--probe` CLI argument given to
  `breaker-invoke.mjs`, surfaced to the breaker as the blind input's `probeCmd` field (OBSERVED
  `breaker-invoke.mjs:38-39,59`: `buildBlindInput(md, { probeCmd: probe, ... })`, where `probe` is
  parsed from `--probe` at line 46) — never anything parsed out of the contract file itself.
- **The `gate` field** (used in EARS-M2/M3) is `breaker-gate.mjs`'s own top-level stdout JSON field.
  OBSERVED, every code path that calls `emit()` sets it: `'error'` (L29); a passthrough of the
  referee gate's own `gate` value when the run never reaches the breaker (L35); `'blocked-needs-
  breaker'` (L38); `'blocked-invalid-contract'` (L71, L81); `'blocked-needs-human-review'` (L97); and
  otherwise, keyed off the breaker's exit status `b.status` (0/1/2): `'pass'` / `'breaker-fail'` /
  `'breaker-indeterminate'` (L103). **Load-bearing nuance, OBSERVED:** `breaker-invoke.mjs` itself
  exits `2` for BOTH an executed-but-inconclusive `BREAKER_INDETERMINATE` verdict AND a never-executed
  `INSTRUMENT-BROKEN` verdict (see next bullet), and `breaker-gate.mjs` exits with that same
  `b.status` unchanged (L89, L104). So `gate: 'breaker-indeterminate'` and exit code `2` are produced
  **identically** for both verdicts — neither can tell them apart. EARS-M1/M3 below therefore key off
  the **nested** `breaker.verdict` string in `breaker-gate.mjs`'s own JSON output (`bj`, carried
  through verbatim at L90/L104 as the `breaker` field), never off the top-level `gate` field or exit
  code.
- **`breaker-invoke.mjs`'s own exit codes** (OBSERVED, header comment L11-12 and code L60-68): `0` =
  printed verdict is exactly `BREAKER_PASS`; `1` = exactly `BREAKER_FAIL`; `2` = every other case
  (`INSTRUMENT-BROKEN`, `BREAKER_INDETERMINATE`, or the breaker process itself failing to run).
  `breaker-gate.mjs` passes this code straight through once it reaches the breaker (OBSERVED
  L89, L104) — so `breaker-gate.mjs`'s own exit code for an `INSTRUMENT-BROKEN` run is
  deterministically `2`, not "2 or whatever."

EARS-V0: THE SYSTEM SHALL continue enforcing exactly these key sets, method set, command sets and
limits; this contract does not add, remove, or rename any of them. A vector using a key, method, or
command outside these sets, or a batch/request count over these limits, fails the rule it violates,
classified as batch-level or per-vector per EARS-V1.

### 1.1 Contract section/heading parsing (behaviour 1)

- EARS-H1: THE SYSTEM SHALL recognize a markdown heading as the start of the QA-procedure section
  when the heading is level `##` or `###` and its text, after the leading `#` markers and
  whitespace, contains the phrase "QA procedure" (case-insensitive), regardless of any numeric or
  text prefix before it (e.g. `5.`, `5.2`) or any text after it on the same line.
- EARS-H2: THE SYSTEM SHALL recognize a markdown heading as the start of the invariants section when
  the heading is level `##` or `###` and its text contains, case-insensitively, either "External
  Observable Invariants" or the bare word "Invariants", with the same prefix/suffix tolerance as
  EARS-H1.
- EARS-H2b (duplicate-heading tiebreaker): WHEN a contract contains more than one heading matching
  EARS-H1's rule, or more than one matching EARS-H2's rule, THE SYSTEM SHALL use the first such
  heading in document order for that section and ignore every later match.
- EARS-H3: WHEN a recognized section heading opens at level N, THE SYSTEM SHALL end that section at
  the next heading whose level is ≤ N, and SHALL include any deeper heading (level > N) and its
  content as part of the section's body.
- EARS-H4: WHEN extracting a row of the invariants table, THE SYSTEM SHALL accept an id token of one
  or more letters/digits followed by a hyphen and one or more letters/digits/hyphens (e.g. `INV-A`,
  `EO-0`, `EO-1b`) in the first cell, SHALL strip a matching pair of leading/trailing `**` (markdown
  bold) around the whole first cell, and SHALL strip every trailing parenthetical annotation
  (`" (...)"`), repeating the strip until none remain, from the de-bolded cell, yielding the bare id
  (`**EO-6 (re-run)**` → `EO-6`; `EO-7 (a) (b)` → `EO-7`). IF only one side of the cell carries `**`
  (malformed/unmatched bold), THEN THE SYSTEM SHALL treat the cell as not bold-wrapped and leave the
  stray `**` characters in place before the parenthetical-stripping step.
- EARS-H4b (duplicate-id tiebreaker): WHEN two or more rows of the SAME invariants table yield the
  same bare id (EARS-H4) after stripping, THE SYSTEM SHALL use the FIRST such row in table order as
  that id's `expected` value and as the row EARS-V4 step 5's anchoring check matches against, and
  SHALL ignore every later row sharing that id.
- EARS-H5: WHEN splitting a table row into cells, THE SYSTEM SHALL scan the row's raw text left to
  right, treating a `|` character as a cell boundary only when BOTH (a) it is not immediately
  preceded by a backslash `\` (an escaped pipe is literal cell content, not a boundary), AND (b) an
  odd number of unescaped backtick (`` ` ``) characters have not been seen since the last cell
  boundary on this row (i.e. the position is not inside an open inline-code span). THE SYSTEM SHALL
  extract the invariant's `expected` value from the last cell produced by this scan, trimmed,
  independent of how many cells the row has in between.
- EARS-H6: IF, after extraction, the QA-procedure section text is empty (zero non-whitespace
  characters) OR the invariants list is empty, THEN THE SYSTEM SHALL NOT invoke the breaker command,
  and SHALL instead report a verdict of `INSTRUMENT-BROKEN` whose `reason` names which of the two
  (`qaProcedure`, `invariants`) is empty — naming BOTH by name when both are empty simultaneously
  (e.g. "qaProcedure and invariants are both empty"), never only the first one found — and lists
  every `##`/`###` heading line found in the contract, verbatim, in document order.
- EARS-H7 (backward compatibility): WHERE a contract uses the exact legacy headings `## QA
  procedure` / `## Invariants` and ids with the literal `INV-` prefix, THE SYSTEM SHALL extract the
  same `qaProcedure`/`invariants` value as before this change.
- EARS-H8 (DECIDED in scope, §4 D2): THE SYSTEM SHALL apply the same heading-matching rule as
  EARS-H2/EARS-H2b inside `contract-lint.mjs`'s declared-invariant-id extraction, so that running
  `contract-lint.mjs` against
  `plugins/quality-kernel/scripts/fixtures/qk-breaker-robust-input/contracts/contract-1045-shape.md`
  and its sibling acceptance file no longer exits `2` with the stdout message `"no invariants
  declared in the contract (## Invariants table)"` (OBSERVED current behavior: `contract-lint.mjs:71,76`).
- EARS-H9 (DECIDED in scope, §4 D2): THE SYSTEM SHALL apply the same empty-section guard as EARS-H6
  inside `gstack-breaker.mjs`'s `runBreaker()` (which calls `buildBlindInput()` directly,
  `gstack-breaker.mjs:56`): WHEN the extracted `qaProcedure` is empty OR `invariants` is empty, THE
  SYSTEM SHALL return `INSTRUMENT-BROKEN` (reason naming the empty section(s) and the headings found)
  instead of proceeding to validate/run the vectors file.

### 1.2 Vector validation (behaviour 2)

- EARS-V1: THE SYSTEM SHALL classify every vector-validation rule as either batch-level (applies to
  the vectors array as a whole: not an array, empty, more than 30 entries, or an unparseable
  `systemUrl`) or per-vector (applies to one vector's shape, HTTP/UI fields, or its anchoring to a
  declared contract invariant id).
- EARS-V2: WHEN a batch-level rule is violated, THE SYSTEM SHALL report `INSTRUMENT-BROKEN` for the
  whole run and SHALL execute no vector — unchanged from today.
- EARS-V3: WHEN one or more vectors violate only per-vector rules while the batch-level rules hold,
  THE SYSTEM SHALL exclude exactly those vectors from execution, SHALL execute the remaining vectors,
  and SHALL report each excluded vector's zero-based index (position in the original input array)
  and the reason it was excluded in a top-level `dropped` array field (a sibling of `verdict`,
  `executed`, and `vectors` in the breaker's printed JSON), each entry shaped exactly
  `{ index: <number>, reason: <string> }` — this is the one required output shape; no other field
  name or nesting satisfies this criterion.
- EARS-V4: THE SYSTEM SHALL evaluate a vector's per-vector rules in this fixed order, stopping at
  (and reporting only) the first failing rule: (1) object shape and unknown keys (EARS-V0's key
  sets), (2) exactly one of `http`/`ui` present, (3) the type-specific HTTP or UI rules (EARS-V0's
  method/command sets, origin checks, EARS-V6/V6a's Host rule), (4) an HTTP vector with no `expect`
  when the `--probe` CLI argument (§1.0's "probe command") was not given, (5) anchoring to a declared
  contract invariant id — so one dropped vector produces exactly one `{index, reason}` entry.
- EARS-V5 (Decided by the human (Adrian), 2026-11-08, §4 D1): THE SYSTEM SHALL compute the run's
  verdict from the executed vectors' results only (per EARS-V9); excluded vectors SHALL NOT count
  toward the ≥3-executed rule and SHALL NOT, by themselves, make the run `INSTRUMENT-BROKEN`, EXCEPT
  that EARS-V9's zero-executed rule still applies when excluding those vectors drives the executed
  count to 0 — i.e. if every vector in the batch is excluded by a per-vector rule, the run IS
  `INSTRUMENT-BROKEN` (via EARS-V9), and that outcome is not a violation of this criterion.
- EARS-V6 (Host-header decision — see §4 for the security reasoning): WHEN an HTTP vector's request
  sets a `Host` header, and the `systemUrl`'s hostname is NEITHER an IP literal NOR a single label
  (see EARS-V6a for that case), THE SYSTEM SHALL accept the header as per-vector-valid if and only if
  its value, with any trailing `:<port>` removed, is either (a) exactly equal to the `systemUrl`'s
  own hostname, or (b) a hostname that ends with `.<registrable-domain>`, where
  `<registrable-domain>` is the last two dot-separated labels of the `systemUrl`'s hostname. Any
  other `Host` value is a per-vector validation failure, excluded and reported per EARS-V3/V4.
- EARS-V6a (IP-literal / single-label exception — closes the "evil.0.1" class of bug): WHEN the
  `systemUrl`'s hostname (a) matches an IPv4 dotted-quad pattern (`^\d{1,3}(\.\d{1,3}){3}$`), or (b)
  is wrapped in square brackets the way the WHATWG `URL` parser's `.hostname` always renders an IPv6
  literal (matches `^\[.*\]$`, e.g. `[::1]`, `[2001:db8::1]`), or (c) contains zero dots (a single
  label, e.g. `localhost`), THE SYSTEM SHALL
  NOT apply EARS-V6's registrable-domain-suffix widening; THE SYSTEM SHALL instead accept a `Host`
  header if and only if its value (port stripped) is EXACTLY equal to that hostname. (Rationale: for
  `systemUrl = http://127.0.0.1:9`, the naive last-two-labels rule would yield the suffix `.0.1`,
  wrongly accepting `Host: evil.0.1` — exactly the host-impersonation EARS-V6/§4 exists to prevent. A
  normal 2-label domain, e.g. `example.com`, is unaffected: it has one dot and is not an IP literal,
  so EARS-V6's suffix rule still applies and still allows `sub.example.com`.)
- EARS-V7: THE SYSTEM SHALL keep rejecting, as a per-vector rule, every other header/path/UI
  constraint already enforced today (absolute path on the system's origin, the allowed HTTP methods
  of EARS-V0, no body on GET/HEAD, the allowed UI step/assert commands of EARS-V0, a `goto` target on
  the system's origin).
- EARS-V8 (falsifiable prompt requirement): `breaker/vector-author.md` SHALL contain, checkable by a
  text search: (a) the word "Host" and the word "registrable" within the same paragraph
  (case-insensitive is fine for locating the words); (b) the literal substring "only that vector"
  (e.g. "...that one vector is dropped; only that vector is excluded, not the whole batch") — a
  search for this exact phrase, not a subjective reading, is the pass/fail check; (c) the EARS-V0
  lists, with the six HTTP method names and the UI step/assert command names appearing SOMEWHERE in
  the prompt text (case-insensitive search locates them), AND, at least once each, in the SAME CASE
  as the production constants (`GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`; `goto`, `click`;
  `text`, `is`, `attrs`) — the case-insensitive search only locates the words; a case-sensitive
  re-check of that same located text confirms at least one occurrence matches production's casing
  exactly.
- EARS-V9 (the ≥3-executed rule, OBSERVED `gstack-breaker.mjs:27,30-37`, unchanged by this contract —
  stated here as its own criterion rather than left implicit): THE SYSTEM SHALL decide the run's
  verdict from the executed vectors' results as: zero executed → `INSTRUMENT-BROKEN`; at least one
  executed result is `VIOLATED` → `BREAKER_FAIL`; otherwise, if at least 3 executed results are
  `HOLDS` and every executed result is `HOLDS` → `BREAKER_PASS`; otherwise → `BREAKER_INDETERMINATE`.

### 1.3 Breaker-not-executed record (behaviour 3)

- EARS-M1: WHEN `breaker-gate.mjs` obtains a breaker verdict (the nested `breaker.verdict` string,
  per §1.0) equal to `INSTRUMENT-BROKEN`, THE SYSTEM SHALL create `<repo>/.quality-kernel/` if it
  does not exist, and SHALL write a JSON record **atomically**: write to a temporary file in
  `<repo>/.quality-kernel/` named `breaker-not-executed.json.<pid>-<random-hex>.tmp`, where `<pid>`
  is this process's own process id and `<random-hex>` is a freshly generated random hex string of AT
  LEAST 8 hex characters (e.g. `crypto.randomBytes(4).toString('hex')`) — i.e. a name that is unique
  per process invocation, so two `breaker-gate.mjs` processes running concurrently against the same
  `--repo` never write to the same temp path — then rename that
  temporary file over the final path `<repo>/.quality-kernel/breaker-not-executed.json` (never write
  the final path in place). Schema: `{ schemaVersion: 1, ts: <ISO-8601 string>, verdict:
  "INSTRUMENT-BROKEN", reason: <string, verbatim from the breaker's verdict>, contract: <the
  --contract path as given>, executed: <the verdict's executed count> }`.
- EARS-M2: THE SYSTEM SHALL write this record in addition to, never instead of, the existing `gate`
  field / exit code behavior defined in §1.0 — default-deny is unchanged by this requirement.
- EARS-M3: WHEN `breaker-gate.mjs` obtains a breaker verdict (nested `breaker.verdict`) equal to
  `BREAKER_PASS`, `BREAKER_FAIL`, or `BREAKER_INDETERMINATE` (i.e. any verdict other than
  `INSTRUMENT-BROKEN` — the breaker DID execute, even if indeterminately; this is NOT the same test
  as "`gate` is not `'breaker-indeterminate'`", since per §1.0 the `gate` field and exit code alone
  cannot distinguish `BREAKER_INDETERMINATE` from `INSTRUMENT-BROKEN`), THE SYSTEM SHALL remove
  `<repo>/.quality-kernel/breaker-not-executed.json` if it exists.
- EARS-M6 (breaker process did not run; decided by Adrian 2026-11-08): IF `breaker-invoke.mjs`
  cannot obtain a verdict because the breaker command could not be spawned, produced no exit status,
  or exited non-zero, THEN THE SYSTEM SHALL print the verdict `INSTRUMENT-BROKEN` (not
  `BREAKER_INDETERMINATE`) with a reason naming the failure, exit `2`, so that `breaker-gate.mjs`
  writes the breaker-not-executed record per EARS-M1 instead of clearing it per EARS-M3. Argument
  errors (missing `--contract`/`--breaker`/`--probe`/`--url`, contract file not found) and a
  breaker that ran and printed unparseable output keep their current verdict and exit code.
- EARS-M4: THE SYSTEM SHALL leave `.quality-kernel/breaker-not-executed.json` as an unversioned
  runtime artifact (same category as `.quality-kernel/evidence-ledger.jsonl`) — it is not read as
  part of the gate's pass/fail decision, only as a durable record a report can read after the fact.
- EARS-M5 (write/remove failure must not weaken default-deny): IF creating the directory, writing the
  temporary file, renaming it, or removing the record fails for any reason (permission denied, disk
  full, read-only filesystem), THEN THE SYSTEM SHALL catch that failure, report it on stderr, and
  SHALL NOT let it change, delay, or prevent the gate's existing `gate` field or exit code.

## 2. Gherkin scenarios

```gherkin
Feature: Blind breaker accepts the specifier's real contract shape and degrades per-vector, not per-batch

  Background:
    Given the contract file is exactly
      "plugins/quality-kernel/scripts/fixtures/qk-breaker-robust-input/contracts/contract-1045-shape.md"
    And its sibling acceptance suite is
      "plugins/quality-kernel/scripts/fixtures/qk-breaker-robust-input/acceptance/contract-1045-shape.test.mjs"

  Scenario: Numbered, parenthetical headings are parsed instead of producing an empty blind input
    When breaker-invoke.mjs builds the blind input from the Background contract file
    Then qaProcedure is non-empty and contains "Navigate to http://example.com/admin/login/"
    And invariants is [{ id: "EO-0", expected: "RED" }, { id: "EO-6", expected: "not yet probeable" }]

  Scenario: A contract with the legacy exact headings and INV- ids still parses the same way
    Given the contract file is exactly "plugins/quality-kernel/scripts/fixtures/m2/contracts/example.md"
    When breaker-invoke.mjs builds the blind input from that file
    Then qaProcedure contains "Call add(2, 3)"
    And invariants equals [{ id: "INV-ADD-1", expected: "5" }, { id: "INV-ADD-2", expected: "400" }]

  Scenario: A probe-command cell containing a literal pipe inside backticks does not shift the expected column
    Given the contract file is exactly the Background contract file (its EO-6 row's probe-command cell contains a literal "|" inside backticks)
    When breaker-invoke.mjs builds the blind input from that file
    Then invariants includes { id: "EO-6", expected: "not yet probeable" }
    And the extracted expected value for EO-6 is NOT a fragment of the probe-command cell

  Scenario: A second, later heading that ALSO matches EARS-H2's pattern never overrides the first match (EARS-H2b)
    Given a contract file "dup.md" with heading "## 6. External Observable Invariants" and table row "| INV-A | d | 1 |"
    And a later heading "## 9. Invariants (changelog)" — itself matching EARS-H2's bare-word rule, not just prose — with its OWN table row "| INV-Z | changelog-only | 99 |"
    When breaker-invoke.mjs builds the blind input from "dup.md"
    Then invariants equals [{ id: "INV-A", expected: "1" }]
    And the second heading's table (id "INV-Z", expected "99") never appears anywhere in the result

  Scenario: A duplicate invariant id within the SAME table uses the first row, the second is ignored (EARS-H4b)
    Given a contract file "dup-id.md" with one invariants table containing two rows for the same id: "| INV-A | first | 1 |" then later "| INV-A | second | 2 |"
    When breaker-invoke.mjs builds the blind input from "dup-id.md"
    Then invariants equals [{ id: "INV-A", expected: "1" }]
    And no entry with expected "2" appears anywhere in the result

  Scenario: An empty QA-procedure section fails closed before the breaker is ever invoked, with exit code 2
    Given a copy of the Background contract file with its QA-procedure section's body blanked out (heading kept, text removed)
    And the relative file "./breaker-invoked.flag" does not exist
    When breaker-invoke.mjs is run with --contract <that copy> --probe "true" --url "http://example.com" --breaker "node -e \"require('fs').appendFileSync('./breaker-invoked.flag','x')\""
    Then the process exits exactly 2
    And the printed verdict is "INSTRUMENT-BROKEN"
    And its reason contains "qaProcedure" and "## 5. End-to-end QA procedure"
    And "./breaker-invoked.flag" still does not exist (the breaker command never ran)

  Scenario: An empty invariants table fails closed the same way, with exit code 2
    Given a copy of the Background contract file with its invariants table body blanked out (heading kept)
    And the relative file "./breaker-invoked.flag" does not exist
    When breaker-invoke.mjs is run with --contract <that copy> --probe "true" --url "http://example.com" --breaker "node -e \"require('fs').appendFileSync('./breaker-invoked.flag','x')\""
    Then the process exits exactly 2
    And the printed verdict is "INSTRUMENT-BROKEN"
    And its reason contains "invariants" and "## 6. External Observable Invariants"
    And "./breaker-invoked.flag" still does not exist (the breaker command never ran)

  Scenario Outline: One per-vector-invalid vector is dropped and reported, the rest still run
    Given 4 vectors anchored to the Background contract's declared id "EO-0", all otherwise valid HTTP vectors
    And vector at index 2 is modified to: "<bad-vector>"
    When runVectors is called with these 4 vectors against systemUrl "http://example.com"
    Then the result's executed count is 3
    And the result's dropped vectors include { index: 2, reason contains "<reason-substring>" }
    And the verdict is "BREAKER_PASS"

    Examples:
      | bad-vector                                              | reason-substring |
      | requests[0].headers = { host: "evil.example.net" }      | host             |
      | ui.steps = [{ cmd: "goto", args: ["http://other.example.com"] }] | origin   |
      | invariant = "EO-UNDECLARED"                             | anchored         |

  Scenario: All vectors are per-vector-invalid, so zero execute — the run IS INSTRUMENT-BROKEN (EARS-V5/V9, Decided by the human (Adrian), 2026-11-08, §4 D1)
    Given 4 vectors anchored to the Background contract's declared id "EO-0", each with requests[0].headers = { host: "evil.example.net" }
    When runVectors is called with these 4 vectors against systemUrl "http://example.com"
    Then the result's executed count is 0
    And the result's dropped vectors include all 4 indices, each reason containing "host"
    And the verdict is "INSTRUMENT-BROKEN"

  Scenario: A Host header matching the system's own registrable domain is accepted, not dropped
    Given systemUrl is "https://mbvs-server-development.example.com"
    And an HTTP vector anchored to "EO-0" sets requests[0].headers.host = "develop.mbvs-server-development.example.com"
    And 2 other valid, anchored vectors
    When runVectors is called with these 3 vectors
    Then the result's executed count is 3
    And no vector is dropped
    And the verdict is "BREAKER_PASS" given all 3 results are "HOLDS"

  Scenario: A Host header outside the system's registrable domain is dropped, not batch-fatal
    Given systemUrl is "https://mbvs-server-development.example.com"
    And an HTTP vector anchored to "EO-0" sets requests[0].headers.host = "mbvs-server-development.example.com.evil.net"
    And 3 other valid, anchored vectors
    When runVectors is called with these 4 vectors
    Then the result's executed count is 3
    And the dropped vectors include { index: 0, reason contains "host" }
    And the verdict is "BREAKER_PASS" given the 3 remaining results are "HOLDS"

  Scenario: An IP-literal systemUrl requires an exact Host match — no registrable-domain widening (EARS-V6a)
    Given systemUrl is "http://127.0.0.1:9"
    And an HTTP vector anchored to "EO-0" sets requests[0].headers.host = "evil.0.1"
    And 3 other valid, anchored vectors with no Host header
    When runVectors is called with these 4 vectors
    Then the dropped vectors include { index: 0, reason contains "host" }
    And the verdict is "BREAKER_PASS" given the 3 remaining results are "HOLDS"

  Scenario: A single-label systemUrl ("localhost") requires an exact Host match too (EARS-V6a)
    Given systemUrl is "http://localhost:9"
    And an HTTP vector anchored to "EO-0" sets requests[0].headers.host = "evil.localhost"
    And 3 other valid, anchored vectors with no Host header
    When runVectors is called with these 4 vectors
    Then the dropped vectors include { index: 0, reason contains "host" }

  Scenario: breaker/vector-author.md satisfies EARS-V8's three falsifiable prompt requirements
    Given the file "plugins/quality-kernel/scripts/fixtures/qk-breaker-robust-input/vector-author-prompt.test.mjs" exists (reads breaker/vector-author.md by a relative path)
    When it is run with "node --test plugins/quality-kernel/scripts/fixtures/qk-breaker-robust-input/vector-author-prompt.test.mjs"
    Then all 3 tests pass (0 fail)

  Scenario: A batch-level problem still rejects the whole run
    When runVectors is called with 31 otherwise-valid, anchored vectors
    Then the verdict is "INSTRUMENT-BROKEN"
    And executed is 0

  Scenario: The committed numbered-heading fixture, run through breaker-gate.mjs end-to-end (contract-lint precondition included), reaches breaker-invoke and the stub's vectors execute (EARS-H8, end-to-end)
    Given a scratch repo "<repo>" built per §3 step 6's recipe (a critical-surface change, so qk-gate exits 3 and the breaker is required)
    And a pass-through stub breaker command that reads the blind input on stdin and prints {"verdict":"BREAKER_PASS","executed":3,"vectors":[1,2,3]} when it observes a non-empty qaProcedure AND non-empty invariants, else {"verdict":"INSTRUMENT-BROKEN","executed":0,"vectors":[]}
    When breaker-gate.mjs is run with --repo "<repo>" --base <base> --head <head> --breaker "<stub>" --contract "plugins/quality-kernel/scripts/fixtures/qk-breaker-robust-input/contracts/contract-1045-shape.md" --probe true --url http://example.com
    Then the printed JSON's top-level "gate" is NOT "blocked-invalid-contract"
    And "contractLint.ok" is true and "contractLint.declared" is non-empty
    And the nested "breaker.verdict" is "BREAKER_PASS" and "breaker.executed" is 3 and "breaker.vectors" is [1, 2, 3]
    And the process exits exactly 0
    (TODAY, pre-fix, OBSERVED by running this exact command against this worktree: gate is
     "blocked-invalid-contract", breaker is null, contractLint.declared is [], exit code 3 —
     reproducing §0's exact root-caused failure)

  Scenario: An INSTRUMENT-BROKEN verdict writes the breaker-not-executed record and exits exactly 2
    Given a scratch repo "<repo>" with no ".quality-kernel/breaker-not-executed.json"
    And a stub breaker command that always prints {"verdict":"INSTRUMENT-BROKEN","reason":"vectors must be a non-empty array","executed":0,"vectors":[]}
    When breaker-gate.mjs is run with --repo "<repo>" --base <merge-base> --head <head> --breaker "<stub>" --contract "<contract>" --probe "true" --url "http://example.com"
    Then "<repo>/.quality-kernel/breaker-not-executed.json" exists
    And its JSON has schemaVersion 1, verdict "INSTRUMENT-BROKEN", reason "vectors must be a non-empty array", contract "<contract>", executed 0
    And the process exits EXACTLY 2 (per §1.0's cited breaker-invoke.mjs/breaker-gate.mjs exit-code mapping)

  Scenario: A later BREAKER_INDETERMINATE verdict also clears the stale not-executed record
    Given "<repo>/.quality-kernel/breaker-not-executed.json" exists from a prior broken run
    And a stub breaker command that now prints {"verdict":"BREAKER_INDETERMINATE","executed":2,"vectors":[...2 HOLDS...]}
    When breaker-gate.mjs is run again with the same --repo
    Then "<repo>/.quality-kernel/breaker-not-executed.json" no longer exists
    (note: breaker-gate.mjs's own exit code here is still 2 and gate is still "breaker-indeterminate" —
     per §1.0 that field cannot tell this case apart from INSTRUMENT-BROKEN; the removal decision in
     EARS-M3 is made from the nested breaker.verdict field, not from gate/exit code)

  Scenario: A later passing breaker clears the stale not-executed record (re-run invariant)
    Given "<repo>/.quality-kernel/breaker-not-executed.json" exists from a prior broken run
    And a stub breaker command that now prints {"verdict":"BREAKER_PASS","executed":3,"vectors":[...3 HOLDS...]}
    When breaker-gate.mjs is run again with the same --repo
    Then "<repo>/.quality-kernel/breaker-not-executed.json" no longer exists
    And the gate's exit code is 0 (modulo the referee/contract-lint gates)

  Scenario: A write failure writing the not-executed record never changes the gate's exit code
    Given "<repo>/.quality-kernel" exists but is not writable (e.g. chmod 555, run as a non-root user)
    And a stub breaker command that prints {"verdict":"INSTRUMENT-BROKEN","reason":"x","executed":0,"vectors":[]}
    When breaker-gate.mjs is run with --repo "<repo>" ...
    Then the process exits exactly 2, the same code as the writable-directory case
    And a message naming the write failure appears on stderr
    And the process does not throw an uncaught exception

  Scenario: A stale or malformed not-executed record never affects the gate's pass/fail decision (EARS-M4)
    Given "<repo>/.quality-kernel/breaker-not-executed.json" is pre-seeded with the malformed content "{not valid json"
    And a stub breaker command that prints {"verdict":"BREAKER_PASS","executed":3,"vectors":[...3 HOLDS...]}
    When breaker-gate.mjs is run with --repo "<repo>" --base <merge-base> --head <head> --breaker "<stub>" --contract "<contract>" --probe "true" --url "http://example.com"
    Then the process exits exactly 0, unaffected by the file's prior malformed content
    And "<repo>/.quality-kernel/breaker-not-executed.json" no longer exists (removed per EARS-M3)

  Scenario: A crash immediately after the temp-file write, before the rename, leaves no partial record
    Given a prior complete "<repo>/.quality-kernel/breaker-not-executed.json" (or none at all)
    When the write is interrupted after the uniquely-named temporary file is written but before the rename completes
    Then "<repo>/.quality-kernel/breaker-not-executed.json" is either absent, or exactly its prior
      complete contents, or the new complete contents — never truncated or invalid JSON

  Scenario: Two concurrent breaker-gate.mjs runs against the same repo never collide on the same temp file
    Given the same "<repo>" and a stub breaker command that always prints {"verdict":"INSTRUMENT-BROKEN","reason":"x","executed":0,"vectors":[]}
    When both of these are launched from the same shell, backgrounded, then waited on together:
      """
      node plugins/quality-kernel/scripts/breaker-gate.mjs --repo "<repo>" --base <base> --head <head> --breaker "<stub>" --contract "<contract>" --probe true --url http://example.com & PID1=$!
      node plugins/quality-kernel/scripts/breaker-gate.mjs --repo "<repo>" --base <base> --head <head> --breaker "<stub>" --contract "<contract>" --probe true --url http://example.com & PID2=$!
      wait "$PID1" "$PID2"
      """
    Then each process used a temp file name containing its own pid and random suffix (no collision, by construction, since the two pids differ)
    And "<repo>/.quality-kernel/breaker-not-executed.json" ends up as one process's complete, valid JSON record — never a byte-interleaved mix of both
```

## External Observable Invariants

Normative (in scope for `breaker-invoke.mjs`, `vector-breaker.mjs`, `breaker-claude.mjs`, `breaker-gate.mjs`, `contract-lint.mjs`, and `gstack-breaker.mjs` — all six, per §4 D2):

| ID | Predicate | Probe | Expected |
|---|---|---|---|
| INV-1 | A numbered/parenthetical heading (`## 5. End-to-end QA procedure (UI-only …)`, `## 6. External Observable Invariants`) is recognized and its section content extracted non-empty. | `node plugins/quality-kernel/scripts/breaker-invoke.mjs --contract plugins/quality-kernel/scripts/fixtures/qk-breaker-robust-input/contracts/contract-1045-shape.md --probe true --url http://example.com --breaker "node -e \"let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const i=JSON.parse(s);console.log(JSON.stringify({verdict:(i.qaProcedure&&i.invariants&&i.invariants.length?'BREAKER_PASS':'INSTRUMENT-BROKEN'),executed:3,vectors:[1,2,3]}))})\""` | printed verdict is `BREAKER_PASS` (meaning the stub observed non-empty `qaProcedure`/`invariants`); process exits `0`. |
| INV-2 | A legacy contract (`## QA procedure`, `## Invariants`, `INV-` ids) still parses identically to before this change. | same CLI against `plugins/quality-kernel/scripts/fixtures/m2/contracts/example.md` | printed verdict is `BREAKER_PASS`; process exits `0`. |
| INV-3 | A bold, parenthetical, non-`INV-`-prefixed id (`**EO-6 (re-run)**`) is normalized to its bare id `EO-6`. | `node -e` script loading `buildBlindInput` from `breaker-invoke.mjs` against `contract-1045-shape.md` and printing `JSON.stringify(invariants)` to stdout | stdout includes `{"id":"EO-6",...}`. |
| INV-4 | A literal `\|` inside backticks in a probe-command cell does not shift which cell is read as `expected`. | same script | the `EO-6` entry's `expected` is `"not yet probeable"`, not a fragment containing `` ` `` or `jq`. |
| INV-5 | An empty QA-procedure section fails closed with the headings found, before the breaker command runs, exiting exactly 2. | run `breaker-invoke.mjs` against a copy of `contract-1045-shape.md` with an emptied QA-procedure body, `--breaker "node -e \"require('fs').appendFileSync('./breaker-invoked.flag','x')\""` | process exit code is `2`; printed verdict is `INSTRUMENT-BROKEN`; `./breaker-invoked.flag` does not exist (the breaker command never ran). |
| INV-6 | An empty invariants table fails closed the same way. | same, with an emptied invariants table body | process exit code is `2`; printed verdict is `INSTRUMENT-BROKEN`; `./breaker-invoked.flag` does not exist. |
| INV-7 | A `Host` header on the system's own registrable domain is accepted; one on an unrelated domain is dropped and reported, without rejecting the batch. | `node plugins/quality-kernel/scripts/breaker-invoke.mjs --contract contract-1045-shape.md --probe true --url http://example.com --breaker "node plugins/quality-kernel/scripts/fixtures/qk-breaker-robust-input/vector-stub.mjs"` | printed JSON's top-level `dropped` array equals exactly `[{"index":0,"reason":<a string containing "host">}]` (EARS-V3's pinned shape); `executed` is `3`; overall verdict `BREAKER_PASS`. |
| INV-8 | A batch-level problem (31+ vectors, or a non-array) still rejects the whole run. | a variant of `vector-stub.mjs` (same relative import) feeding 31 vectors | printed verdict is `INSTRUMENT-BROKEN`, `executed: 0`; process exits `2`. |
| INV-9 | An `INSTRUMENT-BROKEN` breaker verdict writes `.quality-kernel/breaker-not-executed.json` with the documented schema, and the gate process exits exactly 2. | `node plugins/quality-kernel/scripts/breaker-gate.mjs --repo <scratch-repo, built per §3 step 6> --base <base> --head <head> --breaker "<stub always printing INSTRUMENT-BROKEN>" --contract contract-1045-shape.md --probe true --url http://example.com; echo "exit=$?"; cat <scratch-repo>/.quality-kernel/breaker-not-executed.json` | `exit=2`; file exists; `jq .verdict` = `"INSTRUMENT-BROKEN"`; `jq .schemaVersion` = `1`. |
| INV-10 (re-run) | Running the gate again with a breaker that now executes (PASS, FAIL, or INDETERMINATE) removes the stale record, regardless of what `gate`/exit-code say. | re-run the same command with a stub printing each of `BREAKER_PASS`/`BREAKER_FAIL`/`BREAKER_INDETERMINATE` in turn, checking the file between runs | file is absent after each of the three re-runs. |
| INV-11 (re-run / crash) | A write interrupted mid-way never leaves a truncated file; a write failure never changes the gate's exit code. | as a non-root user, `chmod 555` the `.quality-kernel` dir before running the gate with an `INSTRUMENT-BROKEN` stub; compare exit code to a writable-dir run | exit code identical (`2`) in both runs; stderr names the write failure in the read-only run; no stack trace. |
| INV-12 | A later heading that ALSO matches EARS-H2's pattern (not merely prose containing the word) never overrides the first matching section's table. | `breaker-invoke.mjs` blind-input dump against the Gherkin "dup.md" fixture: heading "## 6. External Observable Invariants" + table `[INV-A/1]`, and a LATER, genuinely matching heading "## 9. Invariants (changelog)" + its own different table `[INV-Z/99]` | extracted invariants equal exactly `[{"id":"INV-A","expected":"1"}]`; the second heading's table (`INV-Z`/`99`) is never read or merged in. |
| INV-13 (EARS-V8) | `breaker/vector-author.md` contains the three falsifiable substrings EARS-V8 requires. | `node --test plugins/quality-kernel/scripts/fixtures/qk-breaker-robust-input/vector-author-prompt.test.mjs` | all 3 tests pass, 0 fail. TODAY (pre-fix, OBSERVED): tests (b) and (c) fail. |
| INV-14 (EARS-H8) | `contract-lint.mjs` counts the numbered-heading fixture's invariant table as "declared". | `node plugins/quality-kernel/scripts/contract-lint.mjs --contract plugins/quality-kernel/scripts/fixtures/qk-breaker-robust-input/contracts/contract-1045-shape.md --acceptance plugins/quality-kernel/scripts/fixtures/qk-breaker-robust-input/acceptance/contract-1045-shape.test.mjs; echo "exit=$?"` | TODAY (pre-fix, OBSERVED): `exit=2`, stdout `{"ok":false,"error":"no invariants declared in the contract (## Invariants table)"}`. AFTER EARS-H8: `exit=0`, stdout `{"ok":true,...}`. |
| INV-15 (EARS-H9) | `gstack-breaker.mjs`'s `runBreaker()` rejects an empty `qaProcedure`/`invariants` the same way `breaker-invoke.mjs` does. | `node plugins/quality-kernel/scripts/gstack-breaker.mjs --contract <a copy of contract-1045-shape.md with its QA-procedure body emptied> --url http://example.com --vectors <any vectors.json>` | printed verdict is `INSTRUMENT-BROKEN`, reason names the empty section. TODAY (pre-fix): proceeds to validate vectors instead. |
| INV-16 (EARS-H8, end-to-end) | The committed numbered-heading fixture, run through `breaker-gate.mjs` exactly as production wires it (contract-lint precondition, THEN `breaker-invoke.mjs`), reaches the breaker instead of being blocked at `blocked-invalid-contract`. | Build a scratch repo per §3 step 6's critical-surface recipe; run `node plugins/quality-kernel/scripts/breaker-gate.mjs --repo <repo> --base <base> --head <head> --breaker "node -e \"let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const i=JSON.parse(s);console.log(JSON.stringify({verdict:(i.qaProcedure&&i.invariants&&i.invariants.length?'BREAKER_PASS':'INSTRUMENT-BROKEN'),executed:3,vectors:[1,2,3]}))})\"" --contract plugins/quality-kernel/scripts/fixtures/qk-breaker-robust-input/contracts/contract-1045-shape.md --probe true --url http://example.com` | `gate` is NOT `"blocked-invalid-contract"`; `contractLint.ok` is `true`, `contractLint.declared` non-empty; nested `breaker.verdict` is `"BREAKER_PASS"`, `breaker.executed` is `3`; exit code `0`. TODAY (pre-fix, OBSERVED by running this exact command against this worktree): `gate:"blocked-invalid-contract"`, `breaker:null`, `contractLint.declared:[]`, exit `3`. |
| INV-17 (EARS-H4b) | A contract whose SAME invariants table declares the same id twice with different `expected` values uses only the FIRST row's value; the second is never read. | `node -e` script (or the equivalent CLI dump) building the blind input from a fixture with table rows `| INV-A | first | 1 |` then `| INV-A | second | 2 |` | extracted invariants equal exactly `[{"id":"INV-A","expected":"1"}]`; no entry with `expected:"2"` appears. |

## 3. QA procedure

This feature has no browser UI: its only external interface is the command line, so "UI-only" here
means driving the **shipped CLI entry points** (`breaker-invoke.mjs`, `breaker-gate.mjs`,
`contract-lint.mjs`) exactly as production does, reading only their stdout/exit code/files. Every
path below is relative to the plugin's repo root (this worktree's `plugins/quality-kernel/`) and
every file referenced is already present on disk (§0.1) — no step depends on any path outside this
repo.

1. The fixture already exists at
   `plugins/quality-kernel/scripts/fixtures/qk-breaker-robust-input/contracts/contract-1045-shape.md`
   — numbered headings, `## External Observable Invariants`, bold ids `**EO-0**`/`**EO-6 (re-run)**`,
   and a probe-command cell containing a literal pipe. No separate setup step needed.
2. Run `node plugins/quality-kernel/scripts/breaker-invoke.mjs --contract
   plugins/quality-kernel/scripts/fixtures/qk-breaker-robust-input/contracts/contract-1045-shape.md
   --probe "true" --url "http://example.com" --breaker "node -e \"let
   s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>console.log(JSON.stringify({verdict:'BREAKER_PASS',executed:3,vectors:[1,2,3]})))\""`.
   Confirm the printed JSON is NOT `{"verdict":"INSTRUMENT-BROKEN","reason":"vectors must be a
   non-empty array",...}` and the process exits `0`.
3. Copy the fixture, blank out its QA-procedure section's body (keep the `## 5. …` heading, empty
   the text under it). Re-run step 2's command against the copy. Confirm: exit code exactly `2`,
   printed `verdict` is `"INSTRUMENT-BROKEN"`, `reason` names `qaProcedure` and lists the contract's
   headings.
4. Run `node plugins/quality-kernel/scripts/breaker-invoke.mjs --contract
   plugins/quality-kernel/scripts/fixtures/qk-breaker-robust-input/contracts/contract-1045-shape.md
   --probe "true" --url "http://example.com" --breaker "node
   plugins/quality-kernel/scripts/fixtures/qk-breaker-robust-input/vector-stub.mjs"`. This stub
   (already present, §0.1) is an ordinary CLI invocation that imports `vector-breaker.mjs` by a
   relative path internally — the operator never imports it directly. Its 4 hardcoded vectors are
   anchored to the fixture's own first declared id (`EO-0`); vector 0 sets `Host: evil.example.net`.
   Confirm: `executed: 3`, a dropped/invalid entry naming index 0 with a reason containing "host",
   and overall verdict `BREAKER_PASS`.
5. Edit a copy of the stub (same relative import) so vector 0's `host` value is
   `"sub.example.com"` (a subdomain of the fixture's intended system under test,
   `http://example.com`) instead of `evil.example.net`. Re-run step 4's command pointing `--breaker`
   at the edited copy. Confirm that vector is NOT dropped (`executed: 4`).
6. Build a scratch repo exactly like the existing test fixture does (OBSERVED
   `breaker-gate.test.mjs:15-28`, `criticalRepo()`):
   ```sh
   TMP=$(mktemp -d)
   git -C "$TMP" init -q
   git -C "$TMP" config user.email t@t; git -C "$TMP" config user.name t
   mkdir -p "$TMP/.quality-kernel" "$TMP/src/auth"
   printf '%s' '{"verify":"node --test x.test.mjs","productionGlobs":["src/**"]}' > "$TMP/.quality-kernel/tools.json"
   printf '%s' '{"criticalGlobs":["**/auth/**"],"safeGlobs":["**/*.md"]}' > "$TMP/.quality-kernel/critical-surface.json"
   printf '%s' "import { test } from 'node:test'; import a from 'node:assert'; test('ok', () => a.ok(true));" > "$TMP/x.test.mjs"
   printf '%s' 'export const x = 1;' > "$TMP/src/auth/thing.ts"
   git -C "$TMP" add -A; git -C "$TMP" commit -qm base
   BASE=$(git -C "$TMP" rev-parse HEAD)
   printf '%s' 'export const x = 2;' > "$TMP/src/auth/thing.ts"
   git -C "$TMP" add -A; git -C "$TMP" commit -qm change
   HEAD_SHA=$(git -C "$TMP" rev-parse HEAD)
   cat > "$TMP/../qk-broken-stub.mjs" <<'EOF'
   let s=''; process.stdin.on('data', d => s += d);
   process.stdin.on('end', () => console.log(JSON.stringify({ verdict: 'INSTRUMENT-BROKEN', reason: 'vectors must be a non-empty array', executed: 0, vectors: [] })));
   EOF
   node plugins/quality-kernel/scripts/breaker-gate.mjs --repo "$TMP" --base "$BASE" --head "$HEAD_SHA" \
     --breaker "node $TMP/../qk-broken-stub.mjs" \
     --contract plugins/quality-kernel/scripts/fixtures/m2/contracts/example.md \
     --probe true --url http://example.com
   echo "exit=$?"
   cat "$TMP/.quality-kernel/breaker-not-executed.json"
   ```
   (reuses the existing `fixtures/m2/contracts/example.md` + its acceptance sibling, since this step
   tests the write/remove behavior, not heading parsing — already-fixed/legacy shape is the right
   control here.) Confirm `exit=2`, the file exists and matches EARS-M1's schema.
7. Re-run step 6's `breaker-gate.mjs` command with a stub printing `{"verdict":"BREAKER_PASS",...}`.
   Confirm `exit=0` and `breaker-not-executed.json` is now gone. Repeat with
   `BREAKER_INDETERMINATE` — confirm `exit=2` but the file is STILL gone (per EARS-M3, keyed off the
   nested verdict field, not off exit code).
8. As a **non-root** user (this step is a no-op false-pass under root, since `chmod` does not block
   root — if you must run as root, substitute a read-only bind mount or `chattr +i` on the directory
   instead), `chmod 555 "$TMP/.quality-kernel"` then re-run step 6's command (still with the broken
   stub). Confirm `exit=2` (same as step 6), a message about the write failure appears on stderr, and
   no stack trace / uncaught exception is printed. `chmod 755 "$TMP/.quality-kernel"` to clean up.
9. Build a SECOND scratch repo exactly like step 6's recipe (a critical-surface change, so `qk-gate`
   exits 3 and the breaker is required). Run:
   ```sh
   node plugins/quality-kernel/scripts/breaker-gate.mjs --repo "$TMP2" --base "$BASE2" --head "$HEAD2" \
     --breaker "node -e \"let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const i=JSON.parse(s);console.log(JSON.stringify({verdict:(i.qaProcedure&&i.invariants&&i.invariants.length?'BREAKER_PASS':'INSTRUMENT-BROKEN'),executed:3,vectors:[1,2,3]}))})\"" \
     --contract plugins/quality-kernel/scripts/fixtures/qk-breaker-robust-input/contracts/contract-1045-shape.md \
     --probe true --url http://example.com
   echo "exit=$?"
   ```
   Confirm: printed `gate` is NOT `"blocked-invalid-contract"`; `contractLint.ok` is `true` and
   `contractLint.declared` is non-empty; the nested `breaker.verdict` is `"BREAKER_PASS"` and
   `breaker.executed` is `3`; `exit=0`. This is the exact call path (`breaker-gate.mjs` ->
   contract-lint precondition -> `breaker-invoke.mjs`) that produced §0's original failure, now
   run end-to-end against the real shipped fixture (TODAY, pre-fix, OBSERVED by running this command
   against this worktree: `gate:"blocked-invalid-contract"`, `breaker:null`,
   `contractLint.declared:[]`, `exit=3`).

Note: the "crash immediately after the temp-file write" and "Two concurrent breaker-gate.mjs runs"
Gherkin scenarios are exercised only by the coder's unit tests (fault injection mid-rename, and
process orchestration, are both outside what a manual CLI-driven procedure can reliably force) — out
of scope for this QA procedure. INV-11 and the concurrency scenario's own deterministic `&`/`wait`
repro cover both end-to-end instead.

## 4. Decisions made (for the human/designer to ratify)

- **Host-header rule (EARS-V6/V6a):** accept a `Host` header value equal to the system URL's own
  hostname, or any subdomain of its registrable domain (last two labels) — UNLESS the system URL's
  own hostname is an IP literal or a single label (e.g. `127.0.0.1`, `localhost`), in which case only
  an exact match is accepted (no suffix widening). Reasoning: the HTTP instrument always dials the
  TCP connection to `systemUrl` itself (`new URL(req.path, systemUrl)` in `http-probe.mjs`), so a
  `Host` header can never redirect the breaker's network connection — but an unrestricted value would
  let the live system respond "as" an arbitrary hostname (vhost/tenant confusion), and a naive
  last-two-labels rule applied to an IP literal (`127.0.0.1` → suffix `.0.1`) would accept exactly
  that kind of forged value. Scoping to the registrable domain (with the IP/single-label exception)
  keeps the breaker's reach inside "the system under test" while blocking impersonation.
- **Invariant id grammar generalized** from the literal `INV-` prefix to "letters/digits, a hyphen,
  more letters/digits/hyphens" (EARS-H4), because the specifier's own template produces ids like
  `EO-0`/`EO-1b`, not `INV-x`.
- **Per-vector drop/report is layered and ordered (EARS-V4)** so one vector never produces two
  contradictory drop reasons.
- **Breaker-not-executed removal now covers `BREAKER_INDETERMINATE`, not just PASS/FAIL (EARS-M3)**,
  keyed off the nested `breaker.verdict` field specifically because `breaker-gate.mjs`'s own `gate`
  field/exit code cannot distinguish `BREAKER_INDETERMINATE` from `INSTRUMENT-BROKEN` (both are
  `gate: 'breaker-indeterminate'`, exit `2`) — see §1.0.
- **`contract-lint.mjs`/`gstack-breaker.mjs` scope** was drafted conditional in earlier rounds;
  **superseded by D2 below** — the human (Adrian) decided, 2026-11-08, to bring both files
  unconditionally into scope.
- **A fixture already on disk (`fixtures/qk-breaker-robust-input/`) replaces every absolute,
  machine-local path** this contract previously depended on, so every QA step and probe is runnable
  from this worktree alone. (Note: the fixture lives under
  `plugins/quality-kernel/scripts/fixtures/...`, not `plugins/quality-kernel/fixtures/...` — this
  deliberately follows the existing on-disk convention, OBSERVED from the sibling
  `scripts/fixtures/m2/` directory, rather than a literal path without the `scripts/` segment.)
- **D1 (Decided by the human (Adrian), 2026-11-08):** if excluding per-vector-invalid vectors drives
  the executed count to 0 (every vector in the batch excluded), the run IS `INSTRUMENT-BROKEN`
  (EARS-V9's zero-executed rule applies; default-deny holds) — this is not a violation of EARS-V5,
  which only disclaims batch-level rejection of the vectors that still execute. EARS-V5 is reworded
  with an explicit EXCEPT clause, and a new Gherkin scenario ("All vectors are per-vector-invalid...")
  covers this case.
- **D2 (Decided by the human (Adrian), 2026-11-08):** `contract-lint.mjs` and `gstack-breaker.mjs` are
  IN SCOPE for this change. EARS-H8/H9 are now unconditional `SHALL` criteria; their probes (formerly
  COND-1/COND-2) are INV-14/INV-15 in the single normative invariants table — there is no longer a
  separate conditional table.
- **D3 (Decided by the human (Adrian), 2026-11-08):** the Host-header rule (EARS-V6/V6a) is confirmed
  as drafted: accept a Host value equal to the `systemUrl` hostname or a subdomain of its registrable
  domain (last two labels); an IP-literal or single-label `systemUrl` requires an exact match, no
  suffix widening. No public-suffix-list dependency is taken on.
- **D4 (Decided by the human (Adrian), 2026-11-08):** the breaker-not-executed record stays its own
  file, `.quality-kernel/breaker-not-executed.json` (EARS-M1-M5 unchanged); it does NOT integrate with
  `.quality-kernel/evidence-ledger.jsonl` or `proof.mjs` in this change.

## 5. Open questions for the human

All three questions this section previously carried were resolved by the human's (Adrian's)
decisions recorded in §4, 2026-11-08: scope confirmation for `contract-lint.mjs`/`gstack-breaker.mjs`
→ D2 (both in scope, unconditional); the registrable-domain heuristic vs. a public-suffix-list
dependency → D3 (heuristic accepted as drafted, no PSL dependency); the breaker-not-executed record's
integration point vs. `evidence-ledger.jsonl`/`proof.mjs` → D4 (its own file, no `proof.mjs` change).
No open questions remain.

## Carried to design (coder test obligations)

Not blockers; the human (Adrian, 2026-11-08) decided these 6 majors from the review are carried
forward as test obligations for the coder/designer stage rather than fixed in this contract now:

- Define or scope "referee gate" (§1.0's "a passthrough of the referee gate's own `gate` value" /
  "modulo the referee/contract-lint gates") — add a Glossary entry, or state explicitly it is out of
  scope and the pass-through behavior alone is what's load-bearing.
- EARS-V4 step (3) bundles three sub-checks (key/command sets, origin checks, Host rule) with no
  stated sub-order when a vector violates more than one simultaneously — pin an order, or state any
  one failing reason may be reported.
- EARS-V4 step (4) depends on `runVectors`/`validateVectors` knowing whether `--probe` was supplied to
  a separate process (`breaker-invoke.mjs`) — no parameter/field is named for how that fact reaches
  them, and no scenario/INV exercises step (4) at all.
- INV-3, INV-4, and INV-12 probe via a direct `node -e` import of `buildBlindInput`, not the CLI's
  observable stdout/exit code/files — contradicts this table's own "External Observable" framing;
  rewrite them the way INV-1 does (the `--breaker` stub echoes back the parsed fields it received).
- EARS-H2/H2b's "first matching heading in document order" rule has no stated precedence against
  EARS-H3's "headings nested inside an already-open section are swallowed into its body" rule — a
  nested heading that happens to lexically match could be wrongly picked as a new section opener.
- EARS-V6's branch (a) (`Host` exactly equal to the `systemUrl`'s own hostname, no subdomain) is never
  exercised by any Gherkin scenario or Invariant; every existing "accepted" case only exercises branch
  (b) (registrable-domain subdomain).

## 6. Glossary

| Term | Definition |
|---|---|
| Specifier | The quality-kernel pipeline's stage-1 role/agent (specifier → designer → coder → cleaner → architect → hardener → QA) that authors a contract's `.md` file from user intent; its own output template is the numbered-heading, bold-parenthetical-id shape this change parses. |
| Blind breaker | The two-stage instrument (`breaker-claude.mjs` author + `vector-breaker.mjs` executor) that judges a contract against the live system without ever seeing the diff, tests, or reasoning. |
| Vector | One falsifying probe (`http` or `ui` shaped) written by the breaker's author LLM, anchored to one contract invariant id. |
| HOLDS | The result of executing a vector's probe against the live system when the response/assertion matched what the invariant expected (OBSERVED `vector-breaker.mjs`'s `result` field, e.g. L95,102,115). |
| VIOLATED | The opposite outcome: the response/assertion did NOT match — colloquially, the invariant "breaks". Distinct from `INSTRUMENT-BROKEN` (no judgement could be made at all). |
| Invariant | A row of the contract's `## Invariants` / `## External Observable Invariants` table: an id, a falsifiable predicate over external state, a probe command, and an expected value. |
| Batch-level (vector) problem | A defect in the vectors array as a whole that rejects the entire run before any vector executes. |
| Per-vector problem | A defect confined to one vector that excludes only that vector; the rest still execute. |
| Registrable domain | The system URL's hostname reduced to its last two dot-separated labels; used only to decide which `Host` header values a vector may set (not applied when the hostname is an IP literal or single label — EARS-V6a). |
| `gate` field | `breaker-gate.mjs`'s own top-level stdout JSON field; its enumerated values and exit-code mapping are cited in §1.0. |
| `dropped` field | The breaker's own top-level printed-JSON array field (EARS-V3), one `{index, reason}` entry per excluded per-vector-invalid vector; the one required shape for reporting exclusions (see INV-7). |
| Breaker-not-executed record | The JSON file `.quality-kernel/breaker-not-executed.json`, written whenever the nested breaker verdict is `INSTRUMENT-BROKEN`; removed once a later run's nested verdict is `BREAKER_PASS`, `BREAKER_FAIL`, or `BREAKER_INDETERMINATE`. |
| INSTRUMENT-BROKEN | The breaker verdict meaning no trustworthy pass/fail judgement was made — always default-deny. |

## 7. Self-audit (handoff gate)

- The ticket's three behaviours, inline (no external doc is load-bearing for this claim): (1) contract
  parsing must accept numbered/prefixed headings and the specifier's real invariant-table shape,
  failing INSTRUMENT-BROKEN with the headings found when a required section is empty → EARS-H1..H9,
  H2b, H4, H4b, H5. (2) vector validation must drop-and-report individual invalid vectors rather than
  reject the whole batch, while batch-level problems still reject everything (including the
  all-excluded case), including a defined Host-header rule → EARS-V0..V9. (3) an INSTRUMENT-BROKEN
  verdict must leave a machine-readable "breaker not executed" record, and never influence the gate's
  pass/fail decision → EARS-M1..M5.
- Round 4 (authorized by the human (Adrian) past the 3-round budget, 2026-11-08), resolving the
  refreshed review's 3 blockers, folded in directly (not left as pointers to the review file): (1)/(3)
  the EARS-V5/EARS-V9 contradiction (all vectors excluded → executed=0 → V9 forces
  INSTRUMENT-BROKEN, which V5's unqualified wording appeared to forbid) is resolved by D1: V5 now
  carries an explicit EXCEPT clause routing the zero-executed case to V9, and a new Gherkin scenario
  ("All vectors are per-vector-invalid...") exercises it. (2) EARS-V8 had no INV row or Gherkin
  scenario; it now has both — INV-13 probes the new `node --test vector-author-prompt.test.mjs`
  fixture (OBSERVED, RED today against the real, unmodified `breaker/vector-author.md`), and a
  matching Gherkin scenario runs it.
- Majors folded in the same round: EARS-H6 now names both sections when both are empty; the two
  empty-section Gherkin scenarios and INV-5/INV-6 replace the undefined `spy.mjs` with an inline
  `node -e` one-liner appending to a relative flag file; INV-7's hedge is removed by pinning
  EARS-V3's `dropped` array shape and asserting it unconditionally; the "Intention gate"/
  confirmation-artifact question is moot — D2 makes EARS-H8/H9 unconditional, so there is no gate
  state left to record; §3 now notes the crash/concurrency scenarios are unit-test-only, out of
  scope for manual QA; new EARS-H4b gives a first-row-wins rule for duplicate ids (mirroring
  EARS-H2b); the concurrent-runs scenario now gives a concrete `&`/`wait` repro instead of "nearly
  the same instant"; a new scenario covers EARS-M4's non-interference claim by pre-seeding a
  malformed record before a PASS run. Nits folded: the "Adrian"/"the human" naming mismatch is moot
  (D2 removed the PENDING line it was in); EARS-M1 now requires ≥8 hex characters; EARS-H4 now
  strips every trailing parenthetical, not just one; EARS-V6a(b) now gives a concrete bracket-based
  IPv6-literal rule (`^\[.*\]$`).
- Checked every EARS criterion names an externally observable input/output (stdout JSON, exit code, a
  file's existence/contents, a contract file's text) — EARS-H8/H9 name specific files only to pin
  which existing component has the matching gap; the SHALL itself stays behavioral.
- Checked backward compatibility: EARS-H7 plus its Gherkin scenario (against the existing
  `fixtures/m2/contracts/example.md`, not a described-but-absent file).
- Unresolved: none. §5's three open questions were human decisions (D2-D4) this contract could not
  make for itself; all three are now decided and recorded in §4, 2026-11-08.
- Final round (human (Adrian), 2026-11-08: fix the 2 blockers, no further review; 6 majors carried to
  design, listed above): both blockers from the refreshed review are now fixed directly — (1) the
  duplicate-heading/duplicate-id tiebreaker tests now use a SECOND heading that genuinely matches
  EARS-H2 (not prose) and a genuine duplicate-id-in-one-table case (new EARS-H4b scenario + INV-17);
  (2) a new end-to-end scenario + INV-16 + QA step 9 run the committed `contract-1045-shape.md`
  fixture through `breaker-gate.mjs` itself (contract-lint precondition included), OBSERVED RED today
  (`gate:"blocked-invalid-contract"`, `breaker:null`, exit `3`, reproducing §0's exact failure) —
  confirmed by actually running the command against this worktree, not inferred from code reading.
