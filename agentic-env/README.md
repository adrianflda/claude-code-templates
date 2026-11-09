# agentic-env — install the agentic tooling on another machine

One command puts the same agentic tooling on a second Mac: the review panel, the quality-kernel,
usage-guard, the epistemic hooks, and the agents, skills and commands they rely on. It is **not**
a copy of `~/.claude`. Machine config, account names, account ids and secrets are not in here and
must never be added.

## Install

```bash
git clone https://github.com/adrianflda/claude-code-templates.git ~/Projects/personal/cct-main
cd ~/Projects/personal/cct-main
python3 -I agentic-env/install.py --check   # what is missing (changes nothing)
python3 -I agentic-env/install.py           # install / update (idempotent)
```

Then restart Claude Code. To update later, run `git pull` and then the installer again.

Requires `python3`, `node` (for the pre-push gate) and the `claude` CLI on `PATH`.

## What it does

Everything comes from [`manifest.json`](manifest.json):

| Piece | Where it goes |
|---|---|
| agents `adversarial-critic`, `pipeline-breaker`, `qa-expert` (from `cli-tool/components`) and the nine in `agentic-env/agents/` (the catalog agents with their Opus/Sonnet pins and one-paragraph descriptions: every description is loaded into each session) | `~/.claude/agents/` |
| skills `epistemic-discipline`, `qa-paradigms`, `skill-audit-3r` | `~/.claude/skills/<name>/` |
| commands `/diagnose`, `/quality-gate` | `~/.claude/commands/` |
| hooks in [`hooks/`](hooks) | `~/.claude/hooks/`; each one is wired into `~/.claude/settings.json` |
| plugins `quality-kernel`, `pre-push-review`, `usage-guard` | installed from this repo's marketplace (`adrianflda-claude-code-templates`) |
| optional `pr-draft-guard`, `aws-admin-guard` | installed only once this repo's marketplace lists them |
| pre-push review gate | global git config, via `plugins/pre-push-review/scripts/install-git-hook.mjs` |

Behaviour:

- **Additive only.** It overwrites a manifest file that differs from the repo copy and never
  deletes anything.
- **`settings.json` is merged, not replaced.** Only missing hook entries are added; your own hooks
  and settings stay as they are. Before any write it saves a backup, `settings.json.bak-<timestamp>`.
- **Exit codes:**
  - `--check` exits 0 when the machine is in sync and 1 on drift.
  - An install exits 0 when, after installing, the machine is in sync. It exits 2 when a step
    failed or drift remains.
- **Marketplace path mismatch.** The installer does not repair this case. If `--check` reports
  `market ... reads <path>, not this clone`, the marketplace was added from another folder.
  Remove it with `claude plugin marketplace remove adrianflda-claude-code-templates`, then run the
  installer again.
- **Partial install.** `--no-plugins` skips the `claude plugin` and git steps. It installs only the
  files and the hook wiring.

## Deliberately not shipped

Some pieces stay on the machine that owns them:

- hooks that encode personal or org-specific facts, such as the GitHub account guard or guards
  that hardcode project folders;
- the global `CLAUDE.md`;
- `settings.json` env values.

If the other machine needs them, write them there by hand.

## Tests

```bash
python3 -I agentic-env/test_install.py               # installer, against a throwaway HOME
for t in agentic-env/hooks/test_*.py; do python3 -I "$t"; done
```
