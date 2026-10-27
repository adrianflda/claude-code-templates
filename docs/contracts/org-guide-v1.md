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

**Scope cut, 2026-10-27 (Adrián, human decision):** hand-edit detection via a render hash (formerly
OG-5), crash-mid-write atomic convergence (formerly OG-21) and concurrent-apply locking (formerly OG-22)
are REMOVED from this contract after repeated blind-review rounds found the three requirements
internally contradictory and under-specified (see the 4th review,
`/private/tmp/claude-501/-Users-adrian-Projects-Matchbox/95a36532-8806-41b7-8319-f0e3f391c2f7/scratchpad/org-guide-v1.review4.md`).
They are replaced by one simple rule (OG-1, OG-6): the CLAUDE.md block is **generated** output of
`guide.json`; every apply re-renders it and **overwrites** whatever is currently between the markers,
including a hand edit. No `renderHash` field. Concurrency and mid-write-crash handling are now a
documented single-writer assumption in §9 Residual risks, not an acceptance criterion. Every ID that
existed only for the removed requirements is kept in place and marked "Removed (scope cut 2026-10-27)"
below, so old references stay traceable.

## 0. Critical compatibility fact (read first)

OBSERVED: a real, live `guide.json` already exists at
`/Users/adrian/Projects/Matchbox/.claude/org-workspace/guide.json` (read-only, not modified by this
work). It has **no `"version"` field** and no map-summary field of any kind — just `org`, `repos`,
`forbidden`, `truth`, `conventions`, `threads`. It is read by `plugins/quality-kernel/scripts/org.mjs:
92-109` (`readOrgManifest`) and hashed whole by `org.mjs:114-134` (`orgPin`), consumed by
`qk-org-gate.mjs:27-29` (`readOrgManifest`, `orgPin`, `orgRepoDir`) which gates the Matchbox org's real
repos. **Every criterion below that changes `guide.json`'s shape must keep this file readable with zero
manual migration step**, or it must say explicitly why not (it does not: see OG-8).

OBSERVED, found during the blind-review repair round (2026-10-26, `ls`/`cat`, read-only): a real, live
**`map-summary.json` also exists**, next to that `guide.json`, at
`/Users/adrian/Projects/Matchbox/.claude/org-workspace/map-summary.json` (492 bytes, 6 entries, shape
`[{from,to,n}]` — exactly the carried-forward summary shape `buildGuide` already produces today). OG-1/
OG-4 retire this file; without a migration rule, the very first guide-only re-apply on the real
Matchbox org folder after this ships would silently drop the "Who calls whom" section from its
CLAUDE.md (today's six real cross-repo pairs), contradicting the "zero manual migration" requirement
just as much as an unversioned `guide.json` would. **OG-4 below specifies a one-time fold-in of this
legacy file**, the same shape of fix as OG-8's version grandfather.

## 1. Scope — 24 panel findings, CONFIRMED or REFUTED with evidence

Legend: file:line is the panel's citation; "current" line numbers from my own read are noted only
where they drift from the panel's citation (expected — the panel reviewed a diff hunk, not final
HEAD; the logic, not the line number, is the fact that matters).

| # | Sev | Citation | Verdict | Evidence (OBSERVED) | Covered by |
|---|---|---|---|---|---|
| F1 | HIGH | org-guide.mjs:38 | CONFIRMED | Read org-guide.mjs, org-map.mjs, quality-kernel/org.mjs, skills/org-learn/SKILL.md:10. Three stores exist: rendered block in CLAUDE.md, `guide.json` (read by quality-kernel `org.mjs:92-109`), `map-summary.json` (written/read by org-guide.mjs:163-169,195-197). `SKILL.md:10` literally instructs "rebuild `guide.json`" by reading the rendered block — a lossy reverse-parse, confirmed by reading the file. | OG-1, OG-2, OG-3, OG-4, OG-6 |
| F2 | HIGH | org-guide.mjs:182 | CONFIRMED | `validateGuide` (org-guide.mjs:52) rejects any key not in `['org','repos','forbidden','truth','conventions','threads']` — no `version`. `readOrgManifest` (quality-kernel org.mjs:92-109) reads `g.repos`/`g.forbidden` only, no version check either. Confirmed the real Matchbox `guide.json` has no version field (§0). | OG-7, OG-8, OG-9 |
| F3 | MEDIUM | org-guide.mjs:152 | CONFIRMED by execution | Ran `buildGuide` with an `unmatched[].reason` containing a bare `AKIAABCDEFGHIJKLMNOP`: **accepted**, would be written to `SYSTEM-MAP.md`. `buildGuide` calls `validateIntegrations(integrations, { repos })` with no `secretIn` (org-guide.mjs:152), so `org-map.mjs`'s `textHasSecret` falls back to `hasValueSecret` only (org-integrations.mjs:44,64), which does not run `redact`'s `SECRET_TOKENS` (org-profile.mjs:25-26: AKIA/ASIA/ghp_/github_pat_/sk-/xox/JWT) or its URL-userinfo rule. | OG-10 |
| F4 | MEDIUM | org-guide.mjs:44 | CONFIRMED by execution | `readGuideForbidden` on a CLAUDE.md with BEGIN and no END returned `[]` (ran it). | OG-2 |
| F5 | MEDIUM | org-guide.mjs:181 | CONFIRMED by execution | Symlinked `guide.json`, called `applyGuide`: it threw (correctly), but `CLAUDE.md` was already rewritten with the new block before the throw. | OG-12 |
| F6 | MEDIUM | org-guide.mjs:41 | CONFIRMED by execution | Same function: a symlinked CLAUDE.md and an END-before-BEGIN file both returned `[]` instead of throwing (ran both). | OG-2 |
| F7 | MEDIUM | org-guide.mjs:189 | CONFIRMED | Same defect as F5 (applyGuide writes CLAUDE.md at line 190 before the guide.json/summary/map symlink checks at 192/195/199) — one underlying bug, two citations in the panel's diff view. | OG-12 |
| F8 | MEDIUM | org-profile.mjs:77 | CONFIRMED (code read; Node's documented 1 MiB `spawnSync` default) | org-profile.mjs:78 `git(dir, ['ls-tree',...])` passes no `opts`, so `safe-git.mjs:22`'s `spawnSync` default `maxBuffer` (1 MiB) applies; `profile()` does check `ls.status !== 0` and throws `cannot list the tree of...` (line 79), matching the panel's description of the failure mode. Not reproduced against a literal 25k-file repo (time budget); the absence of an explicit `maxBuffer` option is a direct code read, not inference. | OG-13 |
| F9 | MEDIUM | org-integrations.mjs:73 | CONFIRMED | org-integrations.mjs:72: `git(dir, ['ls-tree',...]).stdout.split('\0')` — no `maxBuffer`, **and no status check at all** (worse than F8: a failed spawn would throw on `.stdout` being undefined, or on Node ≥ newer versions return truncated stdout silently depending on the failure mode), confirmed by direct read. | OG-13 |
| F10 | MEDIUM | org-guide.mjs:186 | CONFIRMED | Read `org-guide.test.mjs` in full (218 lines): the only CLAUDE.md-symlink test is for `build()` (line 102-111); no test symlinks `guide.json`, `map-summary.json` or `SYSTEM-MAP.md` and calls `applyGuide`. My own F5 repro is exactly the missing case. | OG-19(a) |
| F11 | MEDIUM | org-guide.test.mjs:168 | CONFIRMED | Read the `'map refused'` table (lines 158-178): all 12 cases vary `edge` fields only; none exercises `unmatched[].evidence` (the `cite()` call at org-map.mjs:115). | OG-19(b) |
| F12 | MEDIUM | entrypoint.mjs:1 | CONFIRMED | `diff`ed the three shared files against quality-kernel's copies: `safe-git.mjs` and `hermetic-git.mjs` are **byte-identical** (confirmed empty diff) yet their comments say "the gate" (safe-git.mjs:1) and `.quality-kernel/` (hermetic-git.mjs:3) — quality-kernel-specific language copied verbatim into a different plugin. `entrypoint.mjs`/`is-main.mjs` have **already diverged**: different export name (`isEntrypoint` vs `isMain`) and different logic (quality-kernel added a plain-path fast-check before the realpath fallback). quality-kernel's CHANGELOG.md:28-29 confirms `entrypoint.mjs` was deliberately removed there in favour of `is-main.mjs`, then re-added here. | OG-16 |
| F13 | MEDIUM | org-guide.mjs:24 | CONFIRMED | Read all five scripts: `redact` in org-profile.mjs:27; `redactLine`/`hasValueSecret` in org-integrations.mjs:64-65; `isRepoName` in org-guide.mjs:31 (imported by org-discover.mjs:18) **and separately redefined** in quality-kernel/org.mjs:30 with a different regex (see Residual risks — not one of the 24, found during this audit); `CONTROL` defined independently in org-guide.mjs:34, org-map.mjs:31, and again inline in org-map.mjs:133 (`tick`); `MAX_TEXT` is 200 in org-guide.mjs:33 vs 300 in org-map.mjs:28; `validateGuide` checks secrets via `redactLine(v) !== v.slice(0,400)` (org-guide.mjs:56) while org-map's `text()` uses `textHasSecret` (org-integrations.mjs:44) — two different secret checks. | OG-10 |
| F14 | LOW | org-discover.mjs:42 | CONFIRMED by execution | `stripCredentials('user:p@ss@host:O/a.git')` → `'ss@host:O/a.git'` (ran it) — the tail of the password leaks into the inventory. | OG-14 |
| F15 | LOW | org-guide.mjs:143 | CONFIRMED by execution | Built `END + BEGIN + rest` (END immediately before BEGIN) and called `spliceBlock`: did not throw, result has **2** `BEGIN` markers (ran it; `result.split(BEGIN).length - 1 === 2`). | OG-11 |
| F16 | LOW | org-discover.mjs:36 | CONFIRMED by execution | `stripCredentials('https://github.com/O/a.git?next=x@evil/y')` → `'https://evil/y'` (ran it) — wrong host, corrupts `remoteKey`-based copy detection. | OG-14 |
| F17 | LOW | ai-review-panel.mjs:446 | CONFIRMED by faithful re-execution | Copied `boundDiffBytes` verbatim (same constants: `MAX_DIFF_LINES=3000`, `lineBudget=2950`) into a standalone harness, fed it one file using 2940 of the 2950-line budget plus 60 tiny files that get skipped: total line count came out to **3007** (over `MAX_DIFF_LINES`), the post-hoc truncation at ai-review-panel.mjs:477-482 then fired and cut the footer from 60 listed names down to **54** — 6 skipped-file names silently lost. | OG-17 |
| F18 | LOW | org-guide.mjs:149 | CONFIRMED | org-guide.mjs:150: `try { ...profile... } catch { /* not a profilable repo: not citable */ }` — swallows every error (integrity failure, bad package.json, missing base branch) with no record; the repo silently drops out of `repos`, so a later "X is not a selected repo" error hides the real cause. | OG-15, OG-19(f) |
| F19 | LOW | org-guide.mjs:167 | CONFIRMED | org-guide.mjs:164-169: an unreadable/invalid `map-summary.json` is dropped in a `catch {}` with only a code comment, no stderr warning, no exit-code signal. Post-migration (OG-1/OG-4) the equivalent source is the summary field carried forward from the existing `guide.json`, not a separate file. | OG-4, OG-19(c) |
| F20 | LOW | org-guide.mjs:160 | CONFIRMED | Read the test at org-guide.test.mjs:211-218: only the happy-path carry-forward is tested; no malformed JSON, no shape-invalid entry (`from: '../x'`), no symlinked `map-summary.json` case. Post-migration, the carried-forward field is read from `guide.json` itself (OG-4), so the symlink case is already covered by OG-19(a)'s `guide.json` symlink test. | OG-4, OG-19(a), OG-19(c) |
| F21 | LOW | org-discover.mjs:122 | CONFIRMED | Read org-discover.test.mjs in full: every copy-detection test (`'app'`/`'app (Copy)'`/`'dup'`) includes a repo named like the remote (`'app'`), so the `if (!original) { ...shares its origin with... }` branch (org-discover.mjs:122) is never hit by any test. | OG-19(d) |
| F22 | LOW | entrypoint.mjs:8 | CONFIRMED | Grepped every org-workspace test file for `symlink` + confirmed no CLI test invokes a script through a symlinked path — all `symlinkSync` uses target CLAUDE.md or a repo dir, never the scripts directory itself. | OG-19(e) |
| F23 | LOW | ai-review-panel.mjs:474 | **REFUTED** | Re-ran the exact same harness as F17: `diffLines` after `boundDiffBytes` was **3007 > 3000**, so the "pre-existing truncation… can no longer trigger" claim is empirically false in the very scenario F17 describes — the post-hoc truncation DID fire (and is in fact the only thing bounding that pathological case, albeit by corrupting the footer). The remedy "remove it" would delete the only remaining cap for that case. The underlying maintainability point (one budget mechanism, not two half-overlapping ones) is real but is subsumed into OG-17, which fixes the interaction instead of deleting either half. | OG-17 (F23 excluded as a standalone fix item) |
| F24 | LOW | docs/agentic-harness/spec-init-workspace.v1.md:1 | CONFIRMED | `spec-init-workspace.v1.md` presents the M1 generator as "BUILT, WIP"; quality-kernel's CHANGELOG.md:106 says "The automatic gate-config generator (M1: ws-propose / ws-verify / ws-command) is retired" (0.10.0). `spec-workspace-memory.v1.md` describes `WORKSPACE.md` + `/workspace-learn` (lines 15-42); the shipped plugin uses the CLAUDE.md block + `/org-learn` (org-guide.mjs, skills/org-learn/SKILL.md) — a different, later design with no pointer from the old doc to the new one. | OG-18 |

**Count: 23 CONFIRMED, 1 REFUTED (F23).**

*(OG-21 and OG-22 were added during the blind-review repair round, 2026-10-26, not tied to one of the
24 panel findings above — raised by `contract-review.mjs`'s two isolated reviewers rather than by the
pre-push panel. Both, and OG-5, were REMOVED on 2026-10-27 by human decision — see the scope-cut note
at the top of this file and §9 Residual risks.)*

## 2. The five design questions — firm recommendations

**1. Single source of truth.** `guide.json` is authoritative; the CLAUDE.md block becomes a pure,
deterministic *render* of `guide.json`, never a parse source — `readGuideForbidden` reads
`guide.json.forbidden` directly, and `/org-learn` reads and edits `guide.json`, never the rendered
markdown. The "who calls whom" summary moves **into** `guide.json` as one of its own fields: one file,
one authoritative shape, nothing to go out of sync going forward. `map-summary.json` is retired — with
exactly one, one-time exception: a `guide.json` that has never yet recorded a summary field but finds a
legacy `map-summary.json` on disk folds it in once (OG-4's migration clause; the real Matchbox org
folder has exactly this file today, found during this contract's own repair round — §0). After that one
fold-in, `map-summary.json` is never read again by anything. **Carry-forward, precisely:** when the
guide tool builds a guide *without* a new `--integrations` map, it reads the who-calls-whom summary out
of the `guide.json` **already on disk** (the one the previous apply wrote) and copies that field into
the new `guide.json` unchanged — there is no second file to read; "the summary source" for a guide-only
re-apply *is* the existing `guide.json`, read like any other part of it (same symlink refusal as reading
it for any other purpose — OG-2's unwanted branch). If that existing `guide.json`'s summary field is
present but not shaped as the schema requires (not an array, or an entry missing `from`/`to`/`n`, or `n`
not a non-negative integer), THE SYSTEM SHALL print a warning naming the problem to stderr and proceed
with **no** "Who calls whom" section in the new render, rather than silently dropping it with no signal
(closes F19/F20 for the new, single-file shape; folded into OG-4 below). *Trade-off:* `guide.json`
carries one more (tool-generated) field than a human would author by hand, but this removes the
regex-parse-a-rendered-document failure classes (F1's lossy round-trip, F19/F20's silent data loss)
instead of patching them individually.

**Hand edits — the simple rule (scope cut 2026-10-27, replacing the removed OG-5 render-hash design):**
the CLAUDE.md block is generated output, full stop. Every apply re-renders it fresh from the current
`guide.json` and **overwrites** whatever is currently between the markers, whether that is the tool's
own previous output or a hand edit made since. There is no hash, no detection, no refusal case for a
hand edit, and no `renderHash` (or equivalent) field in `guide.json`'s schema — `validateGuide` SHALL
NOT require or expect one. The marker text (OG-6) tells the reader up front that edits inside it do not
survive the next apply and that `/org-learn` is how to make a change stick. *Trade-off:* a hand edit is
silently lost on the next apply rather than detected and refused — simpler and fully specified, at the
cost of the safety net the removed OG-5 tried (and, across three review rounds, failed) to specify
correctly; Adrián's explicit call (2026-10-27) was that this simpler, fully-specified rule is worth more
than a safety net this contract could not pin down without contradicting itself (see the 4th review,
cited at the top of this file, and §9 Residual risks).

**2. Schema version.** Add `"version": 1`, stamped by the tool on every write (the human/agent-authored
`--guide` input does not need to supply it). `validateGuide` accepts it; `readOrgManifest` in
quality-kernel checks it. Compatibility path for the real, unversioned Matchbox `guide.json` (§0): a
**missing** `version` is read as `1` (one-time grandfather — the shape is otherwise identical to v1),
so the live gate keeps working with **zero manual migration**; the very next `/org-init` or
`/org-learn --apply` on that org folder stamps `version: 1` in automatically. An **explicit** version
that is not `1` fails closed with a specific, named error distinct from `findOrg`'s existing generic
"no usable org guide…" text (quality-kernel org.mjs:154) — see OG-8's exact required message content —
never a silent partial read. *Trade-off:* the grandfather clause is itself debt — a future v2 cutover
needs an explicit decision about when "missing = 1" stops being honoured (see Residual risks).
`--org-pin`/`orgPin` (quality-kernel org.mjs:114-134) is already a pure content hash of the current bytes
of `guide.json` plus everything under `.quality-kernel/repos/`; it needs no special-casing — it already
changes the moment the file's bytes change (including the moment `version` is stamped in), which is the
existing, correct, fail-closed behaviour (`findOrg`, org.mjs:160).

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
state before the call (today's CLAUDE.md-first write order violates this, F5/F7/F10). This is OG-12,
a direct panel finding; it is kept in full — only the (separately removed) crash-mid-write and
concurrent-apply requirements are cut, not this one.

## 3. EARS acceptance criteria

**OG-1 (ubiquitous).** THE SYSTEM SHALL treat `<org>/.claude/org-workspace/guide.json` as the sole
authoritative record of the org guide's repos, forbidden list, sources of truth, conventions, threads
and who-calls-whom summary. The managed block of `<org>/CLAUDE.md` SHALL be **generated** output derived
only from `guide.json`, never an independent store: every apply SHALL re-render the block fresh from the
current `guide.json` and overwrite whatever currently sits between the markers, including a hand edit
made there since the last write — THE SYSTEM SHALL NOT detect, refuse on, or otherwise treat a hand
edit as special (the removed OG-5 attempted this across three review rounds and could not be specified
without contradicting itself; see the scope-cut note above). `guide.json`'s schema SHALL NOT include a
render-hash or other hand-edit-detection field.

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

**OG-4 (ubiquitous + event).** THE SYSTEM SHALL persist the who-calls-whom summary (one row per
caller/provider pair with its count) as a field inside `guide.json` itself; no separate summary file
(e.g. `map-summary.json`) SHALL exist or be read, even transitionally. WHEN a guide is built without a
new `--integrations` map, THE SYSTEM SHALL carry the summary forward by reading it from the `guide.json`
already on disk (not a separate file), subject to the same symlink refusal as any other read of
`guide.json` (OG-2). IF that existing summary field is present but does not match the required shape
(not an array, or an entry missing `from`/`to`/`n`, or `n` not a non-negative integer), THEN THE SYSTEM
SHALL print a warning to stderr naming the problem and proceed with no "Who calls whom" section in the
new render, rather than silently dropping it with no signal.
WHERE `guide.json` has no summary field yet and no previous apply by this tool has ever recorded one,
but a legacy `map-summary.json` file exists at `<org>/.claude/org-workspace/map-summary.json`, THE
SYSTEM SHALL read it under the same symlink refusal as any other guide-related file (IF it is a symlink
THEN the apply SHALL refuse, writing nothing, same as OG-12) and, IF its content is a valid
`[{from,to,n}]` shape, fold it into `guide.json` as that guide's summary field on the next apply
(one-time migration, mirroring OG-8's version grandfather) rather than silently losing it — IF its
content is present but not that shape, THEN the malformed-summary warning above applies instead of a
crash. `/Users/adrian/Projects/Matchbox/.claude/org-workspace/map-summary.json` (§0) is a real instance
of the valid case.

**OG-5 — Removed (scope cut 2026-10-27).** Was: hand-edit detection via a `guide.json`-recorded render
hash, refusing an apply when the on-disk CLAUDE.md block's hash did not match it. Replaced by OG-1's
simple generate-and-overwrite rule; see the scope-cut note at the top of this file.

**OG-6 (ubiquitous).** THE SYSTEM's marker text in a rendered block SHALL tell the reader that the block
is generated and will be overwritten by the next apply, and that changes SHALL be made through
`/org-learn`, not by editing the block directly.

**OG-7 (ubiquitous).** THE SYSTEM SHALL write `"version": 1` into every `guide.json` it persists,
regardless of whether the proposed guide content supplied to the tool included a version field.

**OG-8 (state + unwanted).**
WHILE a `guide.json` has no `version` field at all, THE SYSTEM (both the org-workspace writer and the
quality-kernel reader) SHALL treat it as version 1, so a pre-existing guide.json such as
`/Users/adrian/Projects/Matchbox/.claude/org-workspace/guide.json` keeps working with no manual
migration step.
IF a `guide.json` has an explicit `version` the reader does not support, THEN THE SYSTEM SHALL fail
closed, and the error surfaced by the caller-facing entry point (`findOrg`, used by `qk-org-gate.mjs`,
`route.mjs` and `referee.mjs`) SHALL contain, at minimum, the unsupported version's value and the word
"version" and either "upgrade" or "migrat(e/ion)" — e.g. `org guide: unsupported version 2 (this
plugin supports version 1) — upgrade quality-kernel or migrate the guide to version 1`. This replaces
`findOrg`'s existing generic "no usable org guide…" text for this specific case (an unsupported
explicit version is a different, more specific condition than an absent or malformed `guide.json`,
which keeps the existing generic message); THE SYSTEM SHALL NOT fall back to a partial or best-effort
read.

**OG-9 (ubiquitous).** THE SYSTEM's `--org-pin` (quality-kernel `orgPin`) SHALL remain a pure content
hash of the current bytes of `guide.json` plus every file under `.quality-kernel/repos/`, recomputed
fresh each time; no special-casing for `version` or any other field SHALL be needed for the pin to
change correctly when those bytes change.

**OG-10 (ubiquitous).** THE SYSTEM SHALL apply exactly one secret-detection rule, one single-
line/control-character/length text rule and one repo-name rule to all user- or agent-supplied text
accepted into the guide or the integration map.

*Secret-detection rule:* the one rule SHALL detect, at minimum, the union of every pattern today's
`redactLine` (org-integrations.mjs) already covers: AWS-style `AKIA`/`ASIA` access-key-ids, `ghp_`/
`github_pat_` GitHub tokens, `sk-`/`sk_` Stripe-style secret keys, `xox`-prefixed Slack tokens, a
JWT-shaped three-part `eyJ…` string, a quoted value immediately after a key/token/secret/password/auth
name, a `Bearer`/`Basic`/`Token` header value, a long quoted high-entropy literal, and a URL carrying
`user:password@host` userinfo. `redactLine` is the canonical existing implementation of this union —
the unified predicate SHALL detect at least what it detects, and `buildGuide`'s call into integration
validation SHALL use it (not just `hasValueSecret`, which today covers only part of this union) as the
`secretIn` scanner, so a bare access-key-shaped token or a credentialed URL in an edge's `note`,
`endpoint`, or an unmatched entry's `reason`/`endpoint` is refused, not just a quoted value next to a
key/token/secret name. The refusal error's text SHALL contain the substring "secret-looking value"
(today's existing wording, e.g. validateGuide's `${name} contains a secret-looking value`) in both the
guide path and the map path, so a test asserting on that substring (INV-OG-6, INV-OG-24, the Gherkin
scenario) is checking a real, stable requirement rather than one implementer's arbitrary phrasing.

*Text rule:* a single-line, control-character-free string of 1 to **300** characters. "Control-
character-free" and "single-line" SHALL mean, at minimum, rejecting everything today's org-guide.mjs
`CONTROL` regex already rejects — the canonical existing implementation, exactly:
`/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/` (C0 controls including `\n`/`\r`,
`DEL`, C1 controls, and the bidi-override characters a path/name could use to make a rendered string
read differently than its bytes). Measured the same
way today's `v.length` checks already do (JavaScript string length / UTF-16 code units — consistent
with org-guide.mjs's and org-map.mjs's existing `MAX_TEXT` checks; this is a different unit from
`BLOCK_BUDGET`'s UTF-8 byte count in OG-12, by design, since one bounds a single field and the other
bounds the whole rendered block). 300 is the larger of
today's two existing limits — org-map.mjs's 300, not org-guide.mjs's 200 — chosen because widening is
non-breaking: no text the live Matchbox guide or SYSTEM-MAP.md already carries today becomes invalid,
whereas narrowing to 200 could reject existing map entries between 201 and 300 characters). This is the
per-field text budget; it is independent of `BLOCK_BUDGET` (4096 bytes), the separate, whole-rendered-
block size cap referenced by OG-12.

*Repo-name rule, scoped:* within org-workspace's own two validators (`validateGuide` and
`validateIntegrations`), THE SYSTEM SHALL use exactly one repo-name pattern for anything accepted into
`guide.json` (repo names, `forbidden[]`, `harnessOf`) or matched against the map's selected repos: the
existing org-guide.mjs pattern, `^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$` (no spaces, no parentheses, 100-char
cap). This rule is deliberately **not** unified with quality-kernel org.mjs's separate `isRepoName`
(which allows spaces and parentheses and has no length cap): that regex validates "is this a safe
sibling-directory-name component for the filesystem" for any directory quality-kernel might be asked to
gate (including an oddly-named one it should still refuse safely, never one it should curate), while
org-workspace's regex validates "is this a name allowed to be typed into the curated guide" (a stricter,
narrower, human-facing set) — e.g. a directory literally named `app (Copy)` is a real, valid,
`kind: 'copy'` filesystem entry `org-discover` already classifies (org-discover.test.mjs:34,41) but is
deliberately never `suggested` for the guide and SHOULD continue to fail `isRepoName` if someone tries
to add it to `guide.repos[]` by hand. The two rules are allowed to keep differing for this reason; this
narrows and resolves Residual risk #2 below rather than leaving it open.

**OG-11 (unwanted).** IF the text between an END marker and the following BEGIN marker is empty (the
END sits immediately before the BEGIN with no separating or intervening content), THEN THE SYSTEM
SHALL treat that as an END-before-BEGIN ordering error and throw, rather than silently retaining the
stray END and producing two BEGIN markers in the result.

**OG-12 (unwanted + event).** WHEN the guide tool applies a built guide, THE SYSTEM SHALL check every
write-target precondition (each of CLAUDE.md, guide.json and SYSTEM-MAP.md: not a symlink; valid
content; and, for the rendered CLAUDE.md block specifically, no larger than **4096 bytes**
(`BLOCK_BUDGET`, today's existing, tested limit — org-guide.mjs:29 and the test at
org-guide.test.mjs:95-100 — kept unchanged, measured on the rendered block's UTF-8 byte length, not its
character count) before writing any of them. IF any precondition fails, THEN THE SYSTEM SHALL write
none of the target files, and every target file SHALL remain byte-identical to its state before the
call. (Per-field text length is a separate, smaller limit — 300 characters per OG-10 — already folded
into "valid content" above.)

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
identical, byte-for-byte, across the org-workspace and quality-kernel plugins' source in this repo —
quality-kernel's existing `safe-git.mjs`, `hermetic-git.mjs` and `is-main.mjs`/`isMain` (the export name
and the plain-path-fast-check-then-realpath logic) are authoritative where the two plugins' copies
diverge today (F12), since quality-kernel's CHANGELOG already documents `is-main.mjs` as the maintained,
tested successor; org-workspace's copies SHALL be brought to match. The "repo-level check" that enforces
this going forward is an automated, repo-committed check — e.g. a `node --test` case — that fails
(non-zero exit) when any pair diverges; INV-OG-11's `diff` already states the observable pass/fail
condition that check must implement.

**OG-17 (ubiquitous).** THE SYSTEM's diff-budgeting for the pre-push review panel SHALL ensure the
final reviewed text (kept content plus the skipped-files footer, if any) never exceeds the configured
line budget, and SHALL ensure that when files are skipped, every skipped file's name that is reported
as "not reviewed" is actually present in the output (the footer itself is never partially cut by a
later truncation step).

**OG-18 (ubiquitous).** THE SYSTEM's design docs for a retired or superseded design SHALL carry a
visible "Superseded" status with a pointer to the design or plugin that replaced it.

**OG-19 (ubiquitous — test coverage).** THE SYSTEM's automated test suite SHALL include, at minimum,
one case each for:
(a) a symlinked `guide.json`, a symlinked `SYSTEM-MAP.md` (built with a valid `--integrations` map, so
`SYSTEM-MAP.md` is actually a write target that run — a guide-only apply never touches it), and a
symlinked `CLAUDE.md` (the literal F5/F7 scenario — today's suite covers a symlinked CLAUDE.md only for
`build()`, never for `applyGuide()`), each asserting that `applyGuide` throws and every other file is
unchanged (post-migration there is no separate summary file in ongoing use — OG-4 — so a symlinked
`guide.json` already covers every read of it, including the carry-forward read; the one-time legacy
`map-summary.json` migration has its own case, (g) below);
(b) an `unmatched[].evidence` citation that is malformed, missing, or points past a file's end,
asserting the map build throws and nothing is written;
(c) an existing on-disk `guide.json` whose who-calls-whom summary field is malformed (not an array) or
shape-invalid (an entry missing `from`/`to`/`n`, or a non-integer `n`), asserting that a guide-only
re-apply (no new `--integrations`) still succeeds, produces no "Who calls whom" section, and prints the
warning required by OG-4 — not a crash and not silent data loss;
(d) two repos that share a remote with neither named like it, asserting both keep kind `repo` and each
names the other in its reason;
(e) the entrypoint/is-main check invoked through a symlinked script path, asserting it still runs
(non-empty output, exit 0);
(f) a guide whose integration map names a repo that cannot be profiled (e.g. its declared base branch
does not exist), asserting the build's reported problems name both that repo and the real profiling
error (OG-15) rather than only a later, unrelated "not a selected repo" message;
(g) the legacy `map-summary.json` migration (OG-4): a `guide.json` with no summary field yet, next to a
valid legacy `map-summary.json`, asserting the next apply folds it in; the same setup with a
**symlinked** `map-summary.json`, asserting the apply refuses (symlink discipline applies to the
one-time migration read too) rather than following it; and the same setup with a shape-invalid legacy
`map-summary.json`, asserting the warning behavior of OG-4's malformed-summary clause fires instead of a
crash;
(h) a hand edit made inside the markers since the last apply, asserting the next apply overwrites it
with a fresh render of the current `guide.json` (OG-1's generate-and-overwrite rule) — not a refusal,
not a preserved edit.

**OG-20 (ubiquitous — consumer).** THE SYSTEM SHALL keep `plugins/quality-kernel/scripts/org.mjs`'s
`readOrgManifest` (org.mjs:92-109), `orgPin` (org.mjs:114-134) and `findOrg` (org.mjs:141-162), and
their callers `qk-gate.mjs:39-47`, `qk-org-gate.mjs:27-29`, `route.mjs:169-212` and
`referee.mjs:126-183`, working unmodified against both the pre-existing (unversioned) and the new
(versioned) `guide.json` shape. This SHALL be verified without ever running anything against the real
`/Users/adrian/Projects/Matchbox` folder (per §5's preamble): a **byte-for-byte, read-only copy** of
`/Users/adrian/Projects/Matchbox/.claude/org-workspace/guide.json`'s current content is placed into a
disposable temp org folder, with **no real `mbvs-*` repo directories checked out under it** — none are
needed, because `readOrgManifest` only parses JSON (org.mjs:92-109 never touches the filesystem beyond
that one file) and the `org-guide.mjs --apply` call this verification makes (QA step 8, INV-OG-12) is
given **no `--integrations` flag**, so `buildGuide` never enters its per-repo `profile()` branch
(org-guide.mjs's `if (integrations !== null)` guard) and never needs any of the guide's listed repos to
exist as real directories. `readOrgManifest`/`findOrg` SHALL resolve the same `repos`/`forbidden` set
from that copy as they do today, both before and after this contract's schema changes ship. (A
*separate*, full `qk-org-gate.mjs` run against real checked-out `mbvs-*` repos is not part of this
criterion's required, automated verification — see the optional check below.) (An engineer who wants an
additional, purely informational sanity check against the live folder
MAY optionally run `route.mjs --repo <a real app repo under the org> --base <its real base ref> --org
/Users/adrian/Projects/Matchbox` by hand — `route.mjs` only classifies a diff's risk tier and reads
config, it writes nothing — but this is not part of the required, automated verification of this
criterion, and no agent SHALL run it as part of an automated probe.)

**OG-21 — Removed (scope cut 2026-10-27).** Was: atomic, crash-recoverable multi-file apply (temp-file-
then-rename writes; convergent re-apply after an interruption). Cut together with OG-5/OG-22 after
review found the three mutually dependent and unable to be specified without contradiction. See §9
Residual risks (single-writer assumption).

**OG-22 — Removed (scope cut 2026-10-27).** Was: a lock serializing concurrent applies to the same org
folder, with stale-lock recovery. Cut together with OG-5/OG-21. See §9 Residual risks (single-writer
assumption).

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

  Scenario: a hand edit inside the markers is overwritten by the next apply
    Given a guide applied once with --apply
    And a user hand-edits text inside the BEGIN/END markers of CLAUDE.md
    When the guide tool is run again (with the same, or a different, guide.json content) and applied
    Then it succeeds (no refusal, no error about the hand edit)
    And the CLAUDE.md block now exactly matches a fresh render of the applied guide.json
    And the hand-edited text is gone

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

All probes (every row of this table, and the automated QA steps of §7) run against a freshly created
temp org folder (`mktemp -d`), never against `/Users/adrian/Projects/Matchbox` — that real path is only
ever **read** (a `cp` of one file, §7 step 8), never written to and never the `--org` target of a write
or gate run performed by this contract's required verification. OG-20's one *optional, manual, human-
run, read-only* sanity check (`route.mjs`, which only classifies risk and reads config — it writes
nothing) is explicitly not part of the required automated probes and is not listed in this table.

| ID | Predicate (falsifiable) | Probe command |
|---|---|---|
| INV-OG-1 | `readGuideForbidden`/`org-discover`'s deny set equals `guide.json`'s `forbidden` array, not whatever CLAUDE.md's prose happens to say | build and apply (via `org-guide.mjs --apply`, so the CLAUDE.md block and its markers are whatever the real tool currently writes — this probe never hand-types a marker string) a guide with `forbidden: ["y"]` and a repo directory `y` present in the org; then separately, by hand, edit the live `guide.json`'s `forbidden` array to `["x"]` only (leaving the already-written CLAUDE.md block, which still says "y", untouched); run `node plugins/org-workspace/scripts/org-discover.mjs --org "$ORG"`; assert its `forbidden`/deny set is `["x"]`, not `["y"]` — proving the deny set tracks `guide.json`, not the stale rendered text |
| INV-OG-2 — Removed (scope cut 2026-10-27) | was: a hand-edited block with no lock file present makes the next apply refuse | superseded by INV-OG-26 (a hand edit is overwritten, not refused) |
| INV-OG-3 | a `guide.json` with no `version` field is accepted by quality-kernel's `readOrgManifest` and treated as version 1 | `node --input-type=module -e "import {readOrgManifest} from 'plugins/quality-kernel/scripts/org.mjs'; import {mkdtempSync, mkdirSync, writeFileSync} from 'node:fs'; import {tmpdir} from 'node:os'; import {join} from 'node:path'; const d=mkdtempSync(join(tmpdir(),'inv3-')); mkdirSync(join(d,'.claude','org-workspace'),{recursive:true}); writeFileSync(join(d,'.claude','org-workspace','guide.json'), JSON.stringify({org:'t',repos:[{name:'web',role:'app',base:'main'}],forbidden:[]})); const m=readOrgManifest(d); process.exit(m && m.repos.web ? 0 : 1);"` |
| INV-OG-4 | an explicit unsupported `version` (e.g. 2) makes `findOrg` return an error containing the version number, the word "version", and "upgrade" or "migrat(e/ion)" — never a usable workspace | in a temp org with one real stub git repo `web` (as org-guide.test.mjs's fixture creates) and an applied guide whose `.claude/org-workspace/guide.json` is then hand-edited to `"version": 2`: `node --input-type=module -e "import {findOrg} from 'plugins/quality-kernel/scripts/org.mjs'; const r=findOrg(process.argv[1], {org:process.argv[2]}); const ok = r && r.error && /2/.test(r.error) && /version/i.test(r.error) && [/upgrad/i, /migrat/i].some(re => re.test(r.error)) && !r.dir; process.exit(ok?0:1);" "$ORG/web" "$ORG"` |
| INV-OG-5 | `orgPin` changes when `guide.json`'s bytes change (including a version stamp being added) and does not change when they don't | `node --input-type=module -e "import {orgPin} from 'plugins/quality-kernel/scripts/org.mjs'; import {writeFileSync, mkdirSync, mkdtempSync} from 'node:fs'; import {tmpdir} from 'node:os'; import {join} from 'node:path'; const d = mkdtempSync(join(tmpdir(), 'inv5-')); mkdirSync(join(d, '.claude', 'org-workspace'), {recursive: true}); const p = join(d, '.claude', 'org-workspace', 'guide.json'); writeFileSync(p, JSON.stringify({org:'t', repos:[], forbidden:[]})); const a = orgPin(d); const b = orgPin(d); writeFileSync(p, JSON.stringify({org:'t', repos:[], forbidden:[], version:1})); const c = orgPin(d); process.exit(a === b && a !== c ? 0 : 1);"` |
| INV-OG-6 | an unquoted AWS-access-key-shaped literal or a `user:pass@host` URL inside an edge's `note` or an unmatched entry's `reason`/`endpoint` makes `buildGuide` throw, and `SYSTEM-MAP.md` is not written, even with `--apply` requested | `node plugins/org-workspace/scripts/org-guide.mjs --org "$ORG" --guide guide.json --integrations bad-integrations.json --date 2026-10-26 --apply; echo "exit=$?"; test -f "$ORG/SYSTEM-MAP.md" && echo FAIL \|\| echo OK` (with `bad-integrations.json` containing an `unmatched[].reason` carrying `AKIAABCDEFGHIJKLMNOP`; expect non-zero exit and `OK`) |
| INV-OG-7 | `applyGuide` writes nothing when any target (CLAUDE.md, guide.json, SYSTEM-MAP.md) is a symlink — not just the ones checked today | for CLAUDE.md and guide.json: symlink the path to a file outside the org folder, run `org-guide.mjs --org "$ORG" --guide guide.json --date 2026-10-26 --apply` (no `--integrations` needed), assert non-zero exit and the other file (and the symlink's target) byte-identical to before the run. For SYSTEM-MAP.md specifically: symlink it, then run the SAME command **with a valid `--integrations` map supplied** (so SYSTEM-MAP.md is actually a write target this run — a guide-only apply with no `--integrations` never touches it and would pass vacuously), assert non-zero exit and that CLAUDE.md/guide.json (and the symlink's target) are byte-identical to before the run |
| INV-OG-8 | an END immediately before a BEGIN never produces two BEGIN markers in the spliced result | `node --input-type=module -e "import {spliceBlock,BEGIN,END} from 'plugins/org-workspace/scripts/org-guide.mjs'; try { const r = spliceBlock(END+BEGIN+'x', BEGIN+'y'+END); process.exit(r.split(BEGIN).length-1<=1?0:1); } catch { process.exit(0); }"` |
| INV-OG-9 | `stripCredentials` leaves no password fragment for an scp-style remote whose password contains `@` | `node --input-type=module -e "import {stripCredentials} from 'plugins/org-workspace/scripts/org-discover.mjs'; const r=stripCredentials('user:p@ss@host:O/a.git'); process.exit(r==='host:O/a.git'?0:1);"` |
| INV-OG-10 | `stripCredentials` does not let a query-string `@` relocate the host | `node --input-type=module -e "import {stripCredentials} from 'plugins/org-workspace/scripts/org-discover.mjs'; const r=stripCredentials('https://github.com/O/a.git?next=x@evil/y'); process.exit(r==='https://github.com/O/a.git'?0:1);"` |
| INV-OG-11 | `plugins/org-workspace/scripts/safe-git.mjs` and `hermetic-git.mjs` are byte-identical to `plugins/quality-kernel/scripts/safe-git.mjs` and `hermetic-git.mjs`; the entrypoint helpers are identical in logic and export name | `diff plugins/org-workspace/scripts/safe-git.mjs plugins/quality-kernel/scripts/safe-git.mjs && diff plugins/org-workspace/scripts/hermetic-git.mjs plugins/quality-kernel/scripts/hermetic-git.mjs && diff plugins/org-workspace/scripts/entrypoint.mjs plugins/quality-kernel/scripts/is-main.mjs` (all three must exit 0) |
| INV-OG-12 | a disposable fixture carrying the real Matchbox `guide.json`'s exact current byte content resolves the same `repos`/`forbidden` set through `readOrgManifest`/`findOrg`, before and after the schema-version change — the real org folder itself is never touched | `FIX=$(mktemp -d); mkdir -p "$FIX/.claude/org-workspace"; cp /Users/adrian/Projects/Matchbox/.claude/org-workspace/guide.json "$FIX/.claude/org-workspace/guide.json"; node --input-type=module -e "import {readOrgManifest} from 'plugins/quality-kernel/scripts/org.mjs'; const m=readOrgManifest(process.argv[1]); process.stdout.write(JSON.stringify({repos:Object.keys(m.repos).sort(), forbidden:m.forbidden.sort()}));" "$FIX" > before.json; node plugins/org-workspace/scripts/org-guide.mjs --org "$FIX" --guide "$FIX/.claude/org-workspace/guide.json" --date 2026-10-26 --apply; node --input-type=module -e "import {readOrgManifest} from 'plugins/quality-kernel/scripts/org.mjs'; const m=readOrgManifest(process.argv[1]); process.stdout.write(JSON.stringify({repos:Object.keys(m.repos).sort(), forbidden:m.forbidden.sort()}));" "$FIX" > after.json; diff before.json after.json && echo OK` (the copy at `$FIX` is write-/apply-tested freely; `/Users/adrian/Projects/Matchbox` itself is opened only once, read-only, by the `cp`) |
| INV-OG-13 | the pre-push-review footer is never truncated: every name counted in "N file(s) not reviewed" is present in the output | feed `boundDiffBytes`'s packing logic (invoked through the shipped script, or its exported function once testable per OG-19) one large file plus 60+ tiny ones that overflow the line budget; assert the printed/returned "file(s) not reviewed" count equals the number of listed names, and that no further truncation step removes any of them |
| INV-OG-14 — Removed (scope cut 2026-10-27) | was: an apply interrupted mid-write converges rather than refuses | the crash-recovery criterion (OG-21) it tested is removed |
| INV-OG-15 — Removed (scope cut 2026-10-27) | was: two concurrent applies never interleave their writes | the concurrency criterion (OG-22) it tested is removed |
| INV-OG-16 | the unified text-length/control-character rule accepts/rejects identically whether the text reaches it through guide validation or map validation | feed a 301-character string, a string with a `\u0000` byte, and a valid ≤300-character plain string as `guide.truth[0].note` (guide path) and as an edge's `note` (map path) in two otherwise-valid builds; assert both paths reject the 301-character and control-character cases with a "single-line" error and both accept the ≤300-character case |
| INV-OG-17 | the unified repo-name rule accepts/rejects identically whether a name reaches it through `guide.repos[].name`/`forbidden[]` (guide path) or an edge's `from`/`to` (map path, where the name must also be one of the selected, profiled repos) | feed the name `"../x"` (path traversal) and the name `"good-name"` as a repo name in both `validateGuide` and `validateIntegrations`; assert both reject `"../x"` with an "invalid repo name" error and both accept `"good-name"` as syntactically valid (the map path then separately may still reject it for not being a selected repo, which is a different, already-covered check) |
| INV-OG-18 | a `git ls-tree` whose output exceeds Node's default 1 MiB `spawnSync` capture does not silently truncate `profile()`'s or `extract()`'s file list, and does not crash with an unhandled I/O error | PATH-shadow `git` with a wrapper script (the `loggingGit()` idiom in org-discover.test.mjs) whose `ls-tree` subcommand prints a deterministic, known-count (e.g. exactly 50,000) >1.5 MiB NUL-separated fake path list and delegates every other subcommand to the real `git`; run `org-profile.mjs --repo <a real tiny repo>` with that `git` first on `PATH`; parse stdout as JSON if the process exits 0 — its `files` field (profile()'s own file count) SHALL equal exactly 50,000, not a smaller, silently-truncated number; if the process instead exits non-zero, stderr SHALL be non-empty single-line text (a thrown `Error.message`, not a raw stack trace / uncaught-exception dump) |
| INV-OG-19 | an unprofilable repo named in the guide is reported by name and reason among the build's problems | build a guide listing a repo `x` whose declared `base: "no-such-branch"` does not exist in that repo (with a real `--integrations` map so the profiling branch runs); assert `buildGuide` throws an error whose text contains both the literal repo name `x` and the substring `no-such-branch` (today's `resolveBase`'s own wording is `base branch "..." not found locally or on origin` — any wording is acceptable as long as it names the repo and the specific branch, not only a later, unrelated "is not a selected repo" message) |
| INV-OG-20 | both superseded design docs carry a visible "Superseded" marker pointing at their replacement | `for f in docs/agentic-harness/spec-init-workspace.v1.md docs/agentic-harness/spec-workspace-memory.v1.md; do grep -qi superseded "$f" && grep -qi org-workspace "$f" && echo "$f: OK" \|\| echo "$f: FAIL"; done` — both lines must print `OK` |
| INV-OG-21 | the rendered block's marker comment names `/org-learn` as the way to make changes, and says the block is generated/will be overwritten | build and apply any valid guide in a temp org; `grep -c '/org-learn' "$ORG/CLAUDE.md"` is at least 1, inside the marker comment line itself (not only elsewhere in the block) |
| INV-OG-22 | a legacy `map-summary.json` (no summary ever recorded in `guide.json` yet) is folded into `guide.json` once, a symlinked one is refused, and a shape-invalid one only warns | three temp orgs: (1) write a valid `[{from,to,n}]` `map-summary.json` next to a summary-less `guide.json`, apply, assert the new `guide.json` now carries that summary and the block shows "Who calls whom"; (2) symlink `map-summary.json` to a file outside the org, apply, assert non-zero exit and every file unchanged; (3) write `map-summary.json` as `{"not":"an array"}`, apply, assert exit 0, a stderr warning, and no "Who calls whom" section |
| INV-OG-23 — Removed (scope cut 2026-10-27) | was: a stale lock left by a crashed holder does not permanently block future applies | the lock mechanism (OG-22) it tested is removed |
| INV-OG-24 | the unified secret rule rejects more than just the one AKIA shape INV-OG-6 exercises — at least one representative of each other pattern OG-10 lists, through both the guide path and the map path | for each of: `ghp_` + 36 alphanumerics, `sk-live-` + 24 alphanumerics, `xoxb-` + 10 alphanumerics, a 3-part `eyJ…`.`eyJ…`.`xxx` JWT-shaped string, `Bearer ` + 20 alphanumerics, `https://user:pass@host/x` — place it, in turn, as (a) `guide.truth[0].note` and rebuild the guide, and (b) an edge's `note` in an integration map and rebuild; assert every one of the 6 values is refused with a "secret-looking value" error in BOTH (a) and (b), i.e. 12 refusals total |
| INV-OG-25 | `plugins/org-workspace/skills/org-learn/SKILL.md` instructs reading `guide.json` directly and never instructs reconstructing guide content by parsing the rendered CLAUDE.md block (OG-3) | `F=plugins/org-workspace/skills/org-learn/SKILL.md; grep -qi 'guide\.json' "$F"; HAS_GUIDE=$?; grep -qi 'rebuild guide\.json from' "$F"; HAS_REBUILD=$?; test "$HAS_GUIDE" -eq 0 -a "$HAS_REBUILD" -ne 0 && echo OK; echo "exit: see OK above"` — must print `OK`; a reviewer reading the file by hand on any change to it should also confirm step 1 names `guide.json` as what is read and proposed against, not "the current block in CLAUDE.md" |
| INV-OG-26 | a hand edit inside the markers is overwritten by the next apply — not detected, not refused, not preserved (OG-1, replaces the removed render-hash check) | build+apply a guide in a temp org; hand-edit one character inside the markers; re-run the same apply; assert exit 0 and that CLAUDE.md's block is now byte-identical to a fresh render of the just-applied `guide.json` (recompute the expected render independently and `diff` it against the on-disk block) |

## 6. Minimal example input shapes (for QA steps 3 and 10)

A minimal `guide.json` proposal (step 3's `--guide guide.json`; the human/agent-authored input — no
`version`/summary field, the tool stamps those on write):

```json
{
  "org": "Acme",
  "repos": [{ "name": "web", "role": "app", "base": "development" }],
  "forbidden": []
}
```

A minimal integrations map carrying a bare access-key-shaped secret (step 10's
`--integrations bad-integrations.json`; `edges` may be empty, `unmatched` is enough to trigger OG-10):

```json
{
  "edges": [],
  "unmatched": [
    { "from": "web", "endpoint": "GET /x", "evidence": "a.js:1", "reason": "uses key AKIAABCDEFGHIJKLMNOP for auth" }
  ]
}
```

(`a.js:1` must be a real, non-blank, committed line in the `web` repo for the citation check itself to
pass before the secret check is reached — see org-map.mjs's `cite()`, already exercised by F3's
reproduction in §1.)

## 7. End-to-end QA procedure (CLI only)

1. `ORG=$(mktemp -d)`; create two tiny git repos `web` and `api` inside it, each on branch
   `development` with one committed file (as the existing `org-guide.test.mjs` fixture does).
2. Run `node plugins/org-workspace/scripts/org-discover.mjs --org "$ORG"` — confirm both repos are
   listed, `forbidden` is `[]` (no guide.json yet — OG-2's ubiquitous branch).
3. Write a `guide.json` proposal (no `version` — simulating a hand-authored or /org-learn-proposed file)
   and run `node plugins/org-workspace/scripts/org-guide.mjs --org "$ORG" --guide guide.json --date
   2026-10-26 --apply`. Confirm: exit 0; `CLAUDE.md` now has the block; `guide.json` now has
   `"version": 1` (OG-7).
4. Hand-edit text inside the CLAUDE.md block's markers. Re-run the same apply command with the same
   `guide.json` content. Confirm: exit 0 (no refusal, no error), and the block is now back to exactly
   what a fresh render of `guide.json` produces — the hand edit is gone (OG-1, OG-19(h), INV-OG-26).
5. Symlink `guide.json` to a file outside `$ORG`. Run the apply again with a legitimately changed
   guide (e.g. an added thread). Confirm: non-zero exit, and `diff` shows CLAUDE.md is still
   byte-identical to step 4's result (OG-12, INV-OG-7). Remove the symlink and restore guide.json.
6. Run `node plugins/quality-kernel/scripts/org.mjs`-backed `qk-org-gate.mjs --org "$ORG" --branch
   development` and confirm it resolves `web`/`api` from the guide (OG-20).
7. **Machine-specific — skip if `/Users/adrian/Projects/Matchbox/.claude/org-workspace/guide.json` is
   not present on this machine; INV-OG-3/INV-OG-4 below already cover the version-handling logic itself
   with no dependency on this one file.** `FIX=$(mktemp -d)`; `cp` the real, read-only
   `/Users/adrian/Projects/Matchbox/.claude/org-workspace/guide.json` into
   `$FIX/.claude/org-workspace/guide.json` (the real org folder itself is opened only for this one read;
   nothing is ever written back to it, and no real `mbvs-*` repo is ever checked out under `$FIX`: this
   step calls `readOrgManifest($FIX)` directly — the same function `qk-org-gate.mjs`/`findOrg` call, and
   it only parses JSON — and separately runs `node plugins/org-workspace/scripts/org-guide.mjs --org
   "$FIX" --guide "$FIX/.claude/org-workspace/guide.json" --date 2026-10-26 --apply` with **no
   `--integrations` flag**, so `buildGuide` never enters its per-repo `profile()` branch and never needs
   any of the guide's repos to exist as real directories — a full `qk-org-gate.mjs` gate run against real
   checked-out `mbvs-*` repos is explicitly NOT required here). Confirm it is
   accepted as version 1 (an object with every repo name from the real file in `.repos`), with the copy
   at `$FIX` unmodified by the read (OG-8, INV-OG-3, INV-OG-12).
8. Separately (self-contained, no real Matchbox content needed — `findOrg` needs a real repo
   directory, which the real `mbvs-*` repos are not available to check out here): reuse `$ORG` from step
   1 (its `web`/`api` repos and the guide applied in step 3); hand-edit its `.claude/org-workspace/
   guide.json`'s `"version"` field to `2`; run `findOrg(<path to $ORG/web>, { org: $ORG })` (the
   caller-facing entry point `qk-org-gate.mjs`/`route.mjs`/`referee.mjs` all use). Confirm it returns
   `{ error }` whose text matches OG-8's required template, not a usable `{dir,pin,name}` (OG-8,
   INV-OG-4). Restore `$ORG`'s guide.json afterward.
9. Feed `org-guide.mjs --integrations` a map containing a bare `AKIA…`-shaped token in a `reason`;
   confirm the build throws "secret-looking value" and `SYSTEM-MAP.md` is not written (OG-10,
   INV-OG-6).
10. Run `diff` across the three vendored helper files between the two plugins (INV-OG-11); confirm all
    three are identical.
11. Re-run the full existing `node --test` suite for `plugins/org-workspace/scripts/*.test.mjs` and
    `plugins/quality-kernel/scripts/org*.test.mjs`; confirm green, plus the new cases from OG-19.
12. PATH-shadow `git` with the `loggingGit()`-style wrapper of INV-OG-18, returning a >1.5 MiB `ls-tree`
    for a tiny repo; run `org-profile.mjs` and `org-integrations.mjs` against it; confirm neither
    silently truncates the file list nor crashes with an uncaught error (OG-13).
13. Build a guide listing a repo whose declared base branch does not exist; confirm the build's error
    names that repo and the real profiling failure (OG-15, OG-19(f)).
14. Run INV-OG-20's loop over both design docs; confirm both print `OK` (each contains "superseded"
    AND names "org-workspace") (OG-18).
15. After any apply, `grep '/org-learn' "$ORG/CLAUDE.md"` on the marker comment line; confirm a match
    (OG-6).
16. Per INV-OG-22: in a fresh temp org, apply a summary-less guide, then hand-place a valid legacy
    `map-summary.json` (e.g. a copy of the real file's shape, §0) before the next apply; confirm it is
    folded into `guide.json` and the block shows "Who calls whom". Repeat with the file symlinked
    (confirm refusal, nothing written) and with an invalid shape (confirm a warning, no crash, no
    section) (OG-4).
17. Per INV-OG-24: repeat step 9 for each of the other five listed secret shapes (`ghp_`, `sk-live-`,
    `xoxb-`, a JWT-shaped string, a `Bearer ` token) and for a credentialed URL in `guide.truth[0].note`;
    confirm every one is refused in both the guide path and the map path, not only the AKIA case (OG-10).
18. Grep `plugins/org-workspace/skills/org-learn/SKILL.md` for language instructing the skill to read
    `guide.json` and never to reconstruct guide content from the rendered CLAUDE.md block (OG-3); confirm
    no instruction to "rebuild guide.json" or similar by parsing the block remains.

## 8. Glossary

- **Org folder** — a directory holding several repos as siblings (e.g. `~/Projects/Matchbox`), with
  its own `CLAUDE.md` loaded by every session rooted there.
- **Guide** — the small, budgeted record of where the truth of each thing lives in the org (repos,
  forbidden repos, sources of truth, conventions, open threads, who-calls-whom summary).
- **Guide block** — the managed, marker-delimited section of `<org>/CLAUDE.md` rendered from the
  guide; **generated output, not hand-maintained** — every apply overwrites it (OG-1).
- **Org pin (`--org-pin`)** — a content hash of the whole org config (`guide.json` plus every file
  under `.quality-kernel/repos/`) that quality-kernel re-checks before, during and after a gate run.
- **Grandfather (version)** — the one-time rule that a `guide.json` with no `version` field is read as
  version 1, so a file written before this contract shipped keeps working.
- **Deny set** — the forbidden-repo list `org-discover` refuses to open, listed under `candidates[].
  forbidden`/`forbiddenBy` and the inventory's top-level `forbidden` array; a synonym used in OG-2 and
  INV-OG-1 for "the guide's `forbidden` array plus any `--forbid`/`--exclude` option."
- **`harnessOf`** — an optional field on a `guide.repos[]` entry naming the `app`-role repo a
  `harness`-role repo tests (e.g. `mbvs-client-v2-qa-local`'s `harnessOf: "mbvs-client-v2"`); its value
  SHALL itself be a valid repo name under the same repo-name rule as everything else in `guide.json`
  (OG-10).
- **Evidence citation** — the `"path:line"` string an integration-map edge or unmatched entry uses to
  point at the committed source line that makes or serves a call (e.g. `"src/api/eventAPI.js:2"`).
  "Malformed" means it does not match that `path:line` shape (or uses `.`/`..` path segments);
  "points past a file's end" means the line number is greater than the file's actual line count at the
  repo's profiled commit — both are refused by org-map.mjs's `cite()`.

## 9. Residual risks

1. **(HIGHEST — needs a human decision before the version grandfather is removed.)** The "missing
   version = 1" rule is permanent debt: nothing currently forces the real Matchbox `guide.json` to ever
   gain an explicit `version` field unless `/org-init` or `/org-learn --apply` is actually re-run on
   that org folder. If a future v2 schema ships and the grandfather rule is ever tightened to "missing
   version = refuse," an org folder that has not been re-applied since this change will suddenly start
   failing closed. Recommend: track this explicitly (e.g., an open thread in the guide itself, or a
   quality-kernel warning when it reads a guide with no `version`) rather than relying on memory.
2. **Resolved during the blind-review repair round (see OG-10's "repo-name rule, scoped"):** a third,
   independently defined `isRepoName` was found during this audit at
   `plugins/quality-kernel/scripts/org.mjs:27-30`, with a **different** regex (allows spaces and
   parentheses, no length cap) than org-workspace's `org-guide.mjs:30-31` (no spaces/parens, 100-char
   cap). This is not one of the panel's 24 findings (it is cross-plugin, not within org-workspace).
   OG-10 now states explicitly that these two rules are **not** meant to unify — they validate different
   things (curated guide membership vs. filesystem path safety for any sibling directory) — so this is
   no longer an open question for the coder to resolve either way; it is a documented, intentional
   difference.
3. **Narrowed during the blind-review repair round:** F8/F9 (large-repo `ls-tree` truncation) were
   confirmed by code reading and Node's documented `spawnSync` default, not by reproducing against an
   actual ~25k-file repo. OG-13 now has a PATH-shadowed-`git`-stub probe (INV-OG-18) and a QA step using
   the `loggingGit()` idiom already in `org-discover.test.mjs`, which exercises the real failure mode (an
   oversized `ls-tree` output) without needing a literal 25k-file repo. What remains deferred to the
   hardener: confirming the fix against an actual large real-world repo, which this contract's budget did
   not allow.
4. F17/INV-OG-13's probe assumes `ai-review-panel.mjs`'s diff-budgeting logic becomes unit-testable in
   isolation (it currently exports nothing — this is a script, not a module). Making that one function
   importable is the minimum testability surface OG-19/INV-OG-13 need; which function, and under what
   name, is the coder's choice, consistent with how every other script in this contract's scope already
   exports its pure logic for its own test file.
5. This contract does not re-litigate whether `/org-learn`'s conversation-reading step (SKILL.md:12-14,
   already treating transcripts as untrusted data) needs changes — out of scope; only its guide.json-vs
   -rendered-block read path (step 1) is in scope here (OG-3).
6. **Scope cut, 2026-10-27 (human decision — Adrián):** crash-mid-write atomicity and concurrent-apply
   locking (formerly OG-21/OG-22) are OUT OF SCOPE for this contract after three review rounds could not
   pin them down without contradicting OG-5 (also cut). This contract makes a documented **single-writer
   assumption**: at most one `/org-init`/`/org-learn --apply` runs against a given org folder at a time,
   and a process is not expected to crash mid-write. If it does crash mid-write, or if two applies race,
   `guide.json`/CLAUDE.md/SYSTEM-MAP.md may end up inconsistent with each other with no specified
   recovery — a human re-running a clean apply is the expected fix. Revisit if quality-kernel's org mode
   becomes frequently automated or concurrent.
