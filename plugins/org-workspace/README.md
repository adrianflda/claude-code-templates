# org-workspace

A **light global guide** for an org folder that holds many repos (e.g. `~/Projects/Matchbox`).

Claude Code already loads the `CLAUDE.md` of every parent folder. This plugin writes a short,
managed block into the one at the org root that says **where the truth of each thing lives** —
the repos and their base branches, forbidden repos, where product decisions / requirements /
contracts / rules / test commands live, who calls whom, cross-repo conventions, a few open threads.
Pointers, not copies. The full integration map goes to `SYSTEM-MAP.md` next to it and is read only
when a task touches those repos.

| Command | What it does |
|---|---|
| `/org-init` | discover the repos → per-repo facts and integration signals (committed base only, nothing executed) → one mapper agent matches calls to routes across repos → preview the CLAUDE.md block + `SYSTEM-MAP.md` → write on the user's OK |
| `/org-learn` | from a conversation, propose a small diff to the block (a pointer, a convention, an open thread added or closed) → write on the user's OK |

Guarantees (each has a test):
- Only the text between `<!-- org-workspace:begin … -->` and `<!-- org-workspace:end -->` is written;
  hand-written rules around it stay byte-identical. Unbalanced markers or a symlinked `CLAUDE.md` are refused.
- The block budget is 4096 bytes (~1k tokens); a bigger guide is refused.
- Nothing is written without `--apply`; the previous files are backed up to `<org>/.claude/org-workspace/backups/`.
- `--apply` also writes `<org>/.claude/org-workspace/guide.json` (the same guide, for tools —
  quality-kernel's org mode reads it) and `map-summary.json` (so an update without a new map keeps
  the who-calls-whom lines).
- Guide text is single-line, bounded, secret-scanned and rendered as plain text.
- Map citations: every `path:line` must be a non-blank line of a committed, non-sensitive file of
  the repo it belongs to, or the map is refused; each side is labelled `✓` (the line names the
  endpoint) or `~` (it only exists — an indirect citation a human should read). Existence is not
  proof of relevance, and the map says so.
- Forbidden repos (from `--forbid` and the block) are listed by name and never opened.

Honest limits: the guide is orientation, not enforcement (gates stay in their own tools); the
org-root `CLAUDE.md` is usually not under git, so the backups and the previewed diff are the
review trail; the extractor misses calls made through base-class helpers (the mapper finds them by
reading); citation paths are ASCII-only.

Scripts: `org-discover.mjs`, `org-profile.mjs`, `org-integrations.mjs`, `org-map.mjs`, `org-guide.mjs`.
Tests: `cd scripts && node --test *.test.mjs`.
