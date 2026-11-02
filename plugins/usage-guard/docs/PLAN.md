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

## Phase 2: enforce (done, `hooks/hooks.json`)

| Hook | Event | Behaviour |
|---|---|---|
| `context_watchdog.py` | `PreToolUse` (all tools), `UserPromptSubmit` | Reads the last assistant usage from the tail of the right transcript. Main: warn once per 50k step from 250k, deny tools and block prompts from 400k. Subagent: warn from 150k, deny tools from 300k so it returns its report. Slash commands are never blocked |
| `spawn_budget.py` | `PreToolUse` matcher `Agent` | Per-session ledger in the scratchpad dir; deny past `USAGE_GUARD_SPAWN_BUDGET` (default 8, 0 = unlimited); reminder on the last two |
| `subagent_note.py` | `SubagentStart` | Injects the budget and reading rules as `additionalContext` |

Knobs (env): `USAGE_GUARD_CTX_WARN`, `USAGE_GUARD_CTX_BLOCK`,
`USAGE_GUARD_SUBAGENT_CTX_WARN`, `USAGE_GUARD_SUBAGENT_CTX_BLOCK`,
`USAGE_GUARD_SPAWN_BUDGET`, `USAGE_GUARD_PROMPT_BLOCK`, `USAGE_GUARD_DISABLE=1`.
Hooks never exit non-zero and time out at 5 s; the watchdog costs about 70 ms on
a 2.5 MB transcript because it reads only the tail.

## Phase 3: prompt audit (next)

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
