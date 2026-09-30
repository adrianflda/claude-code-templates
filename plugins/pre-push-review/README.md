# pre-push-review

A portable, versioned **Claude Code plugin** that fires an expert panel of code reviewers
before **every `git push`** and **blocks the push on critical findings** — in every repo,
automatically, with no per-machine hand-wiring.

## Why this exists

The multi-agent pre-push review used to be a hand-wired global hook: a script in
`~/.claude/hooks/` pointing at a harness in `~/.config/git-ai-review/`. That works, but it is:

- **Per-machine** — every new machine/clone must be set up by hand; nothing is versioned.
- **Invisible** — its output is surfaced as hook feedback, easy to miss.
- **Coverage-inconsistent** — it only runs when *Claude Code itself* runs the push, and it
  can silently no-op if the harness file is missing.

Packaging it as a plugin fixes all three: the gate and the panel ship **inside the plugin**
(resolved via `CLAUDE_PLUGIN_ROOT`), so installing the plugin is the whole setup, it is
version-controlled, and it behaves identically everywhere.

## What it does

On every Bash `git push` that Claude Code runs, the plugin's `PreToolUse` hook
(`scripts/prepush-gate.mjs`) runs the bundled panel (`scripts/ai-review-panel.mjs`) over the
**commits being pushed** and:

- **Reviewed, nothing blocking** → the push proceeds. The summary line is returned to the
  session, the full panel output is kept in `~/.cache/git-ai-review/review-<sha>.log`, and a
  per-SHA pass-marker is written next to it so an in-repo husky gate can skip re-running the
  panel — no double work.
- **Critical issue found** → the push is **blocked** and the panel report is fed back as the
  reason.
- **No reviewer could run** → the push is **blocked**: nothing was reviewed. Set
  `AI_REVIEW_REQUIRED=0` to make this case advisory.
- **The review did not finish or cannot be matched to the push** → the push is **blocked**.
  This covers a panel that is missing, killed or unable to start, a directory that is not a
  repository, and a directory that cannot be known from the command.

The pass-marker is written only for a review that ran and passed. "Nothing to review" passes
without a marker.

### Which repository is reviewed

The panel runs in the repository the push leaves from, which is not always the session's
working directory. The gate follows the command:

| Command | Reviewed repository |
|---|---|
| `git push` | the session's working directory |
| `cd ../worktree && git push` | `../worktree` |
| `git -C ../worktree push` | `../worktree` |
| `cd $DIR && git push` | none: the push is blocked, because the directory cannot be known without running the command |
| `git --git-dir ... push`, `GIT_DIR=... git push`, `xargs git push` | none: blocked for the same reason |

A push behind `env`, `command` or `sudo`, after `then` or `do`, inside `$( ... )` or inside
`bash -c '...'` is found too. Text inside quotes or inside a here-document is not read as a
command, unless the here-document is fed to a shell.

When the words of a command say `git ... push` and the gate cannot place it (for example
`sudo -u deploy git push` or `timeout 60 git push`), the push is blocked, not skipped.

The gate reads the command line; it does not run a shell. A push made by an alias, a shell
function or a script is not visible to it. Cover those with the git-level hook below.

### Deleted files

Deleted files are part of the review. The reviewers get each one as a header with its name
and no content, so removed code does not use up the diff budget. A push that only deletes
files is reviewed; it is not reported as "no changes".

The panel is 6 independent specialist reviewers, each constrained to one branch of review:

| Agent | Focus |
|---|---|
| Security & Privacy | authz/authn, tenant isolation, injection, secret/PII leakage |
| Correctness & Logic | logic bugs, null hazards, bad state transitions, breaking changes |
| Error Handling & Reliability | swallowed errors, races, idempotency, resource leaks |
| Performance & Scale | N+1, unbounded loops/fetches, hot-path waste |
| Test Coverage & Quality | untested branches, weak assertions, flaky patterns |
| Maintainability & Design | boundaries, duplication, dead code, leaky abstractions |

Each reviewer ingests the repo's own guidance (`CLAUDE.md` / `.github/copilot-instructions.md`
/ `AGENTS.md` / `.cursorrules`), so the generic panel auto-adapts per project.

## Install

From the marketplace (this repo / fork):

```
/plugin marketplace add adrianflda/claude-code-templates
/plugin install pre-push-review
```

Or point at a local checkout:

```
/plugin marketplace add /path/to/claude-code-templates
/plugin install pre-push-review
```

The `PreToolUse` hook is active as soon as the plugin is enabled — no extra config.

## Coverage: Claude pushes vs. human pushes

The `PreToolUse` hook covers pushes that **Claude Code runs**. To also gate **human**
`git push` from a terminal, add a git-level hook that calls the same panel. With husky:

```sh
# .husky/pre-push
node "$(git rev-parse --show-toplevel)/.claude/plugins/pre-push-review/scripts/ai-review-panel.mjs" --branch
```

(or copy `scripts/ai-review-panel.mjs` into the repo). Both paths share the per-SHA
pass-marker, so a push reviewed by the Claude hook is not re-reviewed by husky.

## Run on demand

`/pre-push-review` — review without pushing (staged changes, `branch`, or `pr <n>`).

Or directly:

```
node scripts/ai-review-panel.mjs            # staged changes
node scripts/ai-review-panel.mjs --branch   # commits being pushed
node scripts/ai-review-panel.mjs --base origin/main   # everything on this branch that is not on the base
node scripts/ai-review-panel.mjs --pr 123   # review a PR and post a rolling comment
```

## Configuration (env)

| Var | Default | Meaning |
|---|---|---|
| `AI_REVIEW_MODEL` | `sonnet` | model for the reviewer agents |
| `AI_REVIEW_BLOCK_ON` | `critical` | severity that blocks: `critical` or `high` |
| `AI_REVIEW_TIMEOUT_MS` | `240000` | per-agent timeout |
| `AI_REVIEW_REQUIRED` | `1` in the hook, `0` when the panel is run directly | `1` = block (exit 2) if no reviewer could run |
| `PREPUSH_REVIEW_SKIP` / `AI_REVIEW_SKIP` | — | `1` = bypass the review once |
| `CLAUDE_BIN` | auto | explicit path to the `claude` binary |
| `PREPUSH_REVIEW_TIMEOUT_MS` | `540000` | how long the hook waits for the panel; past it the push is blocked as not reviewed |

## Bypass once

`PREPUSH_REVIEW_SKIP=1 git push` (Claude hook), or `git push --no-verify` (husky path).

## Tests

```
node --test test/push-target.test.mjs test/gate.test.mjs test/panel.test.mjs
```

The tests use temporary git repositories and a stand-in for the `claude` CLI, so they need no
network and no account.
