#!/usr/bin/env python3
"""Subagent spawn budget. Runs on PreToolUse for the Agent tool.

Keeps a per-session ledger of allowed spawns in the scratchpad directory and
denies the call once USAGE_GUARD_SPAWN_BUDGET (default 8, 0 = unlimited) is
reached. The last two allowed spawns carry a reminder of how many remain.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts"))
import guard_common as g  # noqa: E402


def ledger_path(data):
    return os.path.join(g.state_dir(data), f"{data.get('session_id', 'na')}.spawns")


def count(path):
    try:
        with open(path) as f:
            return sum(1 for _ in f)
    except OSError:
        return 0


def record(path, data):
    try:
        with open(path, "a") as f:
            f.write(f"{(data.get('tool_input') or {}).get('subagent_type', '?')}\n")
    except OSError:
        pass


def main():
    data = g.read_input()
    if g.disabled() or not data or data.get("tool_name") != "Agent":
        return
    budget = g.setting("USAGE_GUARD_SPAWN_BUDGET")
    if budget <= 0:
        return
    path = ledger_path(data)
    used = count(path)
    if used >= budget:
        g.emit({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                                       "permissionDecisionReason":
                                       f"usage-guard: this session already spawned {used} subagents (budget {budget}). "
                                       "Each one pays its own system prompt and context on the plan. Do the work inline, "
                                       "or ask the user to raise USAGE_GUARD_SPAWN_BUDGET if more are really needed."}})
        return
    record(path, data)
    left = budget - used - 1
    if left <= 1:
        g.emit({"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext":
                                       f"usage-guard: {left} subagent spawn(s) left in this session's budget of {budget}."}})


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
