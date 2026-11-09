---
name: usage-guard
description: Runbook to diagnose and cut Claude Code subscription burn on any machine (measure transcripts, lint config, apply the phase 0 baseline, pick a status line, audit the prompt load of skills and agents, pause or re-route the claude-mem observer). Use when the user says the weekly limit runs out early, asks why Claude Code spends so many tokens, or wants the usage-guard setup replicated.
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
`--claude-mem-model`, `--no-claude-mem`, `--keep-agent-pins`. Backups land next
to each file as `.bak-<timestamp>`. The script never touches git config, hooks
or plugins.

Ask whether the agents pinned to Opus/Fable (doctor's `agent-models` line names
them) should keep their model. If yes, add `--keep-agent-pins`: it drops
`CLAUDE_CODE_SUBAGENT_MODEL_FORCE` and lists those agents in
`USAGE_GUARD_ACCEPTED_PINS`, so the doctor stops warning about them while every
other subagent still runs on `--subagent-model`. Without it FORCE=1 overrides
every pin.

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
agent-models (plain, or "accepted on purpose"), claude-mem, statusline and
pre-push-review. Tell the user env changes apply to new sessions only: inside
the session the `env-drift` line lists the keys the running session still has
with another value (values shown only for the doctor's own knobs, never for
other `settings.env` keys), and it clears after a restart.

## 6. Prompt audit (when doctor warns on `prompt-load`)

```bash
python3 -I "${CLAUDE_PLUGIN_ROOT}/scripts/prompt_audit.py" --days 30 --cwd "$PWD"
```

Every agent and skill description is sent on every request and every subagent
call. The audit lists each one with its invocation count from the transcripts
(Skill tool, Agent tool and typed `/commands`), the agent files never invoked
and a `skillOverrides` block for the unused skills. Show it and let the user
choose:

- `--apply` merges the block with value `user-invocable-only`: the skill leaves
  the model's prompt but `/name` still works. Reversible, cannot break anything.
- `--apply --mode off` removes the skill entirely.
- Skills younger than `--grace` days (default 7) are never suggested.
- `--keep NAME` (repeatable) never suggests that skill. Use it for every skill
  the user's CLAUDE.md declares mandatory (they are read, not invoked, so their
  count is 0); plugin skills by `plugin:name` or the bare name.
- Agent files are only listed. Moving them out of `agents/` is the user's call.

The hooks (phase 2) need nothing from this step: they are active as soon as the
plugin is enabled. Knobs are in `README.md`, section "Hook knobs".

## 7. claude-mem observer (when the report shows it, or the limit is close)

```bash
python3 -I "${CLAUDE_PLUGIN_ROOT}/scripts/claude_mem.py" status
```

claude-mem summarizes every tool call with a model call of its own; with
`provider: claude` and auth `cli` those calls run on the subscription's OAuth
token (`status` shows the worker's auth). Two levers, both reversible and both
backed up:

- `pause` / `resume`: the hooks skip every project from the next tool call on,
  in running sessions too. Memory search and the session-start context keep
  working. Use it when the weekly window is close to its limit; `resume` later.
- `provider gemini|openrouter [--model <name>]`: moves the observer off the
  plan. The user must first paste the API key into
  `~/.claude-mem/settings.json` (`CLAUDE_MEM_GEMINI_API_KEY` or
  `CLAUDE_MEM_OPENROUTER_API_KEY`); the script refuses while it is empty and
  never handles keys itself. `provider claude --model haiku` is the way back.

Doctor reports `claude-mem: paused` while a pause is active.

## 8. pre-push-review (if that plugin is installed)

Nothing to configure: since 1.8.0 a push of at most 60 changed lines gets the
quick panel (security, correctness, reliability, ticket) instead of all roles,
and the design and readability reviewers are one. `node <plugin>/scripts/stats.mjs`
shows how many runs were quick. `AI_REVIEW_QUICK_LINES=0` restores the whole
panel on every push. Doctor's `pre-push-review` line (step 2) says whether the
global git hook is set, which version runs and whether the quick panel is off:
INFO when the hook is missing or older than 1.8.0, WARN only on
`AI_REVIEW_QUICK_LINES=0`.

## Reference

- `docs/RESEARCH.md`: how the limits work, levers, measurement method, what was
  measured on the reference machine, community tools, open questions.
- `docs/PLAN.md`: phases 0-4 and their status.
