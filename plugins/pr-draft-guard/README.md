# pr-draft-guard

A rule and the hook that enforces it: **Claude opens every pull request as a draft and never
merges one. A human does every merge.**

A rule that lives only in a memory file or a CLAUDE.md is a rule Claude can forget. This plugin
ships the rule together with a `PreToolUse` hook, so a slip is blocked instead of apologised for.

## What it blocks

| Command | Why |
|---|---|
| `gh pr create` / `gh pr new` without `--draft` (or with `--draft=false`) | every PR is a draft |
| `gh pr merge` (any form, `--auto` included) | the human merges |
| `gh pr ready` (`--undo` is allowed) | taking a PR out of draft is the human's call |
| `gh api` merge / ready-for-review calls (REST `.../pulls/N/merge` unless `GET`; GraphQL `mergePullRequest`, `markPullRequestReadyForReview`, `enablePullRequestAutoMerge`) | same, through the API |
| `git merge <base>` / `git pull <remote> <base>` while on another branch | ask before bringing a base branch into a feature branch |

Base branches default to `main, master, dev, develop, development, staging, stage, production, prod`
(override with `PR_DRAFT_GUARD_BASES=a,b,c`). After the human says yes to a base merge, run the
command prefixed with `ALLOW_BASE_MERGE=1`.

The hook reads the command the way a shell does (quotes, `&&`, `;`, pipes, `bash -c`, `env`,
`timeout`, heredocs), so text that only *mentions* a command (a PR body, a commit message, `echo`,
`grep`) is not blocked.

## The rule in the session

A `SessionStart` hook adds [`RULE.md`](RULE.md) to the session context, so Claude knows the rule
before it ever hits the guard.

## Limits

It is a guard against slips and shortcuts, not against an adversary: a script that merges
through some other client, or `curl` against the GitHub API, is not inspected.

## Tests

```bash
npm test   # node --test, no dependencies
```
