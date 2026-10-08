#!/usr/bin/env python3
"""Quality-Kernel evidence-gate - v2 (audit layer).

PostToolUse + PostToolUseFailure hook on Bash. Records that a test/build/verify-shaped
command RAN, with its exit code, to a per-project ledger (.quality-kernel/evidence-ledger.jsonl).

Exit codes: PostToolUse fires only when the command succeeded -> exit_code 0. Failures arrive
via PostToolUseFailure, whose `error` string starts with "Exit code N" (documented: key the hook
on that first line, treat the rest as display text). The Bash `tool_response` itself has no
exit-code field. Rows carry source="bash-hook"; the `referee` (referee.mjs) remains the
authoritative re-executing source (source="referee") in the same ledger.

Security: tool output (error/stdout/stderr) is NEVER persisted. The command is stored only after
secret redaction, truncated to 300 chars. The ledger is not written when it sits in a git repo
without being gitignored. Fail-open: any error -> record nothing, never block.
"""
import json
import os
import pathlib
import re
import subprocess
import sys
import time

# A verify-shaped INVOCATION at the START of a shell segment (the executable position),
# optionally behind a runner prefix (npx/pnpm/yarn/bunx/python -m/poetry run). Anchoring at
# the start is the fix for the old bug where the runner word appearing inside a quoted BODY
# (e.g. `gh pr comment -b "...pytest..."`) was miscounted as a verification event.
_RUNNERS = (
    r"(?:pytest|vitest|jest|mocha|mutmut|stryker|cosmic-ray|tsc|eslint|jscpd|"
    r"node\s+--test|go\s+test|cargo\s+(?:test|build)|coverage|nyc|"
    r"npm\s+(?:run\s+)?(?:test|build|lint))"
)
_PREFIX = r"(?:(?:npx|pnpm|yarn|bunx|poetry\s+run|python3?\s+-m)\s+)?"
VERIFY_ANCHORED = re.compile(r"^\s*" + _PREFIX + _RUNNERS + r"\b", re.IGNORECASE)
_SEGMENT_SPLIT = re.compile(r"&&|\|\||[;\n|]")
_QUOTED = re.compile(r"'[^']*'|\"[^\"]*\"")


def is_verify_command(command: str) -> bool:
    """True iff a shell segment STARTS with a verify runner (not merely mentions one).

    Quoted substrings are removed first, so neither a runner word nor a shell metacharacter
    inside a quoted BODY (e.g. a PR-comment message: `gh pr comment -b "...; pytest all green"`)
    can create or start a command segment. This closes the 112-false-events class in the general
    case, not just the exact forms in the tests.
    """
    stripped = _QUOTED.sub(" ", command)
    for seg in _SEGMENT_SPLIT.split(stripped):
        if VERIFY_ANCHORED.match(seg.strip()):
            return True
    return False


_EXIT_CODE = re.compile(r"^Exit code (\d+)")
_SECRETS = [
    re.compile(r"AKIA[0-9A-Z]{16}"),
    re.compile(r"\bsk-[A-Za-z0-9_\-]{16,}"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}"),
    re.compile(r"\bxox[abprs]-[A-Za-z0-9\-]{6,}"),
    re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=\-]+"),
    re.compile(r"(?i)\b([A-Za-z0-9_\-]*(?:secret|token|password|passwd|api[_-]?key)[A-Za-z0-9_\-]*)(\s*[=:]\s*)(\"[^\"]*\"|'[^']*'|\S+)"),
]
_MAX_COMMAND = 300


def redact(command: str) -> str:
    """Mask common secret shapes, then truncate (redact first so a cut never splits a token)."""
    out = command
    for pat in _SECRETS[:-1]:
        out = pat.sub("[REDACTED]", out)
    out = _SECRETS[-1].sub(lambda m: f"{m.group(1)}{m.group(2)}[REDACTED]", out)
    return out[:_MAX_COMMAND]


def ledger_is_safe(cwd: str) -> bool:
    """False iff cwd is inside a git repo and the ledger path is NOT gitignored."""
    probe = subprocess.run(["git", "rev-parse", "--is-inside-work-tree"], cwd=cwd,
                           capture_output=True, text=True, timeout=5)
    if probe.returncode != 0:
        return True  # not a git repo: nothing to leak into a commit
    ignored = subprocess.run(["git", "check-ignore", "-q", ".quality-kernel/evidence-ledger.jsonl"],
                             cwd=cwd, capture_output=True, timeout=5)
    return ignored.returncode == 0


def main() -> None:
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    if data.get("tool_name") != "Bash":
        sys.exit(0)

    try:
        tool_input = data.get("tool_input") or {}
        command = str(tool_input.get("command", ""))
        if not is_verify_command(command):
            sys.exit(0)

        is_failure = data.get("hook_event_name") == "PostToolUseFailure" or "error" in data
        record_extra = {}
        interrupted = None
        stderr_nonempty = None
        if is_failure:
            error = data.get("error")
            match = _EXIT_CODE.match(error.split("\n", 1)[0]) if isinstance(error, str) else None
            exit_code = int(match.group(1)) if match else None
            is_interrupt = data.get("is_interrupt")
            record_extra["is_interrupt"] = is_interrupt if isinstance(is_interrupt, bool) else None
        else:
            exit_code = 0  # PostToolUse only fires on success
            response = data.get("tool_response")
            if isinstance(response, dict):
                if response.get("interrupted") is not None:
                    interrupted = bool(response.get("interrupted"))
                stderr = response.get("stderr")
                if isinstance(stderr, str):
                    stderr_nonempty = len(stderr.strip()) > 0
            record_extra["is_interrupt"] = None
        duration = data.get("duration_ms")
        agent_id = data.get("agent_id")

        cwd = data.get("cwd") or os.getcwd()
        if not ledger_is_safe(cwd):
            print("[quality-kernel] evidence-gate: .quality-kernel/ is not gitignored; ledger not written",
                  file=sys.stderr)
            sys.exit(0)
        ledger_dir = pathlib.Path(cwd) / ".quality-kernel"
        ledger_dir.mkdir(exist_ok=True)
        record = {
            "ts": round(time.time(), 3),
            "source": "bash-hook",
            "command": redact(command),
            "exit_code": exit_code,
            "duration_ms": duration if isinstance(duration, (int, float)) and not isinstance(duration, bool) else None,
            "interrupted": interrupted,
            "stderr_nonempty": stderr_nonempty,
            **record_extra,
        }
        if isinstance(agent_id, str) and agent_id:
            record["agent_id"] = agent_id
        with open(ledger_dir / "evidence-ledger.jsonl", "a", encoding="utf-8") as fh:
            fh.write(json.dumps(record) + "\n")
    except Exception as err:  # never block, but make breakage observable
        print(f"[quality-kernel] evidence-gate: recorder error (fail-open): {err}", file=sys.stderr)

    sys.exit(0)


if __name__ == "__main__":
    main()
