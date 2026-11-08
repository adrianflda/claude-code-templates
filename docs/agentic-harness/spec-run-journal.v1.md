# Spec — run journal: long-running runs survive a crash (v1, design)

Status: APPROVED (2026-11-07, decisions in §8; §8.4–8.6 added the same day after the J1 quality gate). J1 and J2 built; J3 in progress.

## 1. Goal

Autonomous quality-kernel runs (`/develop`, multi-repo features) last more than 24 hours; observed
Claude sessions on this machine have run for 4, 9 and 20 days (`ps -Ao etime`), resumed with
`claude --resume`. Today the only record of *progress* (which task is in flight, which gates passed,
at which SHA each repo stands) is the conversation context, which auto-compaction summarises
repeatedly. After a crash, reboot or OOM kill, the resumed agent has to infer where it was from
lossy summaries.

Goal: run progress lives **outside the agent's context**, in an append-only journal that a fresh
process (or a fresh subagent) can read; and resuming **checks the journal against git** (the
oracle), never trusting either the journal or the agent's memory alone.

Not goals: moving runs to a cloud sandbox (Managed Agents); a cost circuit-breaker (M3); replacing
`run-ledger.jsonl` (cost) or `evidence-ledger.jsonl` (evidence) — the journal records *state*.

## 2. Where it lives

`<org>/.quality-kernel/runs/<run-id>/journal.jsonl` — org level only (decision §8.3), because one run
spans several repos. The orgs in use are `~/Projects/Matchbox` and `~/Projects/personal`. `<run-id>`
comes from `process-safety/proc-tree.mjs#newRunId`. Never inside a product repo's tracked tree: an
append whose `--org` is inside a git repository is refused (exit 2) and creates nothing there. The
check fails closed: only git's own "not a git repository" answer (exit 128, read with `LC_ALL=C` and
no inherited `GIT_*` variable, so `GIT_CEILING_DIRECTORIES` cannot hide a repo) clears the folder; an
unreadable or unsupported repo (e.g. `core.repositoryformatversion` 99), dubious ownership or a
missing `git` → exit 2. Limit: a `.git` that git's discovery itself skips (e.g. not a directory git
recognises) is not seen.

Repos and worktrees are recorded by **name** (a plain sibling directory of the org folder), never by
path, and resolved at resume time: repos through `org.mjs#orgRepoDir` (same trust model as the org
gate), worktrees as real, non-symlinked sibling directories whose git common dir is the repo's
`.git`. A journal can therefore not point a resume at anything outside the org folder.

## 3. Records (one JSON object per line, `v: 1`)

| `type` | Fields | Written when |
|---|---|---|
| `run_started` | `run_id`, `plan_ref` (approved plan file), `repos: [{name, base_sha}]` | after the human approves the plan |
| `task` | `task_id`, `repo`, `branch`, `worktree`, `state`, `head_sha?`, `gate?: {exit, at}`, `reason?` | on every state transition |

`worktree` is required on every `task` record. `head_sha` is required from `committed` on, and a gate
result is for the committed `head_sha`. `gate` (both `exit` and `at`, an ISO-8601 UTC timestamp) is
present exactly on `gate_green` (exit 0) and `gate_red` (exit ≠ 0); `at` must be a real calendar
instant (`2026-02-30T00:00:00Z` is refused). `head_sha` and `base_sha` are full 40-hex (SHA-1) or
64-hex (SHA-256) ids. A `reason` belongs only to the
record that carries it: a later record without one (or a `decision`) does not inherit it, and a
`blocked` task without a reason is reported as `journaled`. Limits: `task_id` 1–64 characters of
`[A-Za-z0-9._-]`; `reason`, `plan_ref` and `ref` 1–500 characters.
| `decision` | `task_id`, `ref` (design file + `## Chosen option`) | a paused design decision is settled |
| `run_finished` | `verdict: pass\|fail\|kill` | Phase 5 |

Task states and the only legal transitions (§8.5):

```
(new) → pending → in_progress → committed → gate_green
                                          ↘ gate_red → in_progress (retry, at most 3 gate_red)
any state except gate_green → blocked (human needed; terminal until a `decision` record)
decision on a blocked task → pending (the retry count starts again)
```

A task starts in `pending`. After its **3rd** `gate_red` the only legal next state is `blocked`
(decision §8.4, the same budget as the anti-loop rule).

Every commit made for a task carries the trailer `QK-Task: <task_id>`, so git alone can say which
commits belong to which task.

## 4. Writer — `scripts/run-journal.mjs append`

- Validates the record (schema + legal transition from the folded current state); invalid → exit 2,
  nothing written (fail closed, same rule as `run-ledger.mjs`).
- Appends one line with `O_APPEND` + `fsync` before returning.
- Optimistic concurrency: every append states `--expect-seq N`, the number of records the caller
  last saw. If the journal holds a different number, another writer moved the run: exit 3, nothing
  written. Appends themselves are serialised by a short lock file (`journal.lock`, created with
  `createExclusive`; a dead holder is detected with `classifyLock` — both reached through the `process-safety/gate-session.mjs` facade).
  A lock held by a live process for longer than the wait is a conflict: exit 3.
- Taking over a dead holder's lock never deletes a lock it has not identified: the file is renamed
  aside and removed only if it is still the stale holder's (pid + start time), otherwise put back.
  The writer re-checks that it still owns the lock right before writing (lost lock → exit 3, nothing
  written), and releasing never turns a written record into a failure. Honest limit: the window
  between that re-check and the write is not closed (no `flock` in Node); `--expect-seq` bounds it
  only for two writers. With three (one dead holder, two taking over at once) two writers can each
  believe they own the lock after reading the same seq and both write: the journal then holds two
  records claiming the same position, possibly an illegal transition, and every later fold or resume
  exits 2 until a human repairs it. It fails loud (never a wrong plan), not silent [INFERRED: no test
  reproduces the three-writer interleaving].
- A torn tail left by a crash is truncated (under the lock, at the byte offset of the last newline)
  before the next record is written. The complete lines must be valid UTF-8 (decoded fatally);
  anything else is corruption (exit 2). The journal is opened `O_NOFOLLOW | O_NONBLOCK` and must be a
  regular file, so a FIFO or symlink in its place is refused instead of blocking.
- A record that would push the journal past 16 MiB (the reader's limit) is refused (exit 2), so the
  writer never produces a journal the reader would reject. A short write (e.g. disk full) is cut back
  to the previous end (exit 2, nothing written). An `fsync` that fails after the write → exit 2
  "written but not confirmed durable — fold before retrying" (the record may be there).
- The run directory is fsynced when the journal is created. Honest limit: Node's `fsync` on macOS is
  not `F_FULLFSYNC`, so a power cut (not a crash) can still lose the last records.

## 5. Resume — `scripts/run-journal.mjs resume --run <id>`

1. Fold the journal into current state. A torn last line (crash mid-write) is reported and ignored,
   never parsed. Corruption anywhere else → exit 2 (indeterminate).
2. Reconcile every task against git, read-only:
   - The task branch exists (else `branch_missing`) — except for a `pending` or `blocked` task that
     has no `head_sha` (it never committed): its branch may not have been created yet. A branch ref that exists but is broken
     (garbage, or naming a missing object) → exit 2, never `branch_missing`.
   - `head_sha` (from `committed` on) exists and is an ancestor of the task branch tip (else
     `sha_unreachable`).
   - Commits on a journaled branch, between the repo's `base_sha` and the tip, with
     `QK-Task: <id>` that are **not** in the journal → `orphan_commits` — for a task whose id is
     not in the journal at all, for commits of a task that has no `head_sha` yet (crash between
     commit and journal write), and for commits after a task's `head_sha` (`commits_after_green`
     when the task is `gate_green`). Only the branch's first-parent chain is read: commits merged in
     from elsewhere (e.g. `main`, carrying an earlier run's trailers) are not this branch's work.
     Limit: a fast-forward onto such commits puts them on the first-parent chain (→ divergence).
   - An active task (`in_progress`, `committed`, `gate_red`) must have its worktree, checked out on
     `refs/heads/<branch>` (else `worktree_missing` / `worktree_wrong_branch`).
   - An active task with a dirty worktree → listed in `blocked` with reason `dirty_worktree`; this is
     **not** a divergence and the run continues with the other tasks (decision §8.6). The
     orchestrator writes the `blocked` record; resume never stashes, resets or cleans.
   - Git is read with `--no-optional-locks` (not even the index is refreshed) through
     `run-journal/git.mjs`: **every** inherited `GIT_*` variable is dropped (`GIT_DIR`,
     `GIT_GRAFT_FILE`, `GIT_CONFIG_COUNT/KEY/VALUE`, `GIT_CONFIG_PARAMETERS`, `GIT_CEILING_DIRECTORIES`,
     …), then `GIT_NO_REPLACE_OBJECTS=1`, `GIT_ATTR_NOSYSTEM=1`, `GIT_GRAFT_FILE=/dev/null` (a repo's
     `info/grafts` is ignored too), `LC_ALL=C`; and every call passes `-c core.fsmonitor=false
     -c core.commitGraph=false -c core.useReplaceRefs=false -c trailer.separators=:
     -c log.showSignature=false` (plus `--no-show-signature` on `log`, so a repo's `gpg.program` never
     runs). So neither the caller's environment nor the repo's config or files can redirect resume,
     forge ancestry or hide `QK-Task` trailers. The dirty check runs `git status` with every configured filter
     driver emptied (`-c filter.<name>.clean=` / `smudge=` / `process=`, `required=false`; a driver
     name that cannot be overridden → exit 2) and `--ignore-submodules=dirty`, so no repo-configured
     filter runs and git does not descend into submodules. Limit: uncommitted changes inside a
     submodule's work tree are not seen (a moved submodule commit still is).
   - A git call that fails for any reason other than the condition it tests → exit 2 (indeterminate),
     never a divergence.
   - Honest limits of the reconcile: an unreadable refs directory is skipped silently by git and
     reads as a missing branch; a worktree path that exists but cannot be inspected (e.g. `EACCES`)
     → exit 2 by code, not covered by a test.
3. Re-run `qk-gate.mjs` once per repo on the **latest** `gate_green` SHA (not per task, to bound cost).
   Journal green + gate now red → divergence.
   - Only when step 2 found no divergence (a divergent run stops anyway; the gate is the costly step):
     `regate` is `null` when skipped, `[]` when the run has no confirmed green task.
   - Per repo, among the tasks git confirmed `done`, the one with the latest `gate.at` (ties: the
     greater task id). Command: `qk-gate.mjs --repo <repo> --base <run base_sha> --head <head_sha>
     --org <org> --no-ledger`. `--no-ledger` because the referee's evidence ledger lives inside the
     product repo and resume never writes there (INV-6); the gate reads committed trees, never a worktree.
   - Gate exit 1 → divergence `gate_red_now` (`{task_id, kind, repo, sha}`) and the task leaves `done`.
     Exit 0 or 3 (referee green; exit 3 only says a critical surface still needs the live breaker,
     which `gate_green` never claimed) → consistent. Any other exit or no exit → exit 2 (indeterminate).
   - Each run is reported in `regate`: `{repo, task_id, sha, exit, gate}`.
   - Limit: the other green tasks of the same repo (e.g. on other branches) are not re-gated; their
     SHAs are still checked against git in step 2.
4. Output a resume plan (JSON): `done` and `continue` (task ids), `blocked` (`{task_id, reason}`),
   `divergences` (`{task_id, kind, ...}`), `regate`, `torn_tail`.
   Exit 0 = consistent, continue · 1 = divergence, STOP and report · 2 = indeterminate.

The orchestrator never continues past exit ≠ 0.

## 6. Integration

- `commands/develop.md` Phase 3: write `run_started` after approval; write a `task` record on every
  transition; at start, if `runs/` holds a run without `run_finished`, run `resume` first.
- Each task runs in a **short-lived subagent** that receives only `task_id` + journal path + its
  worktree, and exits after commit + gate. The orchestrator context stays small; the journal is what
  lives for days.
- Launch guidance in `docs/agentic-harness/usage.v1.md`: long runs under `tmux` + `caffeinate -i`.

## 7. External Observable Invariants

Each invariant is a falsifiable predicate with its probe, and each probe must be seen **RED** against
a deliberately broken resume (one that trusts the journal blindly) before it is trusted.

| ID | Predicate | Probe |
|---|---|---|
| INV-1 | After `kill -9` of the orchestrator at any phase, `resume` reports exactly the set of tasks that were `gate_green` before the kill, each with its SHA reachable from its branch. | `run-journal.crash.test.mjs` — fixture org with 2 repos; a scripted orchestrator paused at each step (append or commit) and SIGKILLed there; compare resume against the orchestrator's own log of confirmed appends (not the journal itself) and against git |
| INV-2 | A task `gate_green` before the crash gets zero new commits after resume. | `git rev-list <green_sha>..<branch> --grep 'QK-Task: <id>'` is empty after a resumed run (resume lists the task in `done`, never `continue`); a commit that breaks it is reported as `commits_after_green` (`run-journal.test.mjs`, "INV-2 probe") |
| INV-3 | A torn last line is reported and ignored; it never changes state. | truncate journal mid-line; `resume` exit 0 + `torn_tail: true`; fold equals fold without the line |
| INV-4 | Journal says green but the SHA is gone or the gate is red → `resume` exits 1 naming the task. | rewrite the fixture branch (`sha_unreachable`) / a green SHA the real gate rejects (`gate_red_now`): the fixture org's verify fails on a `*.txt` holding `BROKEN`; seen RED by a resume that skips the re-gate |
| INV-5 | Two writers appending at the same `--expect-seq` → exactly one succeeds, the other exits 3; the journal gains exactly one record. | spawn two `append` processes with the same seq |
| INV-6 | `resume` never modifies a worktree (no stash/reset/clean/checkout). | every resume in `run-journal.test.mjs`: walk of the org folder (mode, size, mtime of each entry, the journal's directory excluded) identical before and after; plus the dirty-worktree snapshot |

INV-6 is checked on **every** resume of the suite (not only the dirty-worktree test): a walk of the
whole org folder (mode, size and mtime of every entry, the journal's own directory excluded) is
identical before and after. INV-1's reachability half goes RED through the orphan and
`sha_unreachable` tests; among the crash kill points only those between a commit and its append
discriminate a resume that trusts the journal blindly.

Honest limits of the probes: INV-1 kills the orchestrator between steps, never inside an `append`
(a torn write is covered by INV-3 and the torn-tail tests instead); INV-5 is also checked in-process
with a second writer injected between the first one's checks and its write. The window between
opening the journal for write and writing is not closed against a path swap by another user.

## 8. Decisions (Adrian, 2026-11-07)

1. `/orchestrate-project` no longer exists: `develop` drives `/forge` per feature itself, with the
   journal as its state. The reference in `commands/develop.md` is removed (J3).
2. Re-gate on resume: once per repo at the latest `gate_green` SHA (J2).
3. Journal at org level; the orgs are `~/Projects/Matchbox` and `~/Projects/personal` (the latter
   needs `/org-init` so its repos resolve through the org guide).

4. Retry cap: at most 3 `gate_red` per task; after the 3rd only `blocked` (validated by the schema).
5. Transitions: a task starts in `pending`; any state except `gate_green` may go to `blocked`.
6. A dirty worktree on resume blocks that task only (`blocked`, exit 0); the run continues.

## 9. Slices

- **J1** — `run-journal.mjs` (`append`, `fold`, `resume` read-only reconcile) + INV-1/3/5/6 tests.
- **J2** — re-gate in `resume` + INV-2/4. Built: `run-journal/regate.mjs`; 9/9 mutants of the re-gate killed.
- **J3** — `develop.md` integration, `QK-Task` trailer, short-lived task subagents, usage doc.
