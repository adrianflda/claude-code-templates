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

Or directly:

```
node scripts/ai-review-panel.mjs            # staged changes
node scripts/ai-review-panel.mjs --branch   # commits being pushed
node scripts/ai-review-panel.mjs --base origin/main   # everything on this branch that is not on the base
node scripts/ai-review-panel.mjs --range <base> <head>   # an exact range (full object names)
node scripts/ai-review-panel.mjs --pr 123   # review a PR and post a rolling comment
```

## Configuration (env)

| Var | Default | Meaning |
|---|---|---|
| `AI_REVIEW_MODEL` | `sonnet` | model for the reviewer agents |
| `AI_REVIEW_BLOCK_ON` | `critical` | severity that blocks: `critical` or `high` |
| `AI_REVIEW_TIMEOUT_MS` | `240000` | per-agent timeout |
| `AI_REVIEW_REQUIRED` | forced to `1` by the gate; `0` when the panel is run directly | `1` = exit 2 if no reviewer could run. The gate ignores any other value |
| `AI_REVIEW_GATE_TIMEOUT_MS` | `540000` | how long the gate waits for the panel; past it the push is blocked as not reviewed |
| `CLAUDE_BIN` | auto | explicit path to the `claude` binary |

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
stand-in for the `claude` CLI, so they need no network and no account. They need git 2.54 or
newer (config-based hooks).
