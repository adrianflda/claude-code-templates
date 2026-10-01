# Changelog

## [0.1.0] - 2026-10-01

### Added
- First release, split out of quality-kernel 0.9.0 (where it was `/init-workspace` M2): the org
  guide is now a managed block in the org-root `CLAUDE.md` (Claude Code's own convention) instead
  of a separate workspace repo; `/org-init` and `/org-learn`.
- `org-guide.mjs`: validates the guide, renders the block within a 4 KB budget, previews the diff,
  writes only with `--apply` (backups first), never touches text outside the markers.
- `org-discover.mjs` reads forbidden repos from the block (and `--forbid`) instead of a workspace repo.
- `--apply` also writes `<org>/.claude/org-workspace/guide.json` (the machine copy quality-kernel's
  org mode reads) and `map-summary.json`, so an update without a new map keeps the who-calls-whom
  summary.
- Carried over from quality-kernel with their tests: discovery, per-repo profile, integration
  signals (`git grep -z` on the base commit, redacted lines), map validation and rendering.
