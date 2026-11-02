# Plan

Status legend: done / in progress / next / later.

## Phase 0: configuration baseline (done, automated by `scripts/apply.py`)

| Setting | Value | Why |
|---|---|---|
| `effortLevel` and every `modelSettings.*.effortLevel` | `medium` | `xhigh` multiplies output tokens on every call |
| `env.CLAUDE_CODE_AUTO_COMPACT_WINDOW` | `200000` | Stops sessions from living at 800k context |
| `env.CLAUDE_CODE_SUBAGENT_MODEL` + `_FORCE=1` | `sonnet` | Subagents were 53%; agent files pin Opus/Fable |
| `statusLine.command` | `statusline.py --style <style>` | Make the 7-day window visible |
| `~/.claude-mem/settings.json` `CLAUDE_MEM_MODEL` | `haiku` | Observer was 18% on Sonnet |
| Open sessions above 400k context | close them | Each call re-reads the whole context |

Left alone on purpose: `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` (user decision),
`skillOverrides` (needs the phase 3 audit first).

## Phase 1: measure (done)

`report.py`, `doctor.py`, `statusline.py`, `/usage-guard` command, tests.

## Phase 2: enforce (next)

- `hooks/context-watchdog.py` on `UserPromptSubmit` and `PreToolUse`: read
  `transcript_path`, compute the last call's context, warn at 250k, block at 400k
  with a message that tells the model to `/compact` or finish.
- Same hook in subagents, once the open question about `PreToolUse` inside
  subagents is answered by experiment (write a one-line hook that logs its input).
- Subagent spawn budget per session: count `Agent` tool calls in the transcript,
  block above N (default 8), configurable through `USAGE_GUARD_SPAWN_BUDGET`.
- `SubagentStart` hook: inject a short budget note through `additionalContext`.

## Phase 3: prompt audit (later)

`prompt-audit.py`: which skills and agents were invoked in the last 30 days
(from `Skill` and `Agent` tool calls in transcripts) versus which are loaded, with
a suggested `skillOverrides` block and a list of agent files never used.

## Phase 4: plugin integrations (later)

- claude-mem: `pause` / `resume` subcommands (worker stop/start) and provider switch.
- pre-push-review: a quick mode that skips the panel for small diffs.

## Replicating on another machine

```bash
claude plugin marketplace add adrianflda/claude-code-templates
claude plugin install usage-guard@adrianflda-claude-code-templates
/usage-guard report      # measure first
/usage-guard doctor      # see what to change
/usage-guard setup       # dry run of phase 0, then apply if the user agrees
```

The skill in `skills/usage-guard/SKILL.md` holds the step-by-step runbook an agent
should follow.
