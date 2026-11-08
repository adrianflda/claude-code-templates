"""epistemic-observe-guard: the OBSERVE-FIRST contract is injected once per session start, not on every prompt.

2026-10-28 audit: 2257 per-prompt injections in 30 days (~210k tokens). SessionStart also fires after every
compaction, so long sessions keep the rule. Run: python3 -m unittest discover -s ~/.claude/hooks -p 'test_*.py'
"""
import json
import subprocess
import sys
import unittest
from pathlib import Path

HOOK = Path(__file__).with_name('epistemic-observe-guard.py')
SETTINGS = Path.home() / '.claude' / 'settings.json'


def commands(event):
    hooks = json.loads(SETTINGS.read_text()).get('hooks', {})
    return [h['command'] for entry in hooks.get(event, []) for h in entry.get('hooks', [])]


class ObserveGuardTest(unittest.TestCase):
    def test_it_answers_as_the_event_that_called_it(self):
        for source in ('startup', 'compact', 'resume'):
            with self.subTest(source=source):
                r = subprocess.run([sys.executable, str(HOOK)], capture_output=True, text=True, timeout=10,
                                   input=json.dumps({'hook_event_name': 'SessionStart', 'source': source}))
                out = json.loads(r.stdout)['hookSpecificOutput']
                self.assertEqual(out['hookEventName'], 'SessionStart')
                self.assertIn('OBSERVE-FIRST', out['additionalContext'])

    def test_it_is_wired_at_session_start_and_not_per_prompt(self):
        self.assertTrue(any('epistemic-observe-guard.py' in c for c in commands('SessionStart')))
        self.assertFalse(any('epistemic-observe-guard.py' in c for c in commands('UserPromptSubmit')))


if __name__ == '__main__':
    unittest.main()
