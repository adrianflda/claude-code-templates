#!/usr/bin/env python3
"""Quality-Kernel epistemic guard (G1).

PreToolUse hook on Task/Agent spawns. Ensures the epistemic-discipline marker is in the
subagent prompt so every spawned agent inherits OBSERVED/INFERRED labeling, probe-first
behavior, and residual-risk-first reporting.

Default ("inject"): when the marker/exempt tag is missing, return
hookSpecificOutput.updatedInput = the full original tool_input with the preamble prepended to
`prompt`. Live-probed on Claude Code 2.1.293: updatedInput applies WITHOUT a permissionDecision,
so this hook NEVER emits permissionDecision (no "allow"/"ask") and never alters permission flow.

Modes (env QK_EPISTEMIC_MODE):
  "log"   (default) - inject the preamble, do NOT block.
  "block"           - block the spawn with exit 2 (stderr message) until the marker is present.

Fail-open: any internal error -> allow (exit 0), no output.
"""
import json
import os
import sys

MARKER = "[EPISTEMIC-DISCIPLINE v1]"
EXEMPT = "[EPISTEMIC-EXEMPT"
PREAMBLE = (
    f"{MARKER} Label each claim OBSERVED or INFERRED; probe first when a live check costs "
    "<15 min; report residual risk first."
)


def main() -> None:
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)  # fail-open

    if data.get("tool_name") not in ("Task", "Agent"):
        sys.exit(0)

    tool_input = data.get("tool_input") or {}
    prompt = ""
    if isinstance(tool_input, dict):
        prompt = f"{tool_input.get('prompt', '')}{tool_input.get('description', '')}"

    if MARKER in prompt or EXEMPT in prompt:
        sys.exit(0)

    mode = os.environ.get("QK_EPISTEMIC_MODE", "log").lower()
    if mode == "block":
        print(
            "[quality-kernel] epistemic guard: this agent spawn is missing the "
            f"'{MARKER}' marker. Prepend the epistemic-discipline preamble to the "
            "subagent prompt, or add "
            f"'{EXEMPT}: <reason>]' for a trivial search/fetch spawn.",
            file=sys.stderr,
        )
        sys.exit(2)

    try:
        updated = dict(tool_input) if isinstance(tool_input, dict) else {}
        updated["prompt"] = f"{PREAMBLE}\n\n{updated.get('prompt', '')}"
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "updatedInput": updated}}))
    except Exception:
        pass  # fail-open
    sys.exit(0)


if __name__ == "__main__":
    main()
