"""Shared helpers for the usage-guard hooks. Standard library only, no network.

Every hook follows the same contract: read the hook JSON from stdin, never raise,
never exit non-zero, print a JSON decision only when there is something to say.
"""
import json
import os
import sys
import tempfile

DEFAULTS = {
    "USAGE_GUARD_CTX_WARN": 250_000,
    "USAGE_GUARD_CTX_BLOCK": 400_000,
    "USAGE_GUARD_SUBAGENT_CTX_WARN": 150_000,
    "USAGE_GUARD_SUBAGENT_CTX_BLOCK": 300_000,
    "USAGE_GUARD_SPAWN_BUDGET": 8,
    "USAGE_GUARD_PROMPT_BLOCK": 1,
}
TAIL_BYTES = 1_000_000
MAX_TAIL_BYTES = 8_000_000


def setting(name):
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return DEFAULTS[name]
    try:
        return int(raw)
    except ValueError:
        return DEFAULTS[name]


def disabled():
    return os.environ.get("USAGE_GUARD_DISABLE") == "1"


def read_input():
    try:
        data = json.load(sys.stdin)
    except (ValueError, OSError):
        return {}
    return data if isinstance(data, dict) else {}


def emit(obj):
    sys.stdout.write(json.dumps(obj))
    sys.stdout.flush()


def state_dir(data):
    base = data.get("scratchpad_dir") or os.path.join(tempfile.gettempdir(), "usage-guard")
    path = os.path.join(base, "usage-guard")
    try:
        os.makedirs(path, exist_ok=True)
    except OSError:
        path = tempfile.gettempdir()
    return path


def transcript_for(data):
    """The transcript that belongs to the agent the hook fired in.

    Inside a subagent, Claude Code passes the parent session's transcript_path;
    the subagent's own file lives at <dir>/<session_id>/subagents/agent-<agent_id>.jsonl
    (verified on 2.1.x with a logging hook, see docs/RESEARCH.md).
    """
    path = data.get("transcript_path") or ""
    agent_id = data.get("agent_id")
    if agent_id and path:
        sub = os.path.join(os.path.dirname(path), data.get("session_id") or "", "subagents", f"agent-{agent_id}.jsonl")
        return sub
    return path


def last_context(path):
    """Context size (input + cache creation + cache read) of the last assistant message.

    Reads the tail of the file only; transcripts can be hundreds of MB. Returns 0
    when the file is missing or has no assistant message yet.
    """
    if not path or not os.path.exists(path):
        return 0
    size = os.path.getsize(path)
    want = TAIL_BYTES
    while True:
        try:
            with open(path, "rb") as f:
                f.seek(max(0, size - want))
                chunk = f.read()
        except OSError:
            return 0
        for line in reversed(chunk.split(b"\n")):
            if b'"assistant"' not in line or b'"usage"' not in line:
                continue
            try:
                d = json.loads(line)
            except ValueError:
                continue
            if d.get("type") != "assistant":
                continue
            u = (d.get("message") or {}).get("usage") or {}
            return int(u.get("input_tokens") or 0) + int(u.get("cache_creation_input_tokens") or 0) \
                + int(u.get("cache_read_input_tokens") or 0)
        if want >= size or want >= MAX_TAIL_BYTES:
            return 0
        want = min(want * 4, MAX_TAIL_BYTES)


def fmt_k(n):
    return f"{n // 1000}k"
