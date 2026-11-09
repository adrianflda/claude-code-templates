#!/usr/bin/env python3
"""Apply the usage-guard baseline (plan phase 0) to this machine, idempotently.

Dry run by default: prints every change it would make and exits 0 (or 3 when
changes are pending). ``--apply`` writes them, after copying each file it touches
to ``<file>.bak-<timestamp>``. Never touches git config, hooks or plugins.

    python3 -I apply.py                 # show pending changes
    python3 -I apply.py --apply         # write them
    python3 -I apply.py --style bar --effort high --no-claude-mem
    python3 -I apply.py --apply --keep-agent-pins   # agents pinned to Opus stay on Opus

By default every subagent runs on ``--subagent-model``: ``CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1``
overrides the ``model:`` pins in the agent files. ``--keep-agent-pins`` drops
FORCE instead, so a pinned agent keeps its model, and records the pinned names
in ``USAGE_GUARD_ACCEPTED_PINS`` so ``doctor.py`` stops warning about them.
"""
import argparse
import glob
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import claude_config as cc  # noqa: E402

STATUSLINE = os.path.join(HERE, "statusline.py")
STYLES = ("minimal", "bar", "powerline", "multiline")


def set_path(data, keys, value, changes, label):
    """Set data[k1][k2]... = value, recording a change line when it differs."""
    node = data
    for k in keys[:-1]:
        node = node.setdefault(k, {})
    old = node.get(keys[-1])
    if old != value:
        changes.append(f"{label}: {old!r} -> {value!r}")
        node[keys[-1]] = value


def del_path(data, keys, changes, label):
    """Remove data[k1][k2]... when present, recording a change line."""
    node = data
    for k in keys[:-1]:
        node = node.get(k) if isinstance(node, dict) else None
        if node is None:
            return
    if isinstance(node, dict) and keys[-1] in node:
        changes.append(f"{label}: {node[keys[-1]]!r} -> (removed)")
        del node[keys[-1]]


def plan_settings(settings, args):
    changes = []
    set_path(settings, ["effortLevel"], args.effort, changes, "effortLevel")
    for model, cfg in (settings.get("modelSettings") or {}).items():
        if isinstance(cfg, dict) and "effortLevel" in cfg:
            set_path(settings, ["modelSettings", model, "effortLevel"], args.effort, changes,
                     f"modelSettings.{model}.effortLevel")
    set_path(settings, ["env", "CLAUDE_CODE_AUTO_COMPACT_WINDOW"], str(args.autocompact), changes,
             "env.CLAUDE_CODE_AUTO_COMPACT_WINDOW")
    set_path(settings, ["env", "CLAUDE_CODE_SUBAGENT_MODEL"], args.subagent_model, changes,
             "env.CLAUDE_CODE_SUBAGENT_MODEL")
    if args.keep_agent_pins:
        _, costly = cc.costly_agent_pins(cc.config_dir(), settings)
        del_path(settings, ["env", "CLAUDE_CODE_SUBAGENT_MODEL_FORCE"], changes, "env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE")
        if costly:
            set_path(settings, ["env", "USAGE_GUARD_ACCEPTED_PINS"], ",".join(name for name, _ in costly), changes,
                     "env.USAGE_GUARD_ACCEPTED_PINS")
        else:
            del_path(settings, ["env", "USAGE_GUARD_ACCEPTED_PINS"], changes, "env.USAGE_GUARD_ACCEPTED_PINS")
    else:
        set_path(settings, ["env", "CLAUDE_CODE_SUBAGENT_MODEL_FORCE"], "1", changes,
                 "env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE")
    if args.style != "keep":
        cmd = f"python3 {STATUSLINE} --style {args.style}"
        set_path(settings, ["statusLine", "type"], "command", changes, "statusLine.type")
        set_path(settings, ["statusLine", "command"], cmd, changes, "statusLine.command")
    return changes


def plan_claude_mem(mem, args):
    changes = []
    set_path(mem, ["CLAUDE_MEM_MODEL"], args.claude_mem_model, changes, "CLAUDE_MEM_MODEL")
    return changes


def restart_claude_mem_worker():
    runners = sorted(glob.glob(os.path.join(cc.config_dir(), "plugins/cache/thedotmack/claude-mem/*/scripts/bun-runner.js")))
    if not runners:
        return "claude-mem worker: plugin not found, nothing to restart"
    runner = runners[-1]
    worker = os.path.join(os.path.dirname(runner), "worker-service.cjs")
    try:
        r = subprocess.run(["node", runner, worker, "restart"], capture_output=True, text=True, timeout=60)
        last = (r.stdout.strip().splitlines() or ["(no output)"])[-1]
        return f"claude-mem worker restart: {last}"
    except (OSError, subprocess.SubprocessError) as e:
        return f"claude-mem worker restart failed ({e}); run it by hand"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apply", action="store_true", help="write the changes (default: dry run)")
    ap.add_argument("--effort", default="medium", choices=["low", "medium", "high", "xhigh", "max"])
    ap.add_argument("--autocompact", type=int, default=200000, help="CLAUDE_CODE_AUTO_COMPACT_WINDOW (100000-1000000)")
    ap.add_argument("--subagent-model", default="sonnet")
    ap.add_argument("--keep-agent-pins", action="store_true",
                    help="agents pinned to Opus/Fable/Mythos keep their model: drop CLAUDE_CODE_SUBAGENT_MODEL_FORCE "
                         "and list the pinned names in USAGE_GUARD_ACCEPTED_PINS (the doctor stops warning about them)")
    ap.add_argument("--style", default="minimal", choices=STYLES + ("keep",), help="status line style, or keep")
    ap.add_argument("--claude-mem-model", default="haiku")
    ap.add_argument("--no-claude-mem", action="store_true", help="leave ~/.claude-mem/settings.json alone")
    args = ap.parse_args(argv)
    if not 100000 <= args.autocompact <= 1000000:
        ap.error("--autocompact must be between 100000 and 1000000")

    pending = 0
    settings_path = os.path.join(cc.config_dir(), "settings.json")
    settings = cc.read_json(settings_path, None, strict=True)  # a broken settings file stops here, it is never overwritten
    if settings is None:
        settings = {}
        print(f"{settings_path}: missing, will be created")
    changes = plan_settings(settings, args)
    print(f"{settings_path}: {len(changes)} change(s)")
    for c in changes:
        print("  " + c)
    pending += len(changes)
    if args.apply and changes:
        cc.write_json_with_backup(settings_path, settings)

    mem_path = os.path.expanduser("~/.claude-mem/settings.json")
    mem_changes = []
    if not args.no_claude_mem:
        mem = cc.read_json(mem_path, None, strict=True)
        if mem is None:
            print(f"{mem_path}: not present, claude-mem step skipped")
        else:
            mem_changes = plan_claude_mem(mem, args)
            print(f"{mem_path}: {len(mem_changes)} change(s)")
            for c in mem_changes:
                print("  " + c)
            pending += len(mem_changes)
            if args.apply and mem_changes:
                cc.write_json_with_backup(mem_path, mem)
                print("  " + restart_claude_mem_worker())

    if not args.apply and pending:
        print(f"\n{pending} pending change(s). Re-run with --apply to write them (backups are kept next to each file).")
        return 3
    if args.apply and pending:
        print("\nApplied. Restart Claude Code sessions for env changes to take effect; run doctor.py to confirm.")
    if not pending:
        print("\nNothing to change: baseline already applied.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
