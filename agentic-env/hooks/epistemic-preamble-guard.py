#!/usr/bin/env python3
"""PreToolUse guard for subagent spawns (Task/Agent tool). Two gates:

  1. EPISTEMIC PREAMBLE — the prompt must carry [EPISTEMIC-DISCIPLINE v1] or an
     [EPISTEMIC-EXEMPT: <reason>] tag.
  2. PROPORTIONALITY — caps the fan-out RATE of optional spawns. More than THRESHOLD of THIS session's
     spawns inside a rolling WINDOW_SEC window is blocked unless the prompt carries [FANOUT-OK]
     (which is only added after estimating the token cost and getting the user's explicit OK).
     Prevents silent oversized fan-outs — the root cause of the 2026-08-11 lingering-agent /
     wasted-token incident.

2026-10-28 audit (25 blocks in 30 days, mostly on mandated reviews): the counter is now per session
(it was shared by every open session), the mandated review agents (forge stages, critic, QA, breaker)
neither count nor block, and the limit is 6. Gate 1 is unchanged.

Fail-open on any hook error — the gate must never brick agent work. Tests: test_epistemic_preamble_guard.py
"""
import sys
import json
import os
import time

WINDOW_SEC = 600  # rolling window for the fan-out counter (10 min)
THRESHOLD = 6     # optional spawns allowed per session per window without an explicit [FANOUT-OK]
LOG = os.environ.get('AGENT_SPAWN_LOG') or os.path.expanduser('~/.claude/.agent-spawn-log')  # "epoch session"
MANDATED = ('quality-kernel:', 'adversarial-critic', 'qa-expert', 'pipeline-breaker')


def read_log(now):
    """(timestamp, session) entries still inside the rolling window. Old one-column lines count as no session."""
    kept = []
    try:
        with open(LOG) as f:
            for line in f:
                parts = line.split()
                try:
                    t = float(parts[0])
                except (ValueError, IndexError):
                    continue
                if now - t <= WINDOW_SEC:
                    kept.append((t, parts[1] if len(parts) > 1 else ''))
    except FileNotFoundError:
        pass
    return kept


def persist(entries):
    try:
        with open(LOG, 'w') as f:
            f.write(''.join(f'{t:.0f} {s}\n' for t, s in entries))
    except Exception:
        pass


try:
    data = json.load(sys.stdin)
    tool_input = data.get('tool_input', {}) or {}
    prompt = str(tool_input.get('prompt', ''))
    kind = str(tool_input.get('subagent_type', '') or '')
    session = str(data.get('session_id', '') or '-')

    # Gate 1 — epistemic preamble.
    if not ('[EPISTEMIC-DISCIPLINE' in prompt or '[EPISTEMIC-EXEMPT:' in prompt):
        sys.stderr.write(
            'BLOCKED by epistemic-preamble-guard: subagent prompt lacks the '
            '[EPISTEMIC-DISCIPLINE v1] preamble. Prepend the block from '
            '~/.claude/skills/epistemic-discipline/discipline-preamble.md, or tag '
            'the spawn [EPISTEMIC-EXEMPT: <reason>] if it is a trivial mechanical '
            'agent (pure search/fetch, no claims).'
        )
        sys.exit(2)

    # Gate 2 — proportionality / fan-out rate, optional spawns only.
    if kind.startswith(MANDATED):
        sys.exit(0)
    now = time.time()
    entries = read_log(now)
    mine = [t for t, s in entries if s == session]
    if len(mine) + 1 > THRESHOLD and '[FANOUT-OK]' not in prompt:
        mins = WINDOW_SEC // 60
        sys.stderr.write(
            f'BLOCKED by proportionality guard: this would be optional spawn #{len(mine) + 1} '
            f'of this session in the last {mins} min (soft limit {THRESHOLD}; mandated reviews do not '
            f'count). Before fanning out further: (1) estimate the token cost, (2) right-size to the '
            f'task, (3) get the user\'s explicit OK, then (4) add [FANOUT-OK] to the spawn prompt. A '
            f'completed agent left running re-spends tokens on every resume — do not over-spawn.'
        )
        sys.exit(2)

    # Allowed — record this spawn.
    persist(entries + [(now, session)])
    sys.exit(0)
except SystemExit:
    raise
except Exception:
    sys.exit(0)  # fail-open
