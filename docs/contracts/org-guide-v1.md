# Contract — org guide v1 (guide.json as single source of truth + schema version)

Status: CONTRACT (specifier stage of the quality-kernel pipeline). Fixes the 2 HIGH + 11 MEDIUM + 11
LOW findings of the pre-push panel review logged at
`/Users/adrian/.cache/git-ai-review/review-1312565d331086e8e3a559990aebc7bd18a1dd85.log` (lines 19-66),
blocking `git push` on branch `feature/quality-kernel-workspace` at HEAD `1312565d`.

Repo: `/Users/adrian/Projects/personal/cct-main`. Areas covered: `plugins/org-workspace/scripts/*`,
`plugins/org-workspace/skills/org-learn/SKILL.md`, `plugins/quality-kernel/scripts/org.mjs` (and its
callers `qk-gate.mjs`, `qk-org-gate.mjs`, `route.mjs`, `referee.mjs`), `plugins/pre-push-review/scripts/
ai-review-panel.mjs`, and the two design docs under `docs/agentic-harness/`.

This is a contract: externally observable behavior only. It does not name classes, functions (beyond
what is already public API cited as OBSERVED fact), or file layout, except where the panel's own
finding already named a file/symbol as the thing to fix — those are marked RECOMMENDED, not mandated.

## 0. Critical compatibility fact (read first)

OBSERVED: a real, live `guide.json` already exists at
`/Users/adrian/Projects/Matchbox/.claude/org-workspace/guide.json` (read-only, not modified by this
work). It has **no `"version"` field** and no `renderHash`/map-summary field of any kind — just
`org`, `repos`, `forbidden`, `truth`, `conventions`, `threads`. It is read by
`plugins/quality-kernel/scripts/org.mjs:92-109` (`readOrgManifest`) and hashed whole by
`org.mjs:114-134` (`orgPin`), consumed by `qk-org-gate.mjs:27-29` (`readOrgManifest`, `orgPin`,
`orgRepoDir`) which gates the Matchbox org's real repos. **Every criterion below that changes
`guide.json`'s shape must keep this file readable with zero manual migration step**, or it must say
explicitly why not (it does not: see OG-8).

## 1. Scope — 24 panel findings, CONFIRMED or REFUTED with evidence

Legend: file:line is the panel's citation; "current" line numbers from my own read are noted only
where they drift from the panel's citation (expected — the panel reviewed a diff hunk, not final
HEAD; the logic, not the line number, is the fact that matters).

| # | Sev | Citation | Verdict | Evidence (OBSERVED) | Covered by |
|---|---|---|---|---|---|
| F1 | HIGH | org-guide.mjs:38 | CONFIRMED | Read org-guide.mjs, org-map.mjs, quality-kernel/org.mjs, skills/org-learn/SKILL.md:10. Three stores exist: rendered block in CLAUDE.md, `guide.json` (read by quality-kernel `org.mjs:92-109`), `map-summary.json` (written/read by org-guide.mjs:163-169,195-197). `SKILL.md:10` literally instructs "rebuild `guide.json`" by reading the rendered block — a lossy reverse-parse, confirmed by reading the file. | OG-1..OG-6 |
| F2 | HIGH | org-guide.mjs:182 | CONFIRMED | `validateGuide` (org-guide.mjs:52) rejects any key not in `['org','repos','forbidden','truth','conventions','threads']` — no `version`. `readOrgManifest` (quality-kernel org.mjs:92-109) reads `g.repos`/`g.forbidden` only, no version check either. Confirmed the real Matchbox `guide.json` has no version field (§0). | OG-7, OG-8, OG-9 |
| F3 | MEDIUM | org-guide.mjs:152 | CONFIRMED by execution | Ran `buildGuide` with an `unmatched[].reason` containing a bare `AKIAABCDEFGHIJKLMNOP`: **accepted**, would be written to `SYSTEM-MAP.md`. `buildGuide` calls `validateIntegrations(integrations, { repos })` with no `secretIn` (org-guide.mjs:152), so `org-map.mjs`'s `textHasSecret` falls back to `hasValueSecret` only (org-integrations.mjs:44,64), which does not run `redact`'s `SECRET_TOKENS` (org-profile.mjs:25-26: AKIA/ASIA/ghp_/github_pat_/sk-/xox/JWT) or its URL-userinfo rule. | OG-10 |
| F4 | MEDIUM | org-guide.mjs:44 | CONFIRMED by execution | `readGuideForbidden` on a CLAUDE.md with BEGIN and no END returned `[]` (ran it). | OG-2 |
| F5 | MEDIUM | org-guide.mjs:181 | CONFIRMED by execution | Symlinked `guide.json`, called `applyGuide`: it threw (correctly), but `CLAUDE.md` was already rewritten with the new block before the throw. | OG-12 |
| F6 | MEDIUM | org-guide.mjs:41 | CONFIRMED by execution | Same function: a symlinked CLAUDE.md and an END-before-BEGIN file both returned `[]` instead of throwing (ran both). | OG-2 |
| F7 | MEDIUM | org-guide.mjs:189 | CONFIRMED | Same defect as F5 (applyGuide writes CLAUDE.md at line 190 before the guide.json/summary/map symlink checks at 192/195/199) — one underlying bug, two citations in the panel's diff view. | OG-12 |
| F8 | MEDIUM | org-profile.mjs:77 | CONFIRMED (code read; Node's documented 1 MiB `spawnSync` default) | org-profile.mjs:78 `git(dir, ['ls-tree',...])` passes no `opts`, so `safe-git.mjs:22`'s `spawnSync` default `maxBuffer` (1 MiB) applies; `profile()` does check `ls.status !== 0` and throws `cannot list the tree of...` (line 79), matching the panel's description of the failure mode. Not reproduced against a literal 25k-file repo (time budget); the absence of an explicit `maxBuffer` option is a direct code read, not inference. | OG-13 |
| F9 | MEDIUM | org-integrations.mjs:73 | CONFIRMED | org-integrations.mjs:72: `git(dir, ['ls-tree',...]).stdout.split('\0')` — no `maxBuffer`, **and no status check at all** (worse than F8: a failed spawn would throw on `.stdout` being undefined, or on Node ≥ newer versions return truncated stdout silently depending on the failure mode), confirmed by direct read. | OG-13 |
| F10 | MEDIUM | org-guide.mjs:186 | CONFIRMED | Read `org-guide.test.mjs` in full (218 lines): the only CLAUDE.md-symlink test is for `build()` (line 102-111); no test symlinks `guide.json`, `map-summary.json` or `SYSTEM-MAP.md` and calls `applyGuide`. My own F5 repro is exactly the missing case. | OG-19 |
| F11 | MEDIUM | org-guide.test.mjs:168 | CONFIRMED | Read the `'map refused'` table (lines 158-178): all 12 cases vary `edge` fields only; none exercises `unmatched[].evidence` (the `cite()` call at org-map.mjs:115). | OG-19 |
| F12 | MEDIUM | entrypoint.mjs:1 | CONFIRMED | `diff`ed the three shared files against quality-kernel's copies: `safe-git.mjs` and `hermetic-git.mjs` are **byte-identical** (confirmed empty diff) yet their comments say "the gate" (safe-git.mjs:1) and `.quality-kernel/` (hermetic-git.mjs:3) — quality-kernel-specific language copied verbatim into a different plugin. `entrypoint.mjs`/`is-main.mjs` have **already diverged**: different export name (`isEntrypoint` vs `isMain`) and different logic (quality-kernel added a plain-path fast-check before the realpath fallback). quality-kernel's CHANGELOG.md:28-29 confirms `entrypoint.mjs` was deliberately removed there in favour of `is-main.mjs`, then re-added here. | OG-16 |
| F13 | MEDIUM | org-guide.mjs:24 | CONFIRMED | Read all five scripts: `redact` in org-profile.mjs:27; `redactLine`/`hasValueSecret` in org-integrations.mjs:64-65; `isRepoName` in org-guide.mjs:31 (imported by org-discover.mjs:18) **and separately redefined** in quality-kernel/org.mjs:30 with a different regex (see Residual risks — not one of the 24, found during this audit); `CONTROL` defined independently in org-guide.mjs:34, org-map.mjs:31, and again inline in org-map.mjs:133 (`tick`); `MAX_TEXT` is 200 in org-guide.mjs:33 vs 300 in org-map.mjs:28; `validateGuide` checks secrets via `redactLine(v) !== v.slice(0,400)` (org-guide.mjs:56) while org-map's `text()` uses `textHasSecret` (org-integrations.mjs:44) — two different secret checks. | OG-10 |
| F14 | LOW | org-discover.mjs:42 | CONFIRMED by execution | `stripCredentials('user:p@ss@host:O/a.git')` → `'ss@host:O/a.git'` (ran it) — the tail of the password leaks into the inventory. | OG-14 |
| F15 | LOW | org-guide.mjs:143 | CONFIRMED by execution | Built `END + BEGIN + rest` (END immediately before BEGIN) and called `spliceBlock`: did not throw, result has **2** `BEGIN` markers (ran it; `result.split(BEGIN).length - 1 === 2`). | OG-11 |
| F16 | LOW | org-discover.mjs:36 | CONFIRMED by execution | `stripCredentials('https://github.com/O/a.git?next=x@evil/y')` → `'https://evil/y'` (ran it) — wrong host, corrupts `remoteKey`-based copy detection. | OG-14 |
| F17 | LOW | ai-review-panel.mjs:446 | CONFIRMED by faithful re-execution | Copied `boundDiffBytes` verbatim (same constants: `MAX_DIFF_LINES=3000`, `lineBudget=2950`) into a standalone harness, fed it one file using 2940 of the 2950-line budget plus 60 tiny files that get skipped: total line count came out to **3007** (over `MAX_DIFF_LINES`), the post-hoc truncation at ai-review-panel.mjs:477-482 then fired and cut the footer from 60 listed names down to **54** — 6 skipped-file names silently lost. | OG-17 |
| F18 | LOW | org-guide.mjs:149 | CONFIRMED | org-guide.mjs:150: `try { ...profile... } catch { /* not a profilable repo: not citable */ }` — swallows every error (integrity failure, bad package.json, missing base branch) with no record; the repo silently drops out of `repos`, so a later "X is not a selected repo" error hides the real cause. | OG-15 |
| F19 | LOW | org-guide.mjs:167 | CONFIRMED | org-guide.mjs:164-169: an unreadable/invalid `map-summary.json` is dropped in a `catch {}` with only a code comment, no stderr warning, no exit-code signal. | OG-4, OG-19 |
| F20 | LOW | org-guide.mjs:160 | CONFIRMED | Read the test at org-guide.test.mjs:211-218: only the happy-path carry-forward is tested; no malformed JSON, no shape-invalid entry (`from: '../x'`), no symlinked `map-summary.json` case. | OG-4, OG-19 |
| F21 | LOW | org-discover.mjs:122 | CONFIRMED | Read org-discover.test.mjs in full: every copy-detection test (`'app'`/`'app (Copy)'`/`'dup'`) includes a repo named like the remote (`'app'`), so the `if (!original) { ...shares its origin with... }` branch (org-discover.mjs:122) is never hit by any test. | OG-19 |
| F22 | LOW | entrypoint.mjs:8 | CONFIRMED | Grepped every org-workspace test file for `symlink` + confirmed no CLI test invokes a script through a symlinked path — all `symlinkSync` uses target CLAUDE.md or a repo dir, never the scripts directory itself. | OG-19 |
| F23 | LOW | ai-review-panel.mjs:474 | **REFUTED** | Re-ran the exact same harness as F17: `diffLines` after `boundDiffBytes` was **3007 > 3000**, so the "pre-existing truncation… can no longer trigger" claim is empirically false in the very scenario F17 describes — the post-hoc truncation DID fire (and is in fact the only thing bounding that pathological case, albeit by corrupting the footer). The remedy "remove it" would delete the only remaining cap for that case. The underlying maintainability point (one budget mechanism, not two half-overlapping ones) is real but is subsumed into OG-17, which fixes the interaction instead of deleting either half. | OG-17 (F23 excluded as a standalone fix item) |
| F24 | LOW | docs/agentic-harness/spec-init-workspace.v1.md:1 | CONFIRMED | `spec-init-workspace.v1.md` presents the M1 generator as "BUILT, WIP"; quality-kernel's CHANGELOG.md:106 says "The automatic gate-config generator (M1: ws-propose / ws-verify / ws-command) is retired" (0.10.0). `spec-workspace-memory.v1.md` describes `WORKSPACE.md` + `/workspace-learn` (lines 15-42); the shipped plugin uses the CLAUDE.md block + `/org-learn` (org-guide.mjs, skills/org-learn/SKILL.md) — a different, later design with no pointer from the old doc to the new one. | OG-18 |

**Count: 23 CONFIRMED, 1 REFUTED (F23).**

## 2. The five design questions — firm recommendations

**1. Single source of truth.** `guide.json` is authoritative; the CLAUDE.md block becomes a pure,
deterministic *render* of `guide.json`, never a parse source — `readGuideForbidden` reads
`guide.json.forbidden` directly, and `/org-learn` reads and edits `guide.json`, never the rendered
markdown. The "who calls whom" summary moves **into** `guide.json` (no more `map-summary.json`): one
file, one authoritative shape, nothing to go out of sync. *Trade-off:* `guide.json` carries one more
(tool-generated) field than a human would author by hand, but this removes the two remaining
regex-parse-a-rendered-document failure classes (F1's lossy round-trip, F19/F20's silent data loss)
instead of patching them individually. A hand edit inside the markers is detected by comparing the
on-disk block's hash against a hash `guide.json` recorded at the last tool write (`renderHash`); on a
mismatch the tool **refuses to proceed and writes nothing**, telling the user to run `/org-learn` to
fold the edit in or revert it by hand first. *Trade-off:* this ends silent support for ad-hoc hand
edits inside the markers (today's marker text invites them) — a deliberate behavior change; the
marker text must say so. A `guide.json` with no `renderHash` yet (including the real Matchbox file,
§0) has nothing to compare against, so the check is skipped once and the hash is recorded on that
write — no manual step.

**2. Schema version.** Add `"version": 1`, stamped by the tool on every write (the human/agent-authored
`--guide` input does not need to supply it). `validateGuide` accepts it; `readOrgManifest` in
quality-kernel checks it. Compatibility path for the real, unversioned Matchbox `guide.json` (§0): a
**missing** `version` is read as `1` (one-time grandfather — the shape is otherwise identical to v1),
so the live gate keeps working with **zero manual migration**; the very next `/org-init` or
`/org-learn --apply` on that org folder stamps `version: 1` in automatically. An **explicit** version
that is not `1` fails closed with a named, actionable error (`findOrg`'s existing "no usable org
guide…" error path, quality-kernel org.mjs:154), never a silent partial read. *Trade-off:* the
grandfather clause is itself debt — a future v2 cutover needs an explicit decision about when
"missing = 1" stops being honoured (see Residual risks). `--org-pin`/`orgPin` (quality-kernel
org.mjs:114-134) is already a pure content hash of the current bytes of `guide.json` plus everything
under `.quality-kernel/repos/`; it needs no special-casing — it already changes the moment the file's
bytes change (including the moment `version`/`renderHash` are stamped in), which is the existing,
correct, fail-closed behaviour (`findOrg`, org.mjs:160).

**3. One policy module.** RECOMMENDED (not mandated — module layout is the architect's call): one
secret-detection/redaction predicate (`hasSecret`), one single-line/control-char/length text
validator, and one repo-name rule, used by **both** guide validation and map validation — not four
places implementing four almost-identical rules (F13), and `buildGuide` passes this predicate into
`validateIntegrations`'s `secretIn` slot so guide text and map text are checked to the same standard
(F3). *Trade-off against "leave each check local to its caller":* a shared predicate is one thing to
keep correct and one thing to extend (e.g. a new leaked-token format) instead of four; the cost is one
more cross-file import inside the same plugin (not cross-plugin, so no distribution concern).

**4. Shared helpers duplicated across plugins.** OBSERVED: `plugins/org-workspace/.claude-plugin/
plugin.json` and `plugins/quality-kernel/.claude-plugin/plugin.json` are independent, independently
versioned plugin manifests; every script reference I found uses only its own `${CLAUDE_PLUGIN_ROOT}`
(skills/org-learn/SKILL.md:18, skills/org-init/SKILL.md:9) — no script in either plugin imports across
a `${CLAUDE_PLUGIN_ROOT}` boundary, and neither plugin has a `package.json`/dependency declaration that
would let one declare the other as a dependency; a user can install either plugin without the other.
**Recommendation: vendor-copy, kept identical via an automated same-repo consistency check** (both
plugins' source lives in this one repo, `cct-main`, even though they *install* separately) — not a
shared npm package (disproportionate tooling for three small files with zero other dependencies today).
Concretely: rename org-workspace's copy to match quality-kernel's canonical `is-main.mjs`/`isMain`
exactly (same file content, same export name — close the drift found in F12), and add a test in this
repo that fails when any of the three vendored files differs byte-for-byte from quality-kernel's copy.
Comments in the vendored files become plugin-neutral (no "the gate" /
`.quality-kernel/` wording) so neither copy reads as borrowed from the other. *Trade-off:* a real
shared package would need zero manual re-sync, but requires build/publish tooling neither plugin has;
vendor+test needs a human (or agent) to re-run the sync when quality-kernel's canonical copy changes,
caught by the consistency test rather than prevented outright.

**5. Nothing written on refusal.** `applyGuide` must run every precondition check — symlink checks on
every write target (CLAUDE.md, `guide.json`, `SYSTEM-MAP.md`), the block-budget check, and guide/map
validation — **before** writing any of them; a refusal must leave every target byte-identical to its
state before the call (today's CLAUDE.md-first write order violates this, F5/F7/F10).

## 3. EARS acceptance criteria

**OG-1 (ubiquitous).** THE SYSTEM SHALL treat `<org>/.claude/org-workspace/guide.json` as the sole
authoritative record of the org guide's repos, forbidden list, sources of truth, conventions, threads
and who-calls-whom summary; the managed block of `<org>/CLAUDE.md` SHALL be a value derived only from
`guide.json`, never an independent store.

**OG-2 (event + unwanted).**
WHEN a caller asks for the guide's forbidden-repo list (directly, or via `org-discover`'s deny set),
THE SYSTEM SHALL return it by reading `guide.json`'s `forbidden` array.
WHEN `guide.json` does not exist yet (no `/org-init` has ever run), THE SYSTEM SHALL return an empty
forbidden list from the guide (in addition to any `--forbid`/`--exclude` option), not an error.
IF `guide.json` exists but cannot be parsed as the expected shape, or is a symlink, or any directory on
its path is a symlink, THEN THE SYSTEM SHALL fail closed (throw / non-zero exit) rather than return a
partial or empty forbidden list.

**OG-3 (ubiquitous).** THE SYSTEM's guide-editing workflow (the `/org-learn` skill) SHALL read and
propose changes to `guide.json` directly; it SHALL NOT reconstruct guide content by parsing the
rendered CLAUDE.md block.

**OG-4 (ubiquitous).** THE SYSTEM SHALL persist the who-calls-whom summary (one row per caller/
provider pair with its count) inside `guide.json` itself; a separate `map-summary.json` file SHALL NOT
be required for the guide block to carry that section across a guide-only update (no new
`--integrations` map).

**OG-5 (event + unwanted).**
WHEN the guide tool is about to render a new block and `guide.json` already records the hash of the
block it last wrote, THE SYSTEM SHALL compare that recorded hash against the hash of the block
currently on disk between the markers.
IF the two hashes differ, THEN THE SYSTEM SHALL refuse to render or write anything, SHALL leave every
file (CLAUDE.md, guide.json, SYSTEM-MAP.md) exactly as it was, and SHALL report that the block was
edited by hand since the last tool write, naming `/org-learn` as the way to fold the edit in.
WHERE `guide.json` has no previously recorded block hash (first-ever write, or a pre-existing file from
before this check existed), THE SYSTEM SHALL skip the comparison for that one write and record the new
hash.

**OG-6 (ubiquitous).** THE SYSTEM's marker text in a rendered block SHALL tell the reader to make
changes through `/org-learn`, not by editing the block directly.

**OG-7 (ubiquitous).** THE SYSTEM SHALL write `"version": 1` into every `guide.json` it persists,
regardless of whether the proposed guide content supplied to the tool included a version field.

**OG-8 (state + unwanted).**
WHILE a `guide.json` has no `version` field at all, THE SYSTEM (both the org-workspace writer and the
quality-kernel reader) SHALL treat it as version 1, so a pre-existing guide.json such as
`/Users/adrian/Projects/Matchbox/.claude/org-workspace/guide.json` keeps working with no manual
migration step.
IF a `guide.json` has an explicit `version` the reader does not support, THEN THE SYSTEM SHALL fail
closed with a message naming the unsupported version and that a plugin upgrade or guide migration is
needed, and SHALL NOT fall back to a partial or best-effort read.

**OG-9 (ubiquitous).** THE SYSTEM's `--org-pin` (quality-kernel `orgPin`) SHALL remain a pure content
hash of the current bytes of `guide.json` plus every file under `.quality-kernel/repos/`, recomputed
fresh each time; no special-casing for `version` or any other field SHALL be needed for the pin to
change correctly when those bytes change.

**OG-10 (ubiquitous).** THE SYSTEM SHALL apply exactly one secret-detection rule, one single-
line/control-character/length text rule and one repo-name rule to all user- or agent-supplied text
accepted into the guide or the integration map — including `buildGuide`'s call into integration
validation, which SHALL use that same secret-detection rule (so a bare access-key-shaped token or a
credentialed URL in an edge's `note`, `endpoint`, or an unmatched entry's `reason`/`endpoint` is
refused, not just a quoted value next to a key/token/secret name).

**OG-11 (unwanted).** IF the text between an END marker and the following BEGIN marker is empty (the
END sits immediately before the BEGIN with no separating or intervening content), THEN THE SYSTEM
SHALL treat that as an END-before-BEGIN ordering error and throw, rather than silently retaining the
stray END and producing two BEGIN markers in the result.

**OG-12 (unwanted + event).** WHEN the guide tool applies a built guide, THE SYSTEM SHALL check every
write-target precondition (each of CLAUDE.md, guide.json and SYSTEM-MAP.md: not a symlink, within
budget, valid content) before writing any of them. IF any precondition fails, THEN THE SYSTEM SHALL
write none of the target files, and every target file SHALL remain byte-identical to its state before
the call.

**OG-13 (unwanted).** IF a `git ls-tree` read of a repo's committed file list would exceed the
runtime's default output-capture limit, THEN THE SYSTEM SHALL still read the full list (by raising the
capture limit) or SHALL fail with a clear, named error — never silently truncate the file list, and
never crash with an unhandled low-level I/O error.

**OG-14 (ubiquitous).** THE SYSTEM's remote-URL credential stripping SHALL remove the query string and
fragment before locating the userinfo separator, and SHALL correctly split an scp-style remote
(`user:pass@host:path`) even when the password itself contains an `@`, so that in both cases no
credential fragment reaches the returned value or the comparison key used for copy detection.

**OG-15 (event).** WHEN a repo named in the guide cannot be profiled while building an integration map,
THE SYSTEM SHALL record that repo's name and the profiling error among the build's problems, rather
than silently omitting the repo with no explanation.

**OG-16 (ubiquitous).** THE SYSTEM SHALL keep the git-invocation and entrypoint-detection helpers
identical, byte-for-byte, across the org-workspace and quality-kernel plugins' source in this repo, and
SHALL fail a repo-level check when they diverge.

**OG-17 (ubiquitous).** THE SYSTEM's diff-budgeting for the pre-push review panel SHALL ensure the
final reviewed text (kept content plus the skipped-files footer, if any) never exceeds the configured
line budget, and SHALL ensure that when files are skipped, every skipped file's name that is reported
as "not reviewed" is actually present in the output (the footer itself is never partially cut by a
later truncation step).

**OG-18 (ubiquitous).** THE SYSTEM's design docs for a retired or superseded design SHALL carry a
visible "Superseded" status with a pointer to the design or plugin that replaced it.

**OG-19 (ubiquitous — test coverage).** THE SYSTEM's automated test suite SHALL include, at minimum,
one case each for: a symlinked `guide.json`, a symlinked `SYSTEM-MAP.md`, and a symlinked summary
target, each asserting that `applyGuide` throws and every file is unchanged; an `unmatched[].evidence`
citation that is malformed, missing, or points past a file's end, asserting the map build throws and
nothing is written; a malformed, shape-invalid, and a symlinked who-calls-whom summary source,
asserting a guide-only re-apply produces no "Who calls whom" section and no crash; two repos that share
a remote with neither named like it, asserting both keep kind `repo` and each names the other in its
reason; and the entrypoint/is-main check invoked through a symlinked script path, asserting it still
runs (non-empty output, exit 0).

**OG-20 (ubiquitous — consumer).** THE SYSTEM SHALL keep `plugins/quality-kernel/scripts/org.mjs`'s
`readOrgManifest` (org.mjs:92-109), `orgPin` (org.mjs:114-134) and `findOrg` (org.mjs:141-162), and
their callers `qk-gate.mjs:39-47`, `qk-org-gate.mjs:27-29`, `route.mjs:169-212` and
`referee.mjs:126-183`, working unmodified against both the pre-existing (unversioned) and the new
(versioned) `guide.json` shape — in particular, `qk-org-gate.mjs --org
/Users/adrian/Projects/Matchbox --branch <any real feature branch>` SHALL continue to resolve the same
set of app repos it resolves today, read-only against that real org folder.

## 4. Gherkin scenarios

```gherkin
Feature: guide.json is the single source of truth

  Background:
    Given an org folder with two committed repos "web" and "api"
    And a guide.json-producing tool available at the org-workspace plugin's scripts

  Scenario: the rendered CLAUDE.md block is derived output only
    Given a guide applied once with --apply
    When the guide tool is asked to read the forbidden-repo list
    Then it reads guide.json's "forbidden" array
    And it does not regex-parse CLAUDE.md's rendered block

  Scenario: a hand-edited block is detected and nothing is written
    Given a guide applied once with --apply, so guide.json records the block's hash
    And a user hand-edits one character inside the BEGIN/END markers of CLAUDE.md
    When the guide tool is run again with the same guide.json content
    Then it refuses with an error naming "/org-learn"
    And CLAUDE.md, guide.json and SYSTEM-MAP.md are all byte-identical to their state before the run

  Scenario: a guide.json with no recorded block hash is accepted once
    Given a guide.json with no "renderHash" field (e.g. a pre-existing file from before this change)
    When the guide tool is run and applied
    Then it writes successfully
    And the new guide.json now records a block hash

  Scenario: the legacy, unversioned guide.json keeps the Matchbox gate working
    Given a guide.json with no "version" field, shaped exactly like
      "/Users/adrian/Projects/Matchbox/.claude/org-workspace/guide.json" (read-only fixture copy)
    When quality-kernel's org.mjs reads it via readOrgManifest
    Then it is accepted as version 1
    And qk-org-gate resolves the same repos it would resolve from an identical guide.json that has
      "version": 1

  Scenario: an unknown future version fails closed
    Given a guide.json with "version": 2
    When quality-kernel's org.mjs reads it via readOrgManifest / findOrg
    Then it reports an error naming the unsupported version
    And it does not fall back to reading the file as version 1

  Scenario: a bare access-key-shaped token in an integration note is refused
    Given an integration map whose unmatched[].reason contains an unquoted string matching an AWS
      access-key-id shape (e.g. "AKIA" followed by 16 uppercase alphanumeric characters)
    When the guide tool builds the guide with that integration map
    Then it throws a "secret-looking value" error
    And SYSTEM-MAP.md is not written

  Scenario: applyGuide writes nothing when any target is a symlink
    Given guide.json at the default path is a symlink to a file outside the org folder
    When the guide tool builds and applies a valid guide
    Then it throws a "symlink — refusing to write through it" error
    And CLAUDE.md is byte-identical to its content before the call
    And the symlink's target file is unchanged

  Scenario: an END immediately before a BEGIN is treated as a marker ordering error
    Given a CLAUDE.md whose content is exactly an END marker followed immediately by a BEGIN marker
      and trailing text, with no other markers
    When the guide tool splices a new block into it
    Then it throws an "end marker before the begin marker" error
    And the file is not written

  Scenario: readGuideForbidden fails closed on a corrupt or symlinked guide.json
    Given a guide.json that is a symlink to a file outside the org folder
    When org-discover computes its deny set
    Then it throws rather than returning an empty forbidden list
    And no repo is opened as a result of that run

  Scenario: credentials are fully stripped from an scp-style remote with "@" in the password
    Given a repo whose origin remote is "user:p@ss@host:O/a.git"
    When org-discover inventories that repo
    Then its reported remote is "host:O/a.git"
    And the string "p@ss" does not appear anywhere in the inventory output

  Scenario: a query-string "@" does not corrupt the stripped host
    Given a repo whose origin remote is "https://github.com/O/a.git?next=x@evil/y"
    When org-discover inventories that repo
    Then its reported remote is "https://github.com/O/a.git"
    And it is not "https://evil/y"

  Scenario: the pre-push review footer never gets truncated
    Given a diff whose files, once packed under the line budget, leave more than 48 files skipped
    When the panel's diff-budgeting step runs
    Then the number of file names listed under "file(s) not reviewed" equals the number reported in
      that same message
    And the total output does not need a further line-count truncation that removes any of those names
```

## 5. External Observable Invariants

All probes run against a freshly created temp org folder (`mktemp -d`), never against
`/Users/adrian/Projects/Matchbox` (read-only reference only, used solely to copy its guide.json shape
into a disposable fixture — never executed against the real path).

| ID | Predicate (falsifiable) | Probe command |
|---|---|---|
| INV-OG-1 | `readGuideForbidden`/`org-discover`'s deny set equals `guide.json`'s `forbidden` array, not whatever CLAUDE.md's prose happens to say | `ORG=$(mktemp -d); mkdir -p "$ORG/.claude/org-workspace"; printf '{"version":1,"org":"t","repos":[],"forbidden":["x"]}' > "$ORG/.claude/org-workspace/guide.json"; printf '%s\n- Forbidden (never open, run or write): \`y\`\n%s\n' '<!-- org-workspace:begin — managed by /org-init and /org-learn; edit with them (or by hand, inside these markers) -->' '<!-- org-workspace:end -->' > "$ORG/CLAUDE.md"; node plugins/org-workspace/scripts/org-discover.mjs --org "$ORG" \| node -e "const inv=JSON.parse(require('fs').readFileSync(0)); process.exit(JSON.stringify(inv.forbidden)==='[\"x\"]'?0:1)"` |
| INV-OG-2 | a hand-edited block (one byte changed inside the markers since the last tool write) makes the next apply refuse and leaves every file unchanged | build+apply a guide in a temp org, record sha256 of CLAUDE.md, guide.json, SYSTEM-MAP.md; flip one character inside the markers; re-run the apply with the same guide.json content; assert non-zero exit and all three sha256 sums unchanged |
| INV-OG-3 | a `guide.json` with no `version` field is accepted by quality-kernel's `readOrgManifest` and treated as version 1 | `node --input-type=module -e "import {readOrgManifest} from 'plugins/quality-kernel/scripts/org.mjs'; const fs=require('fs'); const os=require('os'); const path=require('path'); const d=fs.mkdtempSync(path.join(os.tmpdir(),'inv3-')); fs.mkdirSync(path.join(d,'.claude','org-workspace'),{recursive:true}); fs.writeFileSync(path.join(d,'.claude','org-workspace','guide.json'), JSON.stringify({org:'t',repos:[{name:'web',role:'app',base:'main'}],forbidden:[]})); const m=readOrgManifest(d); process.exit(m && m.repos.web ? 0 : 1);"` |
| INV-OG-4 | an explicit unsupported `version` (e.g. 2) makes `findOrg` return an error, never a usable workspace | same harness as INV-OG-3 but with `version: 2` in the written guide.json; assert `readOrgManifest`/`findOrg` reports an error naming "version" and does not return a usable `{dir,pin,name}` |
| INV-OG-5 | `orgPin` changes when `guide.json`'s bytes change (including a version/hash stamp being added) and does not change when they don't | `node --input-type=module -e "import {orgPin} from 'plugins/quality-kernel/scripts/org.mjs'; ..."` — compute `orgPin(dir)` before and after rewriting `guide.json`'s bytes; assert the two hex digests differ; compute it twice in a row with no change in between; assert they are equal |
| INV-OG-6 | an unquoted AWS-access-key-shaped literal or a `user:pass@host` URL inside an edge's `note` or an unmatched entry's `reason`/`endpoint` makes `buildGuide` throw, and `SYSTEM-MAP.md` is not written, even with `--apply` requested | `node plugins/org-workspace/scripts/org-guide.mjs --org "$ORG" --guide guide.json --integrations bad-integrations.json --date 2026-10-26 --apply; echo "exit=$?"; test -f "$ORG/SYSTEM-MAP.md" && echo FAIL \|\| echo OK` (with `bad-integrations.json` containing an `unmatched[].reason` carrying `AKIAABCDEFGHIJKLMNOP`; expect non-zero exit and `OK`) |
| INV-OG-7 | `applyGuide` writes nothing when any target (CLAUDE.md, guide.json, SYSTEM-MAP.md) is a symlink — not just the ones checked today | for each of the three paths in turn: symlink it to a file outside the org folder, run `org-guide.mjs ... --apply`, assert non-zero exit and that the other two files (and the symlink's target) are byte-identical to before the run |
| INV-OG-8 | an END immediately before a BEGIN never produces two BEGIN markers in the spliced result | `node --input-type=module -e "import {spliceBlock,BEGIN,END} from 'plugins/org-workspace/scripts/org-guide.mjs'; try { const r = spliceBlock(END+BEGIN+'x', BEGIN+'y'+END); process.exit(r.split(BEGIN).length-1<=1?0:1); } catch { process.exit(0); }"` |
| INV-OG-9 | `stripCredentials` leaves no password fragment for an scp-style remote whose password contains `@` | `node --input-type=module -e "import {stripCredentials} from 'plugins/org-workspace/scripts/org-discover.mjs'; const r=stripCredentials('user:p@ss@host:O/a.git'); process.exit(r==='host:O/a.git'?0:1);"` |
| INV-OG-10 | `stripCredentials` does not let a query-string `@` relocate the host | `node --input-type=module -e "import {stripCredentials} from 'plugins/org-workspace/scripts/org-discover.mjs'; const r=stripCredentials('https://github.com/O/a.git?next=x@evil/y'); process.exit(r==='https://github.com/O/a.git'?0:1);"` |
| INV-OG-11 | `plugins/org-workspace/scripts/safe-git.mjs` and `hermetic-git.mjs` are byte-identical to `plugins/quality-kernel/scripts/safe-git.mjs` and `hermetic-git.mjs`; the entrypoint helpers are identical in logic and export name | `diff plugins/org-workspace/scripts/safe-git.mjs plugins/quality-kernel/scripts/safe-git.mjs && diff plugins/org-workspace/scripts/hermetic-git.mjs plugins/quality-kernel/scripts/hermetic-git.mjs && diff plugins/org-workspace/scripts/entrypoint.mjs plugins/quality-kernel/scripts/is-main.mjs` (all three must exit 0) |
| INV-OG-12 | the real Matchbox org folder still resolves the same repo set through `qk-org-gate.mjs`, read-only, after the schema-version change ships | `node plugins/quality-kernel/scripts/qk-org-gate.mjs --org /Users/adrian/Projects/Matchbox --branch <a real existing branch name> ; echo "exit=$?"` — compare the repo list in stdout/stderr against a run captured before the change; run must not regress to "no usable org guide" |
| INV-OG-13 | the pre-push-review footer is never truncated: every name counted in "N file(s) not reviewed" is present in the output | feed `boundDiffBytes`'s packing logic (invoked through the shipped script, or its exported function once testable per OG-19) one large file plus 60+ tiny ones that overflow the line budget; assert the printed/returned "file(s) not reviewed" count equals the number of listed names, and that no further truncation step removes any of them |

## 6. End-to-end QA procedure (CLI only)

1. `ORG=$(mktemp -d)`; create two tiny git repos `web` and `api` inside it (as the existing
   `org-guide.test.mjs` fixture does), each with one committed file.
2. Run `node plugins/org-workspace/scripts/org-discover.mjs --org "$ORG"` — confirm both repos are
   listed, `forbidden` is `[]` (no guide.json yet — OG-2's ubiquitous branch).
3. Write a `guide.json` proposal (no `version`, no `renderHash` — simulating a hand-authored or
   /org-learn-proposed file) and run `node plugins/org-workspace/scripts/org-guide.mjs --org "$ORG"
   --guide guide.json --date 2026-10-26 --apply`. Confirm: exit 0; `CLAUDE.md` now has the block;
   `guide.json` now has `"version": 1` and a block-hash field (OG-7).
4. Hand-edit one character inside the CLAUDE.md block's markers. Re-run the same apply command with
   the same `guide.json` content. Confirm: non-zero exit, an error naming `/org-learn`, and `diff` shows
   zero changes to CLAUDE.md, guide.json and SYSTEM-MAP.md (OG-5, INV-OG-2).
5. Revert the hand edit (restore the tool-written CLAUDE.md). Re-run the apply. Confirm it now
   succeeds.
6. Symlink `guide.json` to a file outside `$ORG`. Run the apply again with a legitimately changed
   guide (e.g. an added thread). Confirm: non-zero exit, and `diff` shows CLAUDE.md is still
   byte-identical to step 5's result (OG-12, INV-OG-7). Remove the symlink and restore guide.json.
7. Run `node plugins/quality-kernel/scripts/org.mjs`-backed `qk-org-gate.mjs --org "$ORG" --branch
   main` (or the repos' actual branch) and confirm it resolves `web`/`api` from the guide (OG-20).
8. Copy the real, read-only `/Users/adrian/Projects/Matchbox/.claude/org-workspace/guide.json` into a
   **disposable** fixture org folder (never the real path) that has stub `web`/`api`-named repo dirs
   matching its `repos[].name`s; run `readOrgManifest`/`qk-org-gate.mjs` against the fixture; confirm it
   is accepted as version 1 with no edits to the file (OG-8, INV-OG-3).
9. Edit the fixture's copy to `"version": 2`; re-run; confirm a named, fail-closed error (OG-8,
   INV-OG-4).
10. Feed `org-guide.mjs --integrations` a map containing a bare `AKIA…`-shaped token in a `reason`;
    confirm the build throws "secret-looking value" and `SYSTEM-MAP.md` is not written (OG-10,
    INV-OG-6).
11. Run `diff` across the three vendored helper files between the two plugins (INV-OG-11); confirm all
    three are identical.
12. Re-run the full existing `node --test` suite for `plugins/org-workspace/scripts/*.test.mjs` and
    `plugins/quality-kernel/scripts/org*.test.mjs`; confirm green, plus the new cases from OG-19.

## 7. Glossary

- **Org folder** — a directory holding several repos as siblings (e.g. `~/Projects/Matchbox`), with
  its own `CLAUDE.md` loaded by every session rooted there.
- **Guide** — the small, budgeted record of where the truth of each thing lives in the org (repos,
  forbidden repos, sources of truth, conventions, open threads, who-calls-whom summary).
- **Guide block** — the managed, marker-delimited section of `<org>/CLAUDE.md` rendered from the
  guide.
- **Render hash** — a hash of the exact bytes of the guide block as last written by the tool, stored in
  `guide.json`, used to detect a hand edit made since that write.
- **Org pin (`--org-pin`)** — a content hash of the whole org config (`guide.json` plus every file
  under `.quality-kernel/repos/`) that quality-kernel re-checks before, during and after a gate run.
- **Grandfather (version)** — the one-time rule that a `guide.json` with no `version` field is read as
  version 1, so a file written before this contract shipped keeps working.

## 8. Residual risks

1. **(HIGHEST — needs a human decision before the version grandfather is removed.)** The "missing
   version = 1" rule is permanent debt: nothing currently forces the real Matchbox `guide.json` to ever
   gain an explicit `version` field unless `/org-init` or `/org-learn --apply` is actually re-run on
   that org folder. If a future v2 schema ships and the grandfather rule is ever tightened to "missing
   version = refuse," an org folder that has not been re-applied since this change will suddenly start
   failing closed. Recommend: track this explicitly (e.g., an open thread in the guide itself, or a
   quality-kernel warning when it reads a guide with no `version`) rather than relying on memory.
2. A third, independently defined `isRepoName` was found during this audit at
   `plugins/quality-kernel/scripts/org.mjs:27-30`, with a **different** regex (allows spaces and
   parentheses, no length cap) than org-workspace's `org-guide.mjs:30-31` (no spaces/parens, 100-char
   cap). This is not one of the panel's 24 findings (it is cross-plugin, not within org-workspace), but
   it is the same class of defect as F13 and should be looked at before either regex is tightened or
   loosened independently — a name quality-kernel treats as a valid sibling repo directory could be one
   org-workspace's guide would refuse to record, or vice versa.
3. F8/F9 (large-repo `ls-tree` truncation) were confirmed by code reading and Node's documented
   `spawnSync` default, not by reproducing against an actual ~25k-file repo (out of the 45-minute
   budget for this stage) — INV-OG probes for these two were deliberately left for the hardener/QA
   stage to build against a synthetic large tree or a PATH-shadowed `git` stub, the same idiom already
   used in `org-discover.test.mjs`'s `loggingGit()` helper.
4. F17/INV-OG-13's probe assumes `ai-review-panel.mjs`'s diff-budgeting logic becomes unit-testable in
   isolation (it currently exports nothing — this is a script, not a module). Making that one function
   importable is the minimum testability surface OG-19/INV-OG-13 need; which function, and under what
   name, is the coder's choice, consistent with how every other script in this contract's scope already
   exports its pure logic for its own test file.
5. This contract does not re-litigate whether `/org-learn`'s conversation-reading step (SKILL.md:12-14,
   already treating transcripts as untrusted data) needs changes — out of scope; only its guide.json-vs
   -rendered-block read path (step 1) is in scope here (OG-3).
