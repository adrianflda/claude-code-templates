#!/usr/bin/env python3
"""SubagentStart note: tells the subagent its context budget before its first prompt."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts"))
import guard_common as g  # noqa: E402


def main():
    data = g.read_input()
    if g.disabled() or not data:
        return
    warn = g.setting("USAGE_GUARD_SUBAGENT_CTX_WARN")
    block = g.setting("USAGE_GUARD_SUBAGENT_CTX_BLOCK")
    g.emit({"hookSpecificOutput": {"hookEventName": "SubagentStart", "additionalContext":
            f"usage-guard: you share the user's plan limits. Context budget {g.fmt_k(warn)} tokens, tools are denied at "
            f"{g.fmt_k(block)}. Read only what the task needs (grep and line ranges over whole files), do not re-read "
            "files you already saw, and return your report as soon as the task is done."}})


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
