# Research: why a Claude Code subscription runs out before the week ends

Date: 2026-11-02. Everything below was either read in the official docs (links given)
or measured on one machine with `scripts/report.py`. Measured numbers are marked
as such; they will differ on another laptop. Re-measure before acting.

## 1. How the limits work (official docs)

- Two rolling windows, 5 hours and 7 days, shared across every model and every
  Claude Code surface. [costs](https://code.claude.com/docs/en/costs),
  [usage limits](https://support.claude.com/en/articles/11145838).
- Subagents, agent teams, Workflow agents, `claude -p` runs and plugin-spawned
  workers all draw on the same windows. There is no separate budget for
  background work. [sub-agents](https://code.claude.com/docs/en/sub-agents),
  [headless](https://code.claude.com/docs/en/headless).
- Setting `ANTHROPIC_API_KEY` moves `-p` runs to API billing instead of the plan.
  [env vars](https://code.claude.com/docs/en/settings#environment-variables).
- Agent teams: the docs quote roughly 7x the tokens of a single session.
- `/usage` shows the windows but not which session or subagent consumed them.

## 2. Levers Claude Code exposes

| Lever | Where | Effect |
|---|---|---|
| `effortLevel` / `CLAUDE_CODE_EFFORT_LEVEL` / `/effort` | settings.json | Thinking depth per request; 5.5 models default to `medium` |
| `modelSettings.<model>.effortLevel` | settings.json | Per-model override, wins over the global value |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (100000-1000000) | env | Context size at which auto-compact triggers. Unset means the full 1M window on 1M models |
| `/autocompact`, `/compact` | session | Manual compaction |
| `CLAUDE_CODE_SUBAGENT_MODEL` + `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` | env | Model for all subagents; FORCE overrides `model:` pins in agent frontmatter |
| `skillOverrides` | settings.json | Turn skills off so their descriptions leave the system prompt |
| `ENABLE_TOOL_SEARCH` | env | Defer tool schemas; already on by default here |
| `CLAUDE_CODE_GOAL_CHECKIN_MINUTES=0`, `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false` | env | Remove two small periodic calls |
| Hooks | settings.json / plugin | `UserPromptSubmit`, `PostToolUse`, `Stop`, `PreCompact` accept `decision: block`; `PreToolUse` blocks on exit 2; `SessionStart` / `SubagentStart` only inject context |
| Status line JSON | `statusLine.command` | `rate_limits.five_hour|seven_day.{used_percentage,resets_at}`, `context_window.used_percentage`, `cost.total_cost_usd` [statusline](https://code.claude.com/docs/en/statusline) |

## 3. Measurement method

Every assistant message in `~/.claude/projects/**/*.jsonl` carries `message.usage`
(input, cache creation, cache read, output tokens) and `message.model`. The report:

1. Deduplicates by `(message.id, requestId)`: streaming writes the same message
   several times.
2. Classifies each file: path contains `/subagents/` = subagent (name from the
   file name), directory `-Users-<you>--claude-mem-observer-sessions` = claude-mem,
   anything else = main session.
3. Weights tokens by relative list price (input 1.0, cache write 1.25, cache read
   0.10, output 5.0). This is not what the plan charges; it is the order in which
   consumers drain it.
4. Context per call = input + cache creation + cache read.

## 4. What was measured on the reference machine (7 days, weighted)

| Consumer | Share |
|---|---|
| Subagents (quality-kernel coders at 350-500k context for 200-300 calls each) | 53% |
| Main sessions: half of the calls ran over 200k context and made 64% of main cost | 29% |
| claude-mem observer (Sonnet 4.6 through CLI auth, so on the plan; 6.4M output tokens) | 18% |
| pre-push-review | 3% |

Other findings: global effort `xhigh`; 35 agents + 38 skills ≈ 6,400 tokens of
descriptions on every request and every subagent; 13 agents pinned Opus or Fable;
one project CLAUDE.md at 755 lines; two sessions kept open for days at 800k+ context.

## 5. Community tools reviewed

Usage monitors: ccusage, Claude-Code-Usage-Monitor, claumon, ccwatch,
cost-guardian, tokenward, governor. All read the same transcripts; none attributes
by subagent name or blocks anything. Status lines: ccstatusline (powerline, needs a
Nerd Font), momenbasel/claude-code-statusline, cc-statusline, and the official
`/statusline` generator. No popularity ranking exists; context % appears in nearly
all of them, the 7-day window in few.

## 6. Decisions taken

- Build measurement first (report, doctor, status line), enforcement second (hooks).
- Python standard library only, run with `python3 -I`, no network, no npm.
- Default status line style `minimal` so it works in any font.
- Never touch git config or hooks from the plugin: another plugin on the
  reference machine guards `hook.ai-review.*` and `core.hooksPath`.

## 7. Open questions for phase 2

- Does `PreToolUse` fire inside subagents with the subagent's `transcript_path`?
- Do `rate_limits` arrive in the status line JSON on every plan and version?
- When a hook blocks a tool inside a subagent, does the subagent wrap up or loop?
