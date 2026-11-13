# Plan

Status legend: done / in progress / next / later.

## Phase 0: configuration baseline (done, automated by `scripts/apply.py`)

| Setting | Value | Why |
|---|---|---|
| `effortLevel` and every `modelSettings.*.effortLevel` | `medium` | `xhigh` multiplies output tokens on every call |
| `env.CLAUDE_CODE_AUTO_COMPACT_WINDOW` | `200000` | Stops sessions from living at 800k context |
| `env.CLAUDE_CODE_SUBAGENT_MODEL` + `_FORCE=1` | `sonnet` | Subagents were 53%; agent files pin Opus/Fable. `--keep-agent-pins` (0.5.0) drops FORCE and lists the pinned agents in `USAGE_GUARD_ACCEPTED_PINS` instead |
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
| `spawn_budget.py` | `PreToolUse` matcher `Agent` | Per-session ledger in the scratchpad dir, counted over a sliding window of `USAGE_GUARD_SPAWN_WINDOW_MIN` (default 120, 0 = whole session); past `USAGE_GUARD_SPAWN_BUDGET` (default 8, 0 = unlimited) the spawn becomes a permission prompt, or a refusal with `USAGE_GUARD_SPAWN_HARD=1`; reminder on the last two |
| `subagent_note.py` | `SubagentStart` | Injects the budget and reading rules as `additionalContext` |

Knobs (env): `USAGE_GUARD_CTX_WARN`, `USAGE_GUARD_CTX_BLOCK`,
`USAGE_GUARD_SUBAGENT_CTX_WARN`, `USAGE_GUARD_SUBAGENT_CTX_BLOCK`,
`USAGE_GUARD_SPAWN_BUDGET`, `USAGE_GUARD_SPAWN_WINDOW_MIN`, `USAGE_GUARD_SPAWN_HARD`, `USAGE_GUARD_PROMPT_BLOCK`, `USAGE_GUARD_DISABLE=1`.
Hooks never exit non-zero and time out at 5 s; the watchdog costs about 70 ms on
a 2.5 MB transcript because it reads only the tail.

## Phase 3: prompt audit (done, `scripts/prompt_audit.py`)

Inventory of agents and skills (user, project, enabled plugins) with the tokens
their descriptions add to every request, joined with the invocations found in
the transcripts of the last N days (`Skill` tool, `Agent` tool, typed
`<command-name>`), deduplicated by message id. Output: both tables, the agent
files never invoked, and a `skillOverrides` block (`user-invocable-only` by
default, `--mode off`), merged into `settings.json` with `--apply` after a
backup. Skills younger than `--grace` days are spared.

Reference machine, 2026-11-02, 30 days: 50 agents loaded, 29 used; 69 skills
loaded, 13 used; 52 skills suggested (4 spared by the grace period). Top skills: `pre-push-review` (35),
`quality-kernel:develop` (24), `quality-kernel:forge` (14). Top agents:
`quality-kernel:coder` (102), `adversarial-critic` (61), `quality-kernel:specifier`
(46). Runtime 12 s over 4.3 GB of transcripts.

## Phase 4: plugin integrations (done)

claude-mem (`scripts/claude_mem.py`, `/usage-guard mem`): `status`, `pause`,
`resume`, `provider`. The worker cannot be stopped as a pause (every
`SessionStart` hook starts it again), so `pause` uses the plugin's own
exclusion list: every claude-mem hook is a fresh process that reads
`~/.claude-mem/settings.json` and skips the project when its cwd matches a
glob in `CLAUDE_MEM_EXCLUDED_PROJECTS` (anchored; `**` matches every path).
`pause` writes the previous list to `usage-guard-pause.json` first, then sets
`**` (a failed settings write removes the file again); `resume` restores the
list and removes the file, or removes a stale file when nothing is paused.
Verified on 13.11.0: with the pause active, the
observation hook logs `Project excluded from tracking, skipping observation`
and enqueues nothing; the worker and the memory search tools stay up.
`provider` writes `CLAUDE_MEM_PROVIDER` (+ the provider's model), refuses
gemini / openrouter while that provider's key is empty, restarts the worker,
and never touches keys. Doctor reports a pause.

pre-push-review 1.8.0: quick mode. A push of at most `AI_REVIEW_QUICK_LINES`
(60) changed lines gets security, correctness, reliability and the ticket
reviewer instead of all roles; the verifier and the blocking rules are the
same, the run log says `quick: true` and `stats` counts them. The plan said
"skips the panel": a size-based skip would be a bypass (a push can be split
into small ones, and a one-line change can leak a secret), so the quick panel
is a smaller review, never none. The design and readability reviewers are one
role now (`maintainability`): 30 days of the run log showed neither reported
above medium. Expected saving per small push: 3 of 7 reviewer calls instead
of 7 of 8. Not done from the pre-push-review plan's step 4: known non-issues
from a base-branch `REVIEW.md` (precision, not cost).

## 0.5.0: doctor follow-ups (done)

- `doctor` checks the pre-push-review side: `hook.ai-review.command` set
  (one read-only `git config` call), the plugin version next to the hook
  script, and `AI_REVIEW_QUICK_LINES` (0 = whole panel on every push, WARN).
- `doctor` inside a session (`CLAUDECODE` set) reports `env-drift`: the keys
  whose live value differs from `settings.env`. INFO only; the fix is a restart.
  Values are printed only for the doctor's own knobs; any other key is named
  without its value (it may hold a secret).
- Accepted pins: `USAGE_GUARD_ACCEPTED_PINS` names the agents that stay on a
  costly model on purpose; `apply.py --keep-agent-pins` writes it and drops
  FORCE. `agent-models` then passes instead of warning on every run.
- `prompt_audit.py --keep NAME` for the skills a CLAUDE.md declares mandatory.
- `claude_mem.py pause` writes its sidecar before the settings (see phase 4).
- `scripts/claude_config.py` holds the config-dir, JSON-with-backup, plugin and
  frontmatter helpers the four scripts used to copy; `CLAUDE_CONFIG_DIR` is
  read at call time, so tests and callers can redirect it without a reload.

## 0.5.1: spawn budget over a sliding window (done)

- The spawn budget counted every spawn of a session and never went down, so a
  session of several days hit the wall although each spawn had been approved,
  and the refusal left no way forward inside the session.
- The ledger now stores the time of each spawn and only the last
  `USAGE_GUARD_SPAWN_WINDOW_MIN` minutes (120) count; `0` keeps the old
  whole-session count. Lines written by 0.5.0 carry no time and count only then.
- Past the budget the spawn is a permission prompt (`ask`), recorded like any
  other. `USAGE_GUARD_SPAWN_HARD=1` keeps the refusal for unattended runs.
  This changes the default: a run that auto-approves prompts and relied on the
  hard cap of 0.5.0 must set `USAGE_GUARD_SPAWN_HARD=1`.

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
