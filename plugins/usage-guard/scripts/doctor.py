#!/usr/bin/env python3
"""usage-guard doctor: lint the Claude Code configuration for plan-draining settings.

Reads ``~/.claude/settings.json``, the enabled plugins, the global agents and
skills, the project CLAUDE.md files and ``~/.claude-mem/settings.json`` (if the
plugin is installed) and prints one PASS / WARN / INFO line per check with the
fix. Read-only: it never edits anything.
"""
import argparse
import glob
import json
import os
import re
import sys

HOME = os.path.expanduser("~")
CONFIG = os.environ.get("CLAUDE_CONFIG_DIR", os.path.join(HOME, ".claude"))
EFFORT_RANK = {"low": 0, "medium": 1, "high": 2, "xhigh": 3, "max": 4}
COSTLY_MODELS = ("opus", "fable", "mythos")


def read_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def frontmatter_model(path):
    try:
        with open(path, encoding="utf-8") as f:
            head = f.read(4000)
    except OSError:
        return None
    m = re.search(r"^model:\s*([^\s#]+)", head, re.M)
    return m.group(1).strip().strip('"').strip("'") if m else None


def enabled_plugin_dirs(settings):
    dirs = []
    installed = read_json(os.path.join(CONFIG, "plugins", "installed_plugins.json")).get("plugins", {})
    for name, on in (settings.get("enabledPlugins") or {}).items():
        if not on:
            continue
        for entry in installed.get(name, []):
            p = entry.get("installPath")
            if p and os.path.isdir(p):
                dirs.append((name, p))
    return dirs


class Report:
    def __init__(self):
        self.rows = []

    def add(self, status, check, detail, fix=""):
        self.rows.append((status, check, detail, fix))

    def dump(self):
        width = max(len(r[1]) for r in self.rows) if self.rows else 10
        for status, check, detail, fix in self.rows:
            line = f"{status:4} {check:{width}}  {detail}"
            if fix and status != "PASS":
                line += f"\n     fix: {fix}"
            print(line)
        warns = sum(1 for r in self.rows if r[0] == "WARN")
        print(f"\n{warns} warning(s), {len(self.rows)} check(s)")
        return warns


def run(cwd, rep):
    settings = read_json(os.path.join(CONFIG, "settings.json"))
    env = settings.get("env") or {}
    osenv = os.environ

    # 1. effort
    eff = osenv.get("CLAUDE_CODE_EFFORT_LEVEL") or settings.get("effortLevel") or "medium"
    per_model = {k: v.get("effortLevel") for k, v in (settings.get("modelSettings") or {}).items() if isinstance(v, dict) and v.get("effortLevel")}
    high = {k: v for k, v in per_model.items() if EFFORT_RANK.get(v, 1) > 1}
    if EFFORT_RANK.get(eff, 1) > 1 or high:
        rep.add("WARN", "effort", f"global={eff} per-model={per_model or '-'}",
                "set effortLevel to medium; raise with /effort only for the task that needs it")
    else:
        rep.add("PASS", "effort", f"global={eff} per-model={per_model or '-'}")

    # 2. auto-compact window
    win = osenv.get("CLAUDE_CODE_AUTO_COMPACT_WINDOW") or env.get("CLAUDE_CODE_AUTO_COMPACT_WINDOW")
    try:
        win_n = int(str(win).lower().replace("k", "000")) if win else None
    except ValueError:
        win_n = None
    if win_n is None:
        rep.add("WARN", "autocompact", "window unset: 1M-context models compact only near 1M",
                'add "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "200000" to settings.env (or /autocompact 200k)')
    elif win_n > 300000:
        rep.add("WARN", "autocompact", f"window={win}", "lower it to 200000")
    else:
        rep.add("PASS", "autocompact", f"window={win}")

    # 3. subagent model
    sub = osenv.get("CLAUDE_CODE_SUBAGENT_MODEL") or env.get("CLAUDE_CODE_SUBAGENT_MODEL")
    force = osenv.get("CLAUDE_CODE_SUBAGENT_MODEL_FORCE") or env.get("CLAUDE_CODE_SUBAGENT_MODEL_FORCE")
    if not sub:
        rep.add("WARN", "subagent-model", "unset: subagents inherit the session model or their definition",
                'add "CLAUDE_CODE_SUBAGENT_MODEL": "sonnet" and "CLAUDE_CODE_SUBAGENT_MODEL_FORCE": "1" to settings.env')
    elif any(m in str(sub) for m in COSTLY_MODELS):
        rep.add("WARN", "subagent-model", f"{sub} (force={force or '0'})", "use sonnet or haiku")
    else:
        rep.add("PASS", "subagent-model", f"{sub} (force={force or '0'})")

    # 4. agent teams
    teams = osenv.get("CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS") or env.get("CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS")
    if str(teams) == "1":
        rep.add("INFO", "agent-teams", "enabled: the docs report about 7x tokens with teammates in plan mode",
                "disable when not in use")
    else:
        rep.add("PASS", "agent-teams", "disabled")

    # 5. API key in environment
    if osenv.get("ANTHROPIC_API_KEY"):
        rep.add("INFO", "api-key", "ANTHROPIC_API_KEY is set: `claude -p` runs bill the API, not the plan",
                "intended? keep. Otherwise unset it")
    else:
        rep.add("PASS", "api-key", "not set: everything bills the subscription")

    # 6. agent definitions forcing costly models
    plugin_dirs = enabled_plugin_dirs(settings)
    agent_files = glob.glob(os.path.join(CONFIG, "agents", "*.md"))
    for _, d in plugin_dirs:
        agent_files += glob.glob(os.path.join(d, "agents", "*.md"))
    costly = []
    for p in agent_files:
        m = frontmatter_model(p)
        if m and any(x in m for x in COSTLY_MODELS):
            costly.append(f"{os.path.basename(p)[:-3]}={m}")
    if costly and not (sub and str(force) == "1"):
        rep.add("WARN", "agent-models", f"{len(costly)} of {len(agent_files)} agents pin a costly model: {', '.join(costly[:8])}{'…' if len(costly) > 8 else ''}",
                "change model: to sonnet, or set CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1")
    else:
        rep.add("PASS", "agent-models", f"{len(agent_files)} agents, {len(costly)} costly pins{' (overridden by FORCE)' if costly else ''}")

    # 7. system prompt load: agents + skills descriptions
    skill_files = glob.glob(os.path.join(CONFIG, "skills", "*", "SKILL.md"))
    for _, d in plugin_dirs:
        skill_files += glob.glob(os.path.join(d, "skills", "*", "SKILL.md"))
    overrides = settings.get("skillOverrides") or {}
    off = sum(1 for v in overrides.values() if v in ("off", "user-invocable-only"))
    desc_chars = 0
    for p in agent_files + skill_files:
        try:
            with open(p, encoding="utf-8") as f:
                head = f.read(3000)
            m = re.search(r"^description:\s*(.+?)(?=^\w+:|^---)", head, re.M | re.S)
            desc_chars += len(m.group(1)) if m else 200
        except OSError:
            pass
    est = desc_chars // 4
    status = "WARN" if est > 6000 else "INFO"
    rep.add(status, "prompt-load", f"{len(agent_files)} agents + {len(skill_files)} skills ({off} hidden by skillOverrides) ≈ {est:,} tokens of descriptions on every request and every subagent",
            "run scripts/prompt_audit.py for the unused ones and a skillOverrides block")

    # 8. CLAUDE.md sizes on the cwd chain
    big = []
    path = os.path.abspath(cwd)
    while True:
        for name in ("CLAUDE.md", os.path.join(".claude", "CLAUDE.md")):
            p = os.path.join(path, name)
            if os.path.isfile(p):
                try:
                    with open(p, encoding="utf-8") as f:
                        lines = sum(1 for _ in f)
                except OSError:
                    lines = 0
                if lines > 200:
                    big.append(f"{p} ({lines} lines)")
        parent = os.path.dirname(path)
        if parent == path:
            break
        path = parent
    if big:
        rep.add("WARN", "claude-md", "; ".join(big), "keep CLAUDE.md under ~200 lines; move workflows into skills")
    else:
        rep.add("PASS", "claude-md", "no CLAUDE.md over 200 lines on the cwd chain")

    # 9. claude-mem
    mem_on = bool((settings.get("enabledPlugins") or {}).get("claude-mem@thedotmack"))
    mem = read_json(os.path.join(HOME, ".claude-mem", "settings.json"))
    if mem_on and mem:
        provider = mem.get("CLAUDE_MEM_PROVIDER", "claude")
        model = mem.get("CLAUDE_MEM_MODEL", "")
        if provider == "claude" and "haiku" not in model:
            rep.add("WARN", "claude-mem", f"provider={provider} model={model}: every tool call is summarized on your plan",
                    'set CLAUDE_MEM_MODEL to "haiku", move CLAUDE_MEM_PROVIDER off "claude", or disable the plugin')
        else:
            rep.add("PASS", "claude-mem", f"provider={provider} model={model}")
    else:
        rep.add("PASS", "claude-mem", "not enabled")

    # 10. status line shows the weekly limit
    cmd = (settings.get("statusLine") or {}).get("command", "")
    if "usage-guard" in cmd or "rate_limits" in cmd or "seven_day" in cmd:
        rep.add("PASS", "statusline", "shows rate limits")
    else:
        rep.add("INFO", "statusline", "does not show the 7-day limit", "point statusLine.command at usage-guard/scripts/statusline.py")

    # 11. fallback / fast mode
    if settings.get("fallbackModel"):
        rep.add("INFO", "fallback-model", f"{settings['fallbackModel']}", "")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cwd", default=os.getcwd())
    args = ap.parse_args(argv)
    rep = Report()
    run(args.cwd, rep)
    return 1 if rep.dump() else 0


if __name__ == "__main__":
    sys.exit(main())
