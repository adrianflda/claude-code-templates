#!/usr/bin/env python3
"""Subagent spawn budget. Runs on PreToolUse for the Agent tool.

Keeps a per-session ledger of spawns (one "<epoch>\t<agent type>" line each) in
the scratchpad directory and counts the ones inside a sliding window of
USAGE_GUARD_SPAWN_WINDOW_MIN minutes (default 120, 0 = the whole session). A
burst is what drains the plan; a long session that spawns a few agents an hour
is not, and its old spawns fall out of the count.

Once USAGE_GUARD_SPAWN_BUDGET (default 8, 0 = unlimited) is reached the call is
handed to the user as a permission prompt instead of being refused, so an
approved plan is never stuck. The ledger counts attempts: a spawn the user is
asked about is recorded even if they decline it. USAGE_GUARD_SPAWN_HARD=1
refuses instead (and records nothing), for runs nobody is watching. The last
two spawns under the budget carry a reminder of how many remain.
"""
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts"))
import guard_common as g  # noqa: E402

COST_NOTE = "Each one pays its own system prompt and context on the plan."


def ledger_path(data):
    return os.path.join(g.state_dir(data), f"{data.get('session_id', 'na')}.spawns")


def spawn_time(line):
    """Epoch of a ledger line; 0 for a line written before the ledger carried a time."""
    stamp, tab, _ = line.partition("\t")
    try:
        return float(stamp) if tab else 0.0
    except ValueError:
        return 0.0


def count(path, since):
    try:
        with open(path) as f:
            return sum(1 for line in f if spawn_time(line) >= since)
    except OSError:
        return 0


def record(path, data, now):
    try:
        with open(path, "a") as f:
            f.write(f"{int(now)}\t{(data.get('tool_input') or {}).get('subagent_type', '?')}\n")
    except OSError:
        pass


def decide(decision, reason):
    g.emit({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": decision,
                                   "permissionDecisionReason": reason}})


def main():
    data = g.read_input()
    if g.disabled() or not data or data.get("tool_name") != "Agent":
        return
    budget = g.setting("USAGE_GUARD_SPAWN_BUDGET")
    if budget <= 0:
        return
    window = max(0, g.setting("USAGE_GUARD_SPAWN_WINDOW_MIN"))
    now = time.time()
    path = ledger_path(data)
    used = count(path, now - window * 60 if window else 0.0)
    span = f"in the last {window} min" if window else "in this session"
    if used >= budget:
        reason = f"usage-guard: {used} subagents spawned {span} (budget {budget}). {COST_NOTE}"
        if g.setting("USAGE_GUARD_SPAWN_HARD") == 1:
            decide("deny", f"{reason} Do the work inline, or ask the user to raise USAGE_GUARD_SPAWN_BUDGET "
                           "if more are really needed.")
            return
        record(path, data, now)
        decide("ask", f"{reason} Approve to spawn this one anyway.")
        return
    record(path, data, now)
    left = budget - used - 1
    if left <= 1:
        g.emit({"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext":
                                       f"usage-guard: {left} subagent spawn(s) left {span} (budget {budget})."}})


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
