#!/usr/bin/env python3
"""Quality-Kernel evidence-gate - v1 (audit layer).

PostToolUse hook on Bash. Records that a test/build/verify-shaped command RAN, to a
per-project ledger (.quality-kernel/evidence-ledger.jsonl), as an audit/metrics trail.

IMPORTANT (verified by execution, see spec-m0-referee.v2.md): Claude Code's Bash
`tool_response` carries `stdout`, `stderr`, `interrupted`, `isImage`, `noOutputExpected`
-- it has NO exit-code field. The prior version guessed exit_code/exitCode/returncode/code
and recorded 112/112 "unknown-schema" because that field does not exist. So this hook no
longer pretends to capture an exit code. The AUTHORITATIVE exit-code truth comes from the
`referee` (referee.mjs), which RE-EXECUTES the verify command and appends its real exit
code to this same ledger (source="referee"). This hook only records the honest signals the
payload does expose (interrupted, whether stderr was non-empty), tagged source="bash-hook".

Fail-open: any error -> record nothing, never block.
"""
import json
import os
import pathlib
import re
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

        response = data.get("tool_response")
        interrupted = None
        stderr_nonempty = None
        if isinstance(response, dict):
            interrupted = bool(response.get("interrupted")) if response.get("interrupted") is not None else None
            stderr = response.get("stderr")
            if isinstance(stderr, str):
                stderr_nonempty = len(stderr.strip()) > 0

        cwd = data.get("cwd") or os.getcwd()
        ledger_dir = pathlib.Path(cwd) / ".quality-kernel"
        ledger_dir.mkdir(exist_ok=True)
        record = {
            "ts": round(time.time(), 3),
            "source": "bash-hook",
            "command": command[:300],
            "interrupted": interrupted,
            "stderr_nonempty": stderr_nonempty,
            # No exit code: Claude Code's Bash tool_response does not expose one. The referee
            # is the authoritative source of exit codes in this ledger (source="referee").
        }
        with open(ledger_dir / "evidence-ledger.jsonl", "a", encoding="utf-8") as fh:
            fh.write(json.dumps(record) + "\n")
    except Exception as err:  # never block, but make breakage observable
        print(f"[quality-kernel] evidence-gate: recorder error (fail-open): {err}", file=sys.stderr)

    sys.exit(0)


if __name__ == "__main__":
    main()
