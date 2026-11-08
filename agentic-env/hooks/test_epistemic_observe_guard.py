"""epistemic-observe-guard: the OBSERVE-FIRST contract is injected once per session start, not on every prompt.

2026-10-28 audit: 2257 per-prompt injections in 30 days (~210k tokens). SessionStart also fires after every
compaction, so long sessions keep the rule. Run: python3 -I agentic-env/hooks/test_epistemic_observe_guard.py
"""
import json
import subprocess
import sys
import unittest
from pathlib import Path

HOOK = Path(__file__).with_name('epistemic-observe-guard.py')
# The wiring install.py writes (agentic-env/manifest.json), not this machine's settings.json.
MANIFEST = Path(__file__).resolve().parent.parent / 'manifest.json'


def wired(event):
    return [e for e in json.loads(MANIFEST.read_text())['hooks']
            if e['event'] == event and e['file'] == 'epistemic-observe-guard.py']


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
        self.assertEqual(wired('SessionStart'), [{'event': 'SessionStart', 'matcher': None,
                                                   'file': 'epistemic-observe-guard.py'}])
        self.assertEqual(wired('UserPromptSubmit'), [])


if __name__ == '__main__':
    unittest.main()
