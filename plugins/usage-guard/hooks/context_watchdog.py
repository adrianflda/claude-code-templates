#!/usr/bin/env python3
"""Context watchdog. Runs on PreToolUse (every tool) and UserPromptSubmit.

Main session: warn once per 50k step above USAGE_GUARD_CTX_WARN, deny tools and
(unless USAGE_GUARD_PROMPT_BLOCK=0) block new prompts above USAGE_GUARD_CTX_BLOCK.
Subagents (agent_id present): same with the USAGE_GUARD_SUBAGENT_* thresholds; a
denied tool makes the subagent return its report instead of looping.
Slash commands are never blocked, so /compact and /clear always get through.
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts"))
import guard_common as g  # noqa: E402

STEP = 50_000


def warned_bucket(state_path):
    try:
        with open(state_path) as f:
            return int(json.load(f).get("bucket", -1))
    except (OSError, ValueError):
        return -1


def remember_bucket(state_path, bucket):
    try:
        with open(state_path, "w") as f:
            json.dump({"bucket": bucket}, f)
    except OSError:
        pass


def decide(data, ctx):
    """Return (level, message) where level is None, 'warn' or 'block'."""
    in_subagent = bool(data.get("agent_id"))
    warn = g.setting("USAGE_GUARD_SUBAGENT_CTX_WARN" if in_subagent else "USAGE_GUARD_CTX_WARN")
    block = g.setting("USAGE_GUARD_SUBAGENT_CTX_BLOCK" if in_subagent else "USAGE_GUARD_CTX_BLOCK")
    if ctx >= block:
        if in_subagent:
            msg = (f"usage-guard: this subagent's context is {g.fmt_k(ctx)} tokens, over the {g.fmt_k(block)} hard limit. "
                   "Tools are now denied. Stop and return your report with what you have.")
        else:
            msg = (f"usage-guard: context is {g.fmt_k(ctx)} tokens, over the {g.fmt_k(block)} hard limit. "
                   "Every call re-reads all of it. Run /compact (or /clear) before continuing.")
        return "block", msg
    if ctx >= warn:
        who = "this subagent's context" if in_subagent else "context"
        return "warn", (f"usage-guard: {who} is {g.fmt_k(ctx)} tokens (warn at {g.fmt_k(warn)}, hard stop at {g.fmt_k(block)}). "
                        "Finish the current task without reading more than you need"
                        + ("." if in_subagent else "; compact when you reach a natural stopping point."))
    return None, ""


def main():
    data = g.read_input()
    if g.disabled() or not data:
        return
    event = data.get("hook_event_name")
    if event == "UserPromptSubmit" and str(data.get("prompt", "")).lstrip().startswith("/"):
        return
    ctx = g.last_context(g.transcript_for(data))
    level, msg = decide(data, ctx)
    if level is None:
        return
    key = f"{data.get('session_id', 'na')}-{data.get('agent_id') or 'main'}.ctx.json"
    state_path = os.path.join(g.state_dir(data), key)
    bucket = ctx // STEP
    if level == "warn":
        if bucket <= warned_bucket(state_path):
            return
        remember_bucket(state_path, bucket)
        if event == "PreToolUse":
            g.emit({"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": msg}})
        else:
            g.emit({"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": msg}})
        return
    if event == "PreToolUse":
        g.emit({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                                       "permissionDecisionReason": msg}})
    elif g.setting("USAGE_GUARD_PROMPT_BLOCK"):
        g.emit({"decision": "block", "reason": msg})
    else:
        g.emit({"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": msg}})


if __name__ == "__main__":
    try:
        main()
    except Exception:  # never break the session
        pass
