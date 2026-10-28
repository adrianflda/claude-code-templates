# pre-push-review

A portable, versioned **Claude Code plugin** that runs an expert panel of code reviewers
before **every `git push`** and **blocks the push on critical findings** — one review per
push, by Claude or by a human, in every repo, including repos that use husky.

## Why this exists

The multi-agent pre-push review used to run twice per push and still left gaps:

- the Claude Code hook reviewed the push, and then a global `core.hooksPath` pointing at an old,
  unversioned copy of the harness in `~/.config/git-ai-review/` reviewed it again;
- repos that set their own `core.hooksPath` (husky) never ran that global copy, so a human
  `git push` there was not reviewed at all.

The plugin now has **one review, at the git level**, plus a **guard on the Claude side**.

## What it does

Two parts, with one job each.

**1. The gate: `scripts/git-pre-push.mjs`, run by git.** The installer
(`scripts/install-git-hook.mjs`) registers it once, in the *global* git config, as a config
hook:

```
[hook "ai-review"]
    event = pre-push
    command = node <plugin>/scripts/git-pre-push.mjs
```

Config-based hooks (git 2.54+) run in every repository, **also when the repository sets its own
local `core.hooksPath`** (husky and similar run after it, as usual). On every `git push`, from
anywhere, the gate reviews exactly what git says is being pushed, streams the panel output to
the terminal and keeps the full output in `~/.cache/git-ai-review/review-<sha>.log`.

For every ref git lists on the hook's stdin, the gate computes the commits the remote does not
have yet and runs the bundled panel on that range
(`scripts/ai-review-panel.mjs --range <base> <head>`):

| Push | Reviewed |
|---|---|
| to a ref the remote already has | `<remote tip>..<pushed tip>` |
| a new branch | its commits that are on no ref of that remote |
| the first push to an empty remote | every commit, from the empty tree |
| a branch that is not checked out (`git push origin feat` while on `main`) | that branch, not `HEAD` |

A pushed commit the repository does not have blocks the push. When git's ref list cannot be
read, the gate falls back to the panel's own guess (`--branch`).

- **Reviewed, nothing blocking** → exit 0, the push proceeds.
- **Nothing to review** (deleting a branch, or the remote already has every pushed commit) → exit 0.
- **Critical issue found** → the push is **blocked**; the report is on the terminal.
- **No reviewer could run** → blocked.
- **The panel is missing, killed, timed out or cannot start** → blocked (fail closed).
- **No skip switch is honored.** `AI_REVIEW_SKIP`, `PREPUSH_REVIEW_SKIP` and
  `AI_REVIEW_REQUIRED=0` are ignored by the gate: the panel always runs, and always as required.

**Quality gate on push (opt-in per repository).** Before the panel, a repository can have every
pushed range re-verified by the quality-kernel gate (`qk-gate.mjs`, which re-runs the base's tests
against the pushed code). A repository opts in in its org config, outside the repository:
`<org>/.quality-kernel/repos/<name>/tools.json` with `"runOnPush": true`, where `<org>` holds an
org guide (`.claude/org-workspace/guide.json`) and `<name>` is the main checkout's folder (a push
from a linked worktree is gated against the main checkout). The gate script is found next to this
plugin, at `../quality-kernel/scripts/qk-gate.mjs`; there is no variable to point it elsewhere.

| Gate outcome | Push |
|---|---|
| exit 0, verified | continues to the panel |
| exit 3, verified on a critical surface | continues to the panel, with a warning: the live breaker and a human review are still needed before merge |
| exit 1, the base's tests fail on the pushed code | **blocked** |
| exit 2, indeterminate: the gate could not run (memory pressure, no contract, ...) | **blocked** |
| missing gate script, unreadable `tools.json`, a push with no base commit, an unreadable ref list, timeout, any other exit | **blocked** |

A repository without `"runOnPush": true` (or outside an org) is not gated; its push runs the panel
only, as before. The opt-in is per repository because a gate run takes as long as the suite, twice.
A gated push can therefore take the gate's time plus the panel's: from Claude, push with
`run_in_background: true` (a foreground Bash call is capped at 600000 ms), and keep the SSH
connection alive (`GIT_SSH_COMMAND="ssh -o ServerAliveInterval=30"`). The gate runs with
`--no-ledger`, so it writes nothing into the repository.

**2. The guard: `scripts/prepush-gate.mjs`, a Claude Code `PreToolUse` hook.** It never runs the
panel (no double review). On a Bash command that contains a real `git push` it only checks that
the push will go through the gate, and blocks otherwise:

- the repository the push leaves from cannot be known (`cd $DIR && git push`, `--git-dir`,
  `xargs git push`) or is not a repository;
- the global gate is not active for that repository: `git hook list pre-push` must list
  `ai-review`, it must not be disabled or redefined outside the global config, and its command
  must point at an existing `git-pre-push.mjs` (the message tells the user to run the installer);
- bypass attempts: `--no-verify` on the push, `-c core.hooksPath=...`, `-c hook....`,
  `--config-env`, and `GIT_CONFIG_*`, `PREPUSH_REVIEW_SKIP`, `AI_REVIEW_SKIP` or
  `AI_REVIEW_REQUIRED` set on the command or exported in the session's environment;
- `git config` commands that change `hook.ai-review.*` or `core.hooksPath` (Claude is told to
  ask the user; this applies even without a push in the command);
- a Bash call that would be killed before the review finishes: the review runs inside
  `git push` and takes minutes, so the call needs `timeout` of at least `600000` or
  `run_in_background: true`. Claude is told to retry with `timeout 600000`.

The guard never sets `permissionDecision`: whether the push may run stays with the normal
permission flow. The old "commit and push in one command" block is gone, because the git hook
runs at push time, after the commit exists.

### Which repository the guard checks

The guard follows the command to the repository the push leaves from:

| Command | Checked repository |
|---|---|
| `git push` | the session's working directory |
| `cd ../worktree && git push` | `../worktree` |
| `git -C ../worktree push` | `../worktree` |
| `cd $DIR && git push` | none: blocked, because the directory cannot be known without running the command |
| `git --git-dir ... push`, `GIT_DIR=... git push`, `xargs git push` | none: blocked for the same reason |

A push behind `env`, `command` or `sudo`, after `then` or `do`, inside `$( ... )` or inside
`bash -c '...'` is found too. Text inside quotes or inside a here-document is not read as a
command, unless the here-document is fed to a shell. When the words of a command say
`git ... push` and the guard cannot place it (for example `sudo -u deploy git push`), the
push is blocked, not skipped.

### Deleted files

Deleted files are part of the review. The reviewers get each one as a header with its name
and no content, so removed code does not use up the diff budget. A push that only deletes
files is reviewed; it is not reported as "no changes".

The panel is up to 8 independent specialist reviewers, each constrained to one branch of review:

| Agent | Focus |
|---|---|
| Security & Privacy | authz/authn, tenant isolation, injection, secret/PII leakage |
| Correctness & Logic | logic bugs, null hazards, bad state transitions, breaking changes |
| Error Handling & Reliability | swallowed errors, races, idempotency, resource leaks |
| Performance & Scale | N+1, unbounded loops/fetches, hot-path waste |
| Test Coverage & Quality | untested branches, weak assertions, flaky patterns |
| Maintainability & Design | boundaries, duplication, dead code, leaky abstractions |
| Readability & Simplicity | comments that explain what the code should make obvious, jargon or invented terms in names and comments, designs more complex than the goal needs (always with the simpler alternative); at most `medium` unless it hides a correctness risk |
| Fit to the ticket | runs only when ticket text is found: does the change do what the ticket's "Done when" and business reason ask, and does it add a rule or exemption the ticket contradicts; `high` when the design contradicts an explicit requirement |

Each reviewer ingests the repo's own guidance (`CLAUDE.md` / `.github/copilot-instructions.md`
/ `AGENTS.md` / `.cursorrules`), so the generic panel auto-adapts per project.

### Ticket context

The other reviewers only see the diff, so they cannot tell when a well-written change does the
wrong thing. The "Fit to the ticket" reviewer gets the ticket text as well:

- with `--pr <n>`: the PR title and body, plus the issues they reference;
- otherwise (a push, `--branch`, `--base`): the issues referenced in the reviewed commits' messages.

Recognised references: `#12` (the `origin` repository), `owner/repo#12`, `repo#12` (a repository of the
same owner as `origin`, for example `prodmgt#31` from a `PhoenixCare/...` checkout means
`PhoenixCare/prodmgt#31`) and `https://github.com/owner/repo/issues/12`. Up to 6 are fetched with
`gh issue view` (title and the first 4,000 characters of the body). Only issues of the same owner
as `origin` are fetched: references come from text anyone opening a PR can write, and the fetch
uses your own `gh` login, so another owner's (possibly private) issue never reaches the prompt or
a posted comment. Skipped references are listed in the output. If `gh` is missing or not
logged in, or nothing is referenced, the output says so and that reviewer is skipped; the rest of
the panel runs as usual. Staged changes have no commit messages, so they never get a ticket.

Every `gh` call (issues, `gh pr view`, the PR comment) names the `origin` repository with `-R`.
`gh`'s own default can be another remote, such as the upstream of a fork, whose `#12` is a
different issue and whose PR must never get your review. When `origin` has no `owner/repo`
(or there is no `origin`), nothing is fetched and nothing is posted.

Only this reviewer receives the ticket text, marked as data, not instructions. The PR
description is marked as the author's account, not as requirements: the requirements are the
issues.

### Large diffs

The reviewers get at most 3,000 diff lines and 400 KB (`AI_REVIEW_MAX_DIFF_BYTES`). Files are
packed whole, in diff order, while they fit; a generated, minified or data file (a line over
2,000 chars or a diff over 100 KB) is sent as its header only. When the diff does not fit, the
output (and the PR comment) lists every file that was not reviewed, and the reviewers are told
those files exist so they do not report them as missing.

### Reviewers have no tools

The diff is untrusted input: it can contain text written to steer a model. Each reviewer runs
as `claude -p` with `--tools ''` (no built-in tools), `--permission-mode dontAsk`,
`--permission-prompts none` and `--strict-mcp-config`, so it only reads the diff it is given
and cannot run commands, edit files or fetch anything from inside the push hook.

## Install

1. Install the plugin (this enables the Claude-side guard):

   ```
   /plugin marketplace add adrianflda/claude-code-templates
   /plugin install pre-push-review
   ```

   or point at a local checkout: `/plugin marketplace add /path/to/claude-code-templates`.

2. Install the git gate, once per machine (needs git 2.54 or newer):

   ```
   node <plugin>/scripts/install-git-hook.mjs
   node <plugin>/scripts/install-git-hook.mjs --check   # exit 1 and an explanation if not installed
   ```

   The installer is idempotent. It sets the global `hook.ai-review.event` and
   `hook.ai-review.command`; if the global `core.hooksPath` points at a directory whose
   `pre-push` runs the old `~/.config/git-ai-review` harness, it unsets it and prints exactly
   what it changed. It never touches repository-local config.

   Until the gate is installed, the guard blocks Claude's pushes and tells the user to run
   the installer. Re-run the installer after a plugin update that moves the plugin directory
   (the stored command contains the plugin path); `--check` reports a stale path.

## Coverage

| Who pushes | Reviewed? |
|---|---|
| Claude, plain repo | yes, by the git gate (the guard checks it is active) |
| Claude, husky repo (local `core.hooksPath`) | yes, same |
| A human in a terminal, any repo, including husky | yes, by the git gate |
| A human typing `git push --no-verify` | **no** (see limits) |

Husky and other repo-local hooks keep working; they run in addition to the gate. The per-SHA
`pass-<sha>` marker of earlier versions is gone: a husky `pre-push` that calls the panel
itself would now review a second time, so remove such a hook (the gate already covers it).

## Limits, honestly

- **`git push --no-verify`** skips every git hook. Git implements it and no hook can see it, so
  a human at a terminal can always bypass the gate. The guard blocks it for Claude only.
- The guard reads a command line; it is not a shell. A push made by an alias, function or
  script is not visible to it (the git gate still runs when git performs the push). Editing the
  git config file by other means than `git config` (an editor, `sed`) is not detected.
- The gate runs on the machine where it is installed, and anyone with shell access to that
  machine can change its configuration. **True enforcement needs a server-side check** (branch
  protection plus a required CI review, for example); this plugin is a strong local gate, not a
  security boundary.
- Other review settings such as `AI_REVIEW_BLOCK_ON` still apply to the panel, so they can
  weaken what counts as blocking.

## Run on demand

`/pre-push-review` — review without pushing (staged changes, `branch`, or `pr <n>`).

**Before merging, run `/pre-push-review pr <n>` as well.** The push gate reviews only the
commits of each push, so no push ever shows the whole change, and a push rarely carries the
ticket. `pr <n>` reviews the full PR diff against its base, with the PR description and the
issues it references, and posts the report as one rolling PR comment. Run it from a checkout of
the PR head (`gh pr checkout <n>`): the diff comes from the local checkout, and the panel warns
when `HEAD` is not the PR head. Add `--no-post` to print the report without commenting.

Or directly:

```
node scripts/ai-review-panel.mjs            # staged changes
node scripts/ai-review-panel.mjs --branch   # commits being pushed
node scripts/ai-review-panel.mjs --base origin/main   # everything on this branch that is not on the base
node scripts/ai-review-panel.mjs --range <base> <head>   # an exact range (full object names)
node scripts/ai-review-panel.mjs --pr 123   # review a PR and post a rolling comment
node scripts/ai-review-panel.mjs --pr 123 --no-post   # same review, printed only
```

## Run log and stats

Every run appends one JSON line to `~/.cache/git-ai-review/runs.jsonl`: repository, mode, base
and head, which reviewers ran, were skipped or failed, each reviewer's findings by severity, the
de-duplicated totals, the outcome (`passed`, `blocked`, `not-reviewed`, `nothing-to-review`,
`skipped`), model calls, token usage, cost in USD and wall time. The panel writes the row when it
finishes; the git runner writes one only when the panel never got to finish (blocked by the
quality gate, or a panel that could not start, was killed or timed out). A `git push --no-verify`
runs no hook, so it leaves no row: the log cannot count overrides.

```
node scripts/stats.mjs                 # the last 30 days
node scripts/stats.mjs --days 7        # per-outcome counts, cost/time/calls p50 and p95, a per-role table
node scripts/stats.mjs --days 7 --json
```

The log exists so the panel is judged on data: a reviewer that is rarely confirmed or fixed gets
retired or merged, and blocking is only tightened once precision is known. The reviewers are
called with `--output-format json`, which is where the usage and cost come from; a reply without
that envelope is still parsed, with no usage recorded. The log is written best-effort: a
read-only home never fails a review.

## Configuration (env)

| Var | Default | Meaning |
|---|---|---|
| `AI_REVIEW_MODEL` | `sonnet` | model for the reviewer agents |
| `AI_REVIEW_BLOCK_ON` | `critical` | severity that blocks: `critical` or `high` |
| `AI_REVIEW_TIMEOUT_MS` | `240000` | per-agent timeout |
| `AI_REVIEW_REQUIRED` | forced to `1` by the gate; `0` when the panel is run directly | `1` = exit 2 if no reviewer could run. The gate ignores any other value |
| `AI_REVIEW_GATE_TIMEOUT_MS` | `540000` | how long the gate waits for the panel (counted from the first panel run, after the quality gate); past it the push is blocked as not reviewed |
| `QK_MEM_MAX_PRESSURE_LEVEL` | `3` on push | macOS memory-pressure level at which the quality gate refuses to start (its own default is 2); a refusal blocks the push |
| `QK_PUSH_TIMEOUT_MS` | `1800000` | how long the gate waits for the quality gate (all pushed ranges together); past it the push is blocked as not verified |
| `CLAUDE_BIN` | auto | explicit path to the `claude` binary |
| `AI_REVIEW_TRIGGER` | set to `pre-push` by the gate | recorded in the run log as the run's trigger (`pre-push` or `cli`) |

`PREPUSH_REVIEW_SKIP` and `AI_REVIEW_SKIP` no longer skip a push: the gate removes them, and the
guard blocks Claude commands that set them. They only affect the panel when it is run directly.

## Bypass

There is one: a human typing `git push --no-verify` in a terminal. Claude cannot use it (the
guard blocks it). Everything else is closed on purpose.

## Tests

```
node --test test/*.test.mjs
```

The tests use temporary git repositories, a temporary `HOME`, a local bare remote and a
stand-in for the `claude` and `gh` CLIs, so they need no network and no account. They need git 2.54 or
newer (config-based hooks).
