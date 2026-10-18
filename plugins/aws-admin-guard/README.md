# aws-admin-guard

A rule and the hooks that enforce it: **Claude uses the AWS admin profile only after the human
authorizes it and confirms a second time, in two separate typed messages.**

## How consent works

The consent oracle is the session transcript Claude Code writes. Only prompts the human typed
count (plain `user` entries, not meta, not subagents, `origin.kind == "human"` when present), so
Claude cannot grant itself access by writing text.

1. A prompt that authorizes the profile: "sí, autorizo usar admin para el plan", "si usa admin", <!-- EXEMPT-ES: real user phrasing -->
   "I authorize using the admin profile". Negations ("no uses admin", "don't use admin") do not.
2. A later, separate prompt that confirms, within 15 minutes: "confirmo por segunda vez",
   "si te confirmo", "I confirm". A bare "si" is not enough, so an answer to an unrelated
   question never opens admin.
3. The grant lasts 30 minutes after the confirmation, in this session only. "revoco admin" /
   "revoke admin" closes it earlier.

A `UserPromptSubmit` hook tells Claude where the grant stands after each relevant prompt
(1 of 2, granted until hh:mm, revoked).

## What it blocks

- Any Bash command that selects a guarded profile without a live grant: `--profile admin`,
  `--profile=admin`, `AWS_PROFILE=admin`, `AWS_DEFAULT_PROFILE=admin`, `-e AWS_PROFILE=admin`,
  `-var profile=admin`, `profile = "admin"`.
- Any write to a session transcript (`>`, `tee`, `sed -i`, `open(...,'a')`, the Write/Edit tools).
  Reading transcripts is fine.

## Settings

| Variable | Default |
|---|---|
| `AWS_ADMIN_GUARD_PROFILES` | `admin` (comma-separated) |
| `AWS_ADMIN_GUARD_TTL_MIN` | `30` |
| `AWS_ADMIN_GUARD_WINDOW_MIN` | `15` |

## Limits

It sees the command line, not what a script does inside. A tool that switches to the admin
profile internally, or a profile name built at run time, is not caught. It stops accidents and
shortcuts, not a determined adversary.

## Tests

```bash
npm test   # node --test, no dependencies
```
