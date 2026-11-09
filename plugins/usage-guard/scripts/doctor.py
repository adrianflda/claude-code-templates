#!/usr/bin/env python3
"""usage-guard doctor: lint the Claude Code configuration for plan-draining settings.

Reads ``~/.claude/settings.json``, the enabled plugins, the global agents and
skills, the project CLAUDE.md files, ``~/.claude-mem/settings.json`` (if the
plugin is installed) and the global git ``hook.ai-review.command`` (one
read-only ``git config`` call) and prints one PASS / WARN / INFO line per check
with the fix. Read-only: it never edits anything.

Agents pinned to a costly model on purpose are listed in
``USAGE_GUARD_ACCEPTED_PINS`` (settings.env or the environment: agent names
separated by commas, or ``*``); ``apply.py --keep-agent-pins`` writes it.
Inside a Claude Code session (``CLAUDECODE`` set) the doctor also reports the
keys whose live value differs from settings.env, since settings.env is read at
start-up and a running session keeps what it loaded. Values are shown only for
the knobs the doctor knows (``WATCHED_ENV``); any other settings.env key is
named without its value, since it may hold a secret.
"""
import argparse
import glob
import os
import re
import shlex
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import claude_config as cc  # noqa: E402

HOME = os.path.expanduser("~")
EFFORT_RANK = {"low": 0, "medium": 1, "high": 2, "xhigh": 3, "max": 4}
COSTLY_MODELS = cc.COSTLY_MODELS
QUICK_LINES_DEFAULT = 60       # pre-push-review: pushes of at most this many changed lines get the quick panel
QUICK_MODE_VERSION = (1, 8, 0)  # the first pre-push-review with quick mode
# settings.env keys the doctor evaluates; env-drift compares these and every settings.env key with the session,
# and prints values for these only (any other key may hold a secret)
WATCHED_ENV = ("CLAUDE_CODE_EFFORT_LEVEL", "CLAUDE_CODE_AUTO_COMPACT_WINDOW", "CLAUDE_CODE_SUBAGENT_MODEL",
               "CLAUDE_CODE_SUBAGENT_MODEL_FORCE", "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS", "AI_REVIEW_QUICK_LINES",
               "USAGE_GUARD_ACCEPTED_PINS")


def git_hook_command():
    """The global git ``hook.ai-review.command``, or None when git is missing, slow or the key is unset. Read-only."""
    try:
        r = subprocess.run(["git", "config", "--global", "--get", "hook.ai-review.command"],
                           capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return None
    return r.stdout.strip() or None


def hook_plugin_version(command):
    """Version of the plugin whose ``scripts/*.mjs`` the hook command runs, or None."""
    try:
        parts = shlex.split(command)
    except ValueError:
        parts = command.split()
    for tok in parts:
        if tok.endswith((".mjs", ".js", ".cjs")):
            root = os.path.dirname(os.path.dirname(os.path.abspath(os.path.expanduser(tok))))
            return (cc.read_json(os.path.join(root, ".claude-plugin", "plugin.json"), {}) or {}).get("version")
    return None


def version_tuple(version):
    """'1.8.1' -> (1, 8, 1); padded to three parts so '1.8' compares equal to 1.8.0, not below it."""
    out = []
    for part in str(version).split("."):
        m = re.match(r"\d+", part)
        out.append(int(m.group()) if m else 0)
    while len(out) < 3:
        out.append(0)
    return tuple(out)


def quick_lines(value):
    """What the panel makes of AI_REVIEW_QUICK_LINES: unset = 60, a number = that number, anything else = 0."""
    if value is None:
        return QUICK_LINES_DEFAULT
    try:
        return max(0, int(float(str(value).strip())))
    except (ValueError, OverflowError):  # "abc", "" -> ValueError; "inf" -> OverflowError on int()
        return 0


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
    config = cc.config_dir()
    settings = cc.read_json(os.path.join(config, "settings.json"), {}) or {}
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
    forced = bool(sub and str(force) == "1")
    if not sub:
        rep.add("WARN", "subagent-model", "unset: subagents inherit the session model or their definition",
                'add "CLAUDE_CODE_SUBAGENT_MODEL": "sonnet" to settings.env (apply.py); FORCE=1 only to override pinned agents too')
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

    # 6. agent definitions forcing costly models (accepted ones are listed in USAGE_GUARD_ACCEPTED_PINS)
    agent_files, costly = cc.costly_agent_pins(config, settings)
    accepted_raw = osenv.get("USAGE_GUARD_ACCEPTED_PINS") or env.get("USAGE_GUARD_ACCEPTED_PINS") or ""
    accepted = {n.strip() for n in str(accepted_raw).split(",") if n.strip()}
    unaccepted = [f"{n}={m}" for n, m in costly if "*" not in accepted and n not in accepted]
    if unaccepted and not forced:
        rep.add("WARN", "agent-models", f"{len(unaccepted)} of {len(agent_files)} agents pin a costly model: {', '.join(unaccepted[:8])}{'…' if len(unaccepted) > 8 else ''}",
                "change model: to sonnet; keep them on purpose with apply.py --keep-agent-pins (USAGE_GUARD_ACCEPTED_PINS); "
                "or set CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1 to override every pin")
    else:
        note = ""
        if costly and forced:
            note = " (overridden by FORCE)"
        elif costly:
            note = f" ({len(costly)} accepted on purpose)"
        rep.add("PASS", "agent-models", f"{len(agent_files)} agents, {len(costly)} costly pins{note}")

    # 7. system prompt load: agents + skills descriptions
    plugin_dirs = cc.enabled_plugin_dirs(settings, config)
    skill_files = glob.glob(os.path.join(config, "skills", "*", "SKILL.md"))
    for _, d in plugin_dirs:
        skill_files += glob.glob(os.path.join(d, "skills", "*", "SKILL.md"))
    overrides = settings.get("skillOverrides") or {}
    off = sum(1 for v in overrides.values() if v in ("off", "user-invocable-only"))
    desc_chars = 0
    for p in agent_files + skill_files:
        desc = cc.frontmatter_fields(p)["description"]
        desc_chars += len(desc) if desc else 200
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
    mem = cc.read_json(os.path.join(HOME, ".claude-mem", "settings.json"), {}) or {}
    if mem_on and mem:
        provider = mem.get("CLAUDE_MEM_PROVIDER", "claude")
        model = mem.get("CLAUDE_MEM_MODEL", "")
        excluded = [p.strip() for p in (mem.get("CLAUDE_MEM_EXCLUDED_PROJECTS") or "").split(",")]
        if "**" in excluded:
            rep.add("PASS", "claude-mem", "paused (CLAUDE_MEM_EXCLUDED_PROJECTS matches every project); scripts/claude_mem.py resume")
        elif provider == "claude" and "haiku" not in model:
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

    # 12. pre-push-review: is the git hook installed, and does a small push get the quick panel
    hook = git_hook_command()
    quick_raw = osenv.get("AI_REVIEW_QUICK_LINES")
    if quick_raw is None:
        quick_raw = env.get("AI_REVIEW_QUICK_LINES")
    if not hook:
        rep.add("INFO", "pre-push-review", "git hook.ai-review.command is not set: no review panel runs on git push",
                "install the pre-push-review plugin and its global git hook (plugins/pre-push-review/README.md)")
    else:
        version = hook_plugin_version(hook)
        if version is None:
            rep.add("INFO", "pre-push-review", f"hook set but no plugin.json next to its script: {hook}",
                    "point hook.ai-review.command at <pre-push-review>/scripts/git-pre-push.mjs")
        elif version_tuple(version) < QUICK_MODE_VERSION:
            rep.add("INFO", "pre-push-review", f"version {version}: the quick panel for pushes of <={QUICK_LINES_DEFAULT} changed lines needs 1.8.0",
                    "update the pre-push-review plugin")
        elif quick_lines(quick_raw) == 0:
            rep.add("WARN", "pre-push-review", f"version {version}, AI_REVIEW_QUICK_LINES={quick_raw!r}: whole panel on every push",
                    f"unset AI_REVIEW_QUICK_LINES or set it to {QUICK_LINES_DEFAULT}")
        else:
            source = "default" if quick_raw is None else "AI_REVIEW_QUICK_LINES"
            rep.add("PASS", "pre-push-review", f"version {version}, quick panel at <={quick_lines(quick_raw)} changed lines ({source})")

    # 13. inside a session: does the live environment still match settings.env
    if osenv.get("CLAUDECODE"):
        drift = []
        for key in sorted(set(env) | set(WATCHED_ENV)):
            live = osenv.get(key)
            want = env.get(key)
            want = "" if want is None else str(want)
            if (live or "") == want:
                continue
            if key in WATCHED_ENV:
                drift.append(f"{key} session={live!r} settings={want or None!r}")
            else:  # any other settings.env key may hold a secret: name it, never print a value
                drift.append(f"{key} (values hidden) session={'set' if live else 'unset'} settings={'set' if want else 'unset'}")
        if drift:
            rep.add("INFO", "env-drift", "; ".join(drift),
                    "restart Claude Code to run on settings.env; a key only the session has comes from the shell profile or from an earlier settings.env still loaded")
        else:
            rep.add("PASS", "env-drift", f"session environment matches settings.env ({len(env)} keys)")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cwd", default=os.getcwd())
    args = ap.parse_args(argv)
    rep = Report()
    run(args.cwd, rep)
    return 1 if rep.dump() else 0


if __name__ == "__main__":
    sys.exit(main())
