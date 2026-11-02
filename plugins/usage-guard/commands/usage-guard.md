---
description: Measure, lint and fix Claude Code plan usage (report, doctor, audit, setup, statusline preview)
---

Run the usage-guard tools and relay their output as is. Do not summarize numbers away; the tables are the deliverable.

Subcommand from `$ARGUMENTS` (default: `report`):

- `report [days]` → price-weighted attribution of the last `days` days (default 7) by kind, model, day, session and subagent:
  ```bash
  python3 -I "${CLAUDE_PLUGIN_ROOT}/scripts/report.py" --days <days>
  ```
- `doctor` → read-only lint of the current configuration, one PASS / WARN / INFO line per check with the fix. Run it from the project directory so the CLAUDE.md check sees the right chain:
  ```bash
  python3 -I "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.py" --cwd "$PWD"
  ```
  After relaying the output, offer to apply the WARN fixes. Apply them only if the user says so, and back up `~/.claude/settings.json` first.
- `setup` → dry run of the phase 0 baseline (effort medium, auto-compact 200k, subagent model sonnet, status line, claude-mem on haiku), one line per pending change:
  ```bash
  python3 -I "${CLAUDE_PLUGIN_ROOT}/scripts/apply.py"
  ```
  Show the output. Apply with `--apply` only if the user agrees; backups are written next to each file.
- `statusline` → render the four status line styles with sample data so the user can pick one:
  ```bash
  python3 -I "${CLAUDE_PLUGIN_ROOT}/scripts/statusline.py" --preview
  ```
  To install the chosen style, set `statusLine.command` in `~/.claude/settings.json` to
  `python3 <plugin root>/scripts/statusline.py --style <name>`.

- `audit [days]` → prompt audit: every agent and skill loaded into the system prompt with its invocation count over the last `days` days (default 30), the unused agent files, and a `skillOverrides` block for the unused skills. Run it from the project directory so project agents are counted:
  ```bash
  python3 -I "${CLAUDE_PLUGIN_ROOT}/scripts/prompt_audit.py" --days <days> --cwd "$PWD"
  ```
  Relay both tables and the block. The suggested value is `user-invocable-only` (hidden from the model, `/name` keeps working); `--mode off` removes the skill entirely. Apply with `--apply` only if the user agrees; a `.bak-<timestamp>` copy of `settings.json` is written first. Never delete agent files: list them and let the user decide.
- `hooks` → explain the three hooks the plugin installs (context watchdog, spawn budget, subagent note) and the `USAGE_GUARD_*` knobs from `${CLAUDE_PLUGIN_ROOT}/README.md`, then show the current ledger for this session if `$CLAUDE_SCRATCHPAD_DIR/usage-guard/` exists.

Then stop. Only `setup --apply` and `audit --apply` edit files, and only after the user agrees.
