#!/usr/bin/env python3
# SessionStart hook — injects the OBSERVE-FIRST epistemic contract into context, closing the gap where
# the MAIN agent's direct claims are ungated (epistemic-preamble-guard only gates subagent spawns).
# Added 2026-09-14 after the main agent speculated ("built-in [INFERRED]", wrong command counts)
# instead of probing. Moved from UserPromptSubmit to SessionStart on 2026-10-28: the per-prompt copy
# cost ~210k tokens in 30 days; SessionStart fires on startup, resume, clear and every compaction.
# Tests: test_epistemic_observe_guard.py
import json, sys
try:
    event = json.loads(sys.stdin.read() or '{}').get('hook_event_name') or 'SessionStart'
except Exception:
    event = 'SessionStart'
contract = (
    "[OBSERVE-FIRST — epistemic gate] Before asserting ANY system-state fact "
    "(counts, existence, source/origin, 'built-in', file paths, versions), the command "
    "that proves it MUST be in the SAME message. Inventories/audits = a script's quoted "
    "output, never memory or inference. '[INFERRED]' is NOT a license to speculate when "
    "you can observe — run the probe first, then assert."
)
print(json.dumps({"hookSpecificOutput": {"hookEventName": event, "additionalContext": contract}}))
