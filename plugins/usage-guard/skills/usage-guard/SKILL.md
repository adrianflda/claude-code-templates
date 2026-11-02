---
name: usage-guard
description: Runbook to diagnose and cut Claude Code subscription burn on any machine (measure transcripts, lint config, apply the phase 0 baseline, pick a status line). Use when the user says the weekly limit runs out early, asks why Claude Code spends so many tokens, or wants the usage-guard setup replicated.
---

# usage-guard runbook

Follow the steps in order. Measure before changing anything. All scripts are
Python standard library; run them with `python3 -I`. `${CLAUDE_PLUGIN_ROOT}` is
this plugin's directory.

## 1. Measure

```bash
python3 -I "${CLAUDE_PLUGIN_ROOT}/scripts/report.py" --days 7
```

Relay the tables. Name the top consumer by kind (main / subagent / claude-mem),
the top session and the top subagent. If the kinds table is empty, the
transcripts live elsewhere: pass `--root "$CLAUDE_CONFIG_DIR/projects"`.

## 2. Lint the configuration

```bash
python3 -I "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.py" --cwd "$PWD"
```

One line per check. Read `docs/RESEARCH.md` section 2 for what each lever does
before explaining a WARN.

## 3. Apply the baseline (phase 0)

```bash
python3 -I "${CLAUDE_PLUGIN_ROOT}/scripts/apply.py"            # dry run, exit 3 when changes pend
python3 -I "${CLAUDE_PLUGIN_ROOT}/scripts/apply.py" --apply    # only after the user agrees
```

Show the dry run to the user first. Options: `--effort`, `--autocompact`,
`--subagent-model`, `--style minimal|bar|powerline|multiline|keep`,
`--claude-mem-model`, `--no-claude-mem`. Backups land next to each file as
`.bak-<timestamp>`. The script never touches git config, hooks or plugins.

Then ask the user to close any interactive session the report listed above
400k context. Do not kill their processes.

## 4. Status line

```bash
python3 -I "${CLAUDE_PLUGIN_ROOT}/scripts/statusline.py" --preview
```

`minimal` works in every font. `powerline` needs a Nerd Font. Re-run `apply.py
--style <name> --apply` to switch.

## 5. Verify

Re-run doctor (step 2) and expect PASS on effort, autocompact, subagent-model,
claude-mem and statusline. Tell the user env changes apply to new sessions only.

## Reference

- `docs/RESEARCH.md`: how the limits work, levers, measurement method, what was
  measured on the reference machine, community tools, open questions.
- `docs/PLAN.md`: phases 0-4 and their status.
