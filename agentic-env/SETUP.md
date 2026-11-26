# Set up this machine — instructions for Claude Code

This file is written for Claude Code to follow. On a new machine, clone the repository, open
Claude Code in it and say:

> Read `agentic-env/SETUP.md` and set up this machine.

The work is done by `agentic-env/install.py`, which is idempotent. Your job is to check the
prerequisites, run it, verify the result, and ask the user about the pieces it leaves out.

## Rules for this task

- Run every command from the repository root. Show the user the output of each check before you
  act on it.
- The installer never deletes anything and neither do you. A piece that looks stale is reported
  to the user, with the command that would remove it.
- Never edit `~/.claude/CLAUDE.md` without first showing the exact lines and getting a yes.
- Never run `graphify install`: it edits the global `CLAUDE.md`.
- Anything in "Optional pieces" is a question to the user, not a default. Ask once, in one
  message, and do only what was chosen.
- If a step fails, stop, show the error and say what you would try. Do not work around a
  permission prompt or a blocked command.

## Step 1 — Prerequisites

```bash
command -v claude python3 node git uv; python3 --version; node --version
uv python find --no-python-downloads 3.12
```

- `claude`, `python3`, `node` and `git` are required. If one is missing, stop and tell the user.
- `uv` and Python 3.12 are needed only for the `graphify` command (`code-graph` skill). If they
  are missing, tell the user the command (`brew install uv python@3.12`) and ask whether to go on
  without it; if so, add `--no-tools` to the installer commands below.

## Step 2 — Check, install, check again

```bash
python3 -I agentic-env/install.py --check
```

Show the user the list. It names every file, hook, plugin and tool that is missing or differs.
Then:

```bash
python3 -I agentic-env/install.py
python3 -I agentic-env/install.py --check
```

The second check must print `OK: in sync with the repo`. Known cases when it does not:

| The check says | Do this |
|---|---|
| `market ... reads <path>, not this clone` | The marketplace was added from another folder. Ask the user, then `claude plugin marketplace remove adrianflda-claude-code-templates` and run the installer again. |
| `<plugin>@<other marketplace> also installed` | A second copy runs its hooks twice. Show the user the `claude plugin uninstall` command it prints; do not run it yourself. |
| `skip` for a tool | `uv` or Python 3.12 is missing: see step 1. |

## Step 3 — Verify

```bash
claude plugin list --json | python3 -c "import json,sys; [print(p['id'], p.get('version'), p.get('enabled')) for p in json.load(sys.stdin)]"
ls ~/.claude/agents ~/.claude/skills ~/.claude/hooks
git config --global --get core.hooksPath
```

Expect the seven plugins of `manifest.json` enabled, the agents, skills and hooks it lists, and a
global git hooks path (the push review). Report what you saw, not what you expect.

## Step 4 — Optional pieces: ask the user

Ask about all of them in one message. For each, say what it is in one line.

1. **`cc-safety-net`** (blocks destructive shell commands before they run). Recommended.
   `claude plugin marketplace add kenryu42/cc-marketplace` then
   `claude plugin install cc-safety-net@cc-marketplace`.
2. **`claude-mem`** (memory across sessions). It costs tokens on every session: on the author's
   machine it was about 30% of the spend. Install only if the user wants it:
   `claude plugin marketplace add thedotmack/claude-mem` then
   `claude plugin install claude-mem@thedotmack`.
3. **Two GitHub accounts on this machine?** If yes, install the `gh` wrapper, which picks the
   account by folder. Ask for the default account and for each folder that uses another one, check
   that `gh auth status` lists every account, then:

   ```bash
   mkdir -p ~/bin ~/.config
   mv "$(command -v gh)" ~/bin/gh-real     # only if ~/bin/gh-real does not exist yet; show this to the user first
   cp agentic-env/extras/gh-wrapper/gh ~/bin/gh && chmod 755 ~/bin/gh
   printf '%s\n' 'default <account>' 'dir <other-account> <folder>' > ~/.config/gh-wrapper.conf
   ```

   `~/bin` must come first in `PATH`. Verify with `gh api user --jq .login` from a folder of each
   kind. If `gh` was installed by Homebrew, do not move it: copy the wrapper to `~/bin/gh` and
   set `real=` in it to the Homebrew path instead, after showing the user that edit.
4. **The routing rule in the global `CLAUDE.md`.** Show the block under "Which tool for which
   job" in [`README.md`](README.md) and offer to append it to `~/.claude/CLAUDE.md`. Append only
   on a yes, after saving a copy of the file. Any personal rule (languages, accounts, folders that
   must not be read) is the user's to dictate; do not invent one.
5. **Folders that must never be read or used for network lookups.** If the user names any, add
   deny rules to `~/.claude/settings.json` with the user's approval and set
   `AGENTIC_ENV_NO_EGRESS_DIRS` to those folders in the same file's `env`.

Per project, later, and only when asked: `agentic-env/extras/archify/add_archify.py <project>`
(diagrams), and the two tools under "Opt-in, not installed" in the README.

## Step 5 — Report

End with a short report in this shape:

```
Installed: <plugins and versions, counts of agents / skills / hooks>
Check: <the last line of install.py --check>
Optional: <each piece: installed / declined / not asked and why>
Not done: <anything that failed or was skipped, with the command to finish it>
Next: restart Claude Code; then read agentic-env/GUIDE.md
```

To update the machine later: `git pull`, then the installer and the check again.
