# Changelog

## [0.2.0] - 2026-10-26

Fixes from the pre-push panel review of the quality-kernel workspace branch (contract:
docs/contracts/org-guide-v1.md, findings F1/F8/F9/F12/F14/F15/F18).

### Changed — guide.json is the sole source of truth for the forbidden list (OG-1/OG-2/OG-3, F1)
- `readGuideForbidden` now reads `<org>/.claude/org-workspace/guide.json` directly instead of
  regex-parsing the rendered CLAUDE.md block (closing the lossy reverse-parse `skills/org-learn/
  SKILL.md` used to instruct). A guide.json that does not exist yet still yields an empty forbidden
  list; one that is a symlink (at any path component), unparsable JSON, or the wrong shape now fails
  closed instead of silently returning `[]`.
- `org-discover.mjs` labels guide-sourced forbidden entries `forbiddenBy: 'guide.json'` (was
  `'CLAUDE.md'`).

### Added — guide.json schema version (OG-7)
- `buildGuide`/`applyGuide` stamp `"version": 1` into every `guide.json` written, whether or not the
  `--guide` input supplied one; `validateGuide` accepts the optional `version`/`renderHash` fields a
  guide.json round-trips through `--guide` instead of rejecting them as unknown keys.

### Fixed
- F15/OG-11: an END marker sitting immediately before a BEGIN marker (no separating content) made
  `spliceBlock` silently keep the stray END and insert a second BEGIN; it now throws the existing
  marker-ordering error.
- F8+F9/OG-13: `org-profile.mjs`'s and `org-integrations.mjs`'s bulk `git ls-tree` calls had no
  `maxBuffer` (Node's 1 MiB default applied), and the latter had no exit-status check at all, so a
  large repo's committed file list could be silently truncated. Both now pass a 256 MiB `maxBuffer`
  and check the exit status.
- F14/OG-14: an scp-style remote whose password itself contains `@` (`user:p@ss@host:path`) leaked
  the tail of the password into the stripped remote.
- F16/OG-14: a query-string `@` in a URL remote was mistaken for the userinfo separator, corrupting
  the reported host.
- F18/OG-15: a repo listed in the guide that fails to profile is now recorded (name + the real error)
  in `buildGuide`'s `profilingProblems` (printed as a CLI warning), instead of silently vanishing from
  `repos` with only a later "not a selected repo" error to show for it.
- F12/OG-16: `entrypoint.mjs` (`isEntrypoint`) had already diverged from quality-kernel's canonical
  `is-main.mjs` (`isMain`) in export name and logic, with a comment naming the wrong plugin. Re-
  vendored byte-for-byte; every caller now uses `isMain`. A new `vendor-sync.test.mjs` fails the
  moment any of the three vendored files (`safe-git.mjs`, `hermetic-git.mjs`, `entrypoint.mjs`)
  drifts from quality-kernel's copy again.

### Changed
- OG-6: the BEGIN marker text now tells the reader to make changes through `/org-learn`, instead of
  inviting a hand edit inside the markers.

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
