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
  Reading transcripts is fine. A path counts as the file it is on disk, not only as spelled: a
  symlink or hard link to the transcript, `//`, `/./`, `..`, any letter case, a `cd` into `.claude`,
  a glob or `$CLAUDE_CONFIG_DIR` all reach it, and so does linking one (`ln`, `cp -l`, `cp -s`).

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

The code inside `$(...)`, backticks and process substitutions `<(...)`/`>(...)` (also within double
quotes and unquoted heredocs) is judged like any other command, wherever it sits. `$((...))` counts
as arithmetic only where bash reads it so (`$((rm f);(echo))` is code). `<>` counts as a write. A
substitution that spans lines, or one holding `case` (whose arm `)` defeats paren counting), cannot be
read; such a command is judged by the broad check (any `>`, `tee`, `rm`, `cp` ... counts as a write).

A script handed a transcript counts as a write unless it is read now and its source writes
nothing. Only `python3 -I /absolute/script.py` qualifies: a bare `python`/`python3`/`python3.N` (not
a path), a literal absolute script path (no `~/`, glob or variable) to a regular file of at most
1 MB, no assignment or wrapper on the command, not inside `bash -c`/`eval`, and every other command
in the line from a short allowlist of readers (`cat`, `head`, `grep`, `jq`, `wc`, `ls`, `echo`,
`test` ...), `cd` (only while `PATH` has no relative entry), a loop over a one-letter lowercase variable (zsh ties `path` to `PATH`) or a
reserved word, with no output other than `/dev/null`, and no arithmetic (`$((...))`, `$[...]`) or
`${x:=...}` anywhere in the line (each may assign `PATH`). The script must be UTF-8 text without NUL
bytes: python also runs a zip archive or bytecode, which cannot be read. Anything else in the line (an assignment,
`export`, `read`, `printf -v`, `alias`, a function, a sourced file, a write) leaves the script
unjudged, so it blocks. Modules the script imports are not seen. Any other interpreter running a
script on a transcript blocks.

## Tests

```bash
npm test   # node --test, no dependencies
```
