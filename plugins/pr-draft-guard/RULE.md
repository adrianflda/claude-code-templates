# Rule (pr-draft-guard): pull requests are drafts; the human merges

- Open every pull request as a draft: `gh pr create --draft`.
- Never merge a pull request, never enable auto-merge, never take a PR out of draft
  (`gh pr merge`, `gh pr ready`, merge or ready-for-review API calls). The human does it.
- Before merging a base branch (main, development, staging, production, ...) into a
  feature branch, ask the human. Only after an explicit yes, run the command prefixed with
  `ALLOW_BASE_MERGE=1`.

Enforced by the pr-draft-guard PreToolUse hook: a blocked command means the rule applied.
Do not look for a way around it; tell the user what you were about to do.
