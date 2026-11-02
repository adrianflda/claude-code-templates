# usage-guard

Keeps a Claude Code subscription inside its weekly limit.

Subagents, workflow agents and `claude -p` runs all draw on the same 5-hour and
7-day windows as the main conversation ([costs](https://code.claude.com/docs/en/costs),
[sub-agents](https://code.claude.com/docs/en/sub-agents)). Nothing in Claude Code
tells you which of them is draining the plan, or stops a session whose context has
grown to 800k tokens. This plugin does the measuring first and the stopping next.

## What ships today (phases 1 to 4)

| Tool | What it does |
|---|---|
| `scripts/report.py` | Price-weighted attribution from `~/.claude/projects/**/*.jsonl`: by kind (main / subagent / claude-mem observer), model, day, session and subagent name, plus context-per-call percentiles |
| `scripts/doctor.py` | Read-only lint of `settings.json`, enabled plugins, agents, skills, CLAUDE.md and claude-mem. One PASS / WARN / INFO line per check with the fix |
| `scripts/statusline.py` | Status line with context %, 5-hour and 7-day limits, reset countdown and burn pace. Four styles |
| `scripts/apply.py` | Phase 0 baseline applier: dry run by default, `--apply` writes with backups, idempotent |
| `scripts/prompt_audit.py` | Prompt audit: every agent and skill loaded into the system prompt with its invocation count over the last 30 days (Skill tool, Agent tool, typed `/commands`), unused agent files, and a `skillOverrides` block; `--apply` merges it with a backup |
| `scripts/claude_mem.py` | claude-mem observer: `status` (provider, model, auth, pause state, worker), `pause` / `resume` (the hooks skip every project, in running sessions too; reversible), `provider claude\|gemini\|openrouter [--model]` (refuses while the provider's key is empty; never handles keys; restarts the worker) |
| `hooks/context_watchdog.py` | `PreToolUse` + `UserPromptSubmit`: warns from 250k context, denies tools and blocks prompts from 400k (subagents: 150k / 300k, so they return their report instead of looping) |
| `hooks/spawn_budget.py` | `PreToolUse` on `Agent`: per-session spawn budget, default 8 |
| `hooks/subagent_note.py` | `SubagentStart`: budget note injected into every subagent |
| `/usage-guard` | `report [days]`, `doctor`, `audit [days]`, `setup`, `statusline`, `hooks`, `mem [status\|pause\|resume\|provider …]` |
| `skills/usage-guard` | Runbook another agent follows to replicate the setup on a new machine |
| `docs/` | `RESEARCH.md` (limits, levers, method, measurements, community tools) and `PLAN.md` (phases 0-4) |

### Weights

`report.py` ranks consumers by the relative API list price of each token class
(input 1.0, cache write 1.25, cache read 0.10, output 5.0). It is not a bill. It
is the order in which things drain the plan.

### Status line

```json
"statusLine": {
  "type": "command",
  "command": "python3 /path/to/plugins/usage-guard/scripts/statusline.py --style minimal"
}
```

Styles: `minimal` (plain text, any font), `bar` (block progress bars), `powerline`
(Nerd Font glyphs, colored segments), `multiline` (identity on line 1, budgets on
line 2). `--preview` renders all four with sample data. `USAGE_GUARD_STATUSLINE_STYLE`
sets the default.

`pace` is `used / expected-if-linear` for the 7-day window: `1.0x` is on track,
`1.6x` means the week runs out on Thursday. The fields come from the
[status line JSON](https://code.claude.com/docs/en/statusline) (`rate_limits.seven_day`).

### Doctor checks

effort level, auto-compact window, subagent model and force flag, agent teams,
`ANTHROPIC_API_KEY` presence, agent definitions pinning Opus/Fable, estimated
prompt load of agent + skill descriptions, CLAUDE.md files over 200 lines on the
cwd chain, claude-mem provider and model, status line showing the weekly limit.

## Replicate on another machine

```bash
claude plugin marketplace add adrianflda/claude-code-templates
claude plugin install usage-guard@adrianflda-claude-code-templates
```

Then `/usage-guard report`, `/usage-guard doctor`, `/usage-guard setup`. The skill
loads automatically when the user talks about running out of limits.

### Hook knobs

All optional, set in the `env` block of `settings.json` or the shell:
`USAGE_GUARD_CTX_WARN` (250000), `USAGE_GUARD_CTX_BLOCK` (400000),
`USAGE_GUARD_SUBAGENT_CTX_WARN` (150000), `USAGE_GUARD_SUBAGENT_CTX_BLOCK`
(300000), `USAGE_GUARD_SPAWN_BUDGET` (8, `0` = unlimited),
`USAGE_GUARD_PROMPT_BLOCK` (`1`; `0` only warns), `USAGE_GUARD_DISABLE=1` (all
hooks become no-ops). Slash commands such as `/compact` are never blocked.
Hooks exit 0 on any error and time out at 5 s, so they cannot stall a session.

### Prompt audit

`skillOverrides` values, verified in the Claude Code 2.1.316 binary: `on`, `off`
and `user-invocable-only` (hidden from the model, so its description leaves the
prompt, but `/name` still works). Keys are the skill name, prefixed with
`plugin:` for plugin skills. The audit suggests `user-invocable-only` by default
because it is reversible and cannot break a workflow; pass `--mode off` to
remove skills entirely. Skills whose file is younger than `--grace` days
(default 7) are never suggested, and agent files are only listed, never moved.

### claude-mem observer

claude-mem summarizes every tool call with a model call of its own. With
`CLAUDE_MEM_PROVIDER=claude` and the `cli` auth method those calls run on the
Claude Code OAuth token, so they count against the subscription (the worker's
`/api/health` says which token it runs on; `claude_mem.py status` shows it).

`pause` does not stop the worker (every `SessionStart` hook would start it
again). It uses claude-mem's own exclusion list: each hook is a fresh process
that reads `~/.claude-mem/settings.json` and skips the project when its cwd
matches a glob in `CLAUDE_MEM_EXCLUDED_PROJECTS` (anchored, `**` matches every
path). `pause` sets `**` and keeps the previous list in
`~/.claude-mem/usage-guard-pause.json`; `resume` restores it. It takes effect
in running sessions from the next tool call, keeps memory search and the
session-start context working, and touches no plugin file. Verified on
claude-mem 13.11.0: the observation hook logs "Project excluded from tracking"
and enqueues nothing.

`provider gemini|openrouter` refuses while that provider's API key is empty in
`settings.json`: paste the key there by hand first. The script never reads
keys from the command line, never prints them and never writes them. Every
write backs `settings.json` up first.

pre-push-review 1.8.0 adds the matching cost lever on its side: a quick panel
for pushes of at most 60 changed lines (see that plugin's README).

## Roadmap

Phases 0 to 4 are done. Next candidates, measured first: a weekly digest of
`report.py`, and a `doctor` check for the pre-push-review quick-mode knob.

## Tests

```bash
python3 -I -m unittest discover -s plugins/usage-guard/test -v
```

Requires Python 3.9+. No dependencies, no network, no subprocesses.
