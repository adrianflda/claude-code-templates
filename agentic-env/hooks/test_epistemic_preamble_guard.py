"""epistemic-preamble-guard: preamble required on every spawn; the fan-out limit counts this session's
optional spawns only.

2026-10-28 audit: 25 proportionality blocks in 30 days, mostly on mandated reviews (forge stages, critic,
breaker), and the counter was shared by every open session. Run: python3 -m unittest discover -s ~/.claude/hooks -p 'test_*.py'
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HOOK = Path(__file__).with_name('epistemic-preamble-guard.py')
OK = '[EPISTEMIC-DISCIPLINE v1] do the thing'


class Session:
    def __init__(self, log, sid):
        self.log, self.sid = log, sid

    def spawn(self, prompt=OK, kind='general-purpose'):
        r = subprocess.run([sys.executable, str(HOOK)], capture_output=True, text=True, timeout=10,
                           env={**os.environ, 'AGENT_SPAWN_LOG': self.log},
                           input=json.dumps({'session_id': self.sid, 'tool_name': 'Agent',
                                             'tool_input': {'prompt': prompt, 'subagent_type': kind}}))
        return r.returncode


class PreambleGuardTest(unittest.TestCase):
    def setUp(self):
        self.log = str(Path(tempfile.mkdtemp()) / 'spawns')

    def test_a_spawn_without_the_preamble_is_blocked(self):
        self.assertEqual(Session(self.log, 'a').spawn(prompt='just do it'), 2)
        self.assertEqual(Session(self.log, 'a').spawn(prompt='[EPISTEMIC-EXEMPT: pure search] find x'), 0)

    def test_six_optional_spawns_pass_and_the_seventh_needs_fanout_ok(self):
        s = Session(self.log, 'a')
        self.assertEqual([s.spawn() for _ in range(6)], [0] * 6)
        self.assertEqual(s.spawn(), 2)
        self.assertEqual(s.spawn(prompt=OK + ' [FANOUT-OK]'), 0)

    def test_another_sessions_spawns_do_not_count(self):
        other = Session(self.log, 'b')
        for _ in range(6):
            other.spawn()
        self.assertEqual(Session(self.log, 'a').spawn(), 0)

    def test_mandated_review_agents_never_count_or_block(self):
        s = Session(self.log, 'a')
        for _ in range(6):
            s.spawn()
        for kind in ('quality-kernel:coder', 'quality-kernel:hardener', 'adversarial-critic', 'qa-expert',
                     'pipeline-breaker'):
            with self.subTest(kind=kind):
                self.assertEqual(s.spawn(kind=kind), 0)
        fresh = Session(self.log, 'c')
        for _ in range(10):
            fresh.spawn(kind='quality-kernel:specifier')
        self.assertEqual(fresh.spawn(), 0, 'review spawns did not use up the optional budget')


if __name__ == '__main__':
    unittest.main()
