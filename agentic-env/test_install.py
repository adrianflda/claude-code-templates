#!/usr/bin/env python3
"""install.py against a throwaway HOME (no `claude`/git steps: --no-plugins). Run: python3 -I agentic-env/test_install.py"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

INSTALL = Path(__file__).with_name('install.py')
MANIFEST = json.loads(Path(__file__).with_name('manifest.json').read_text())
FOREIGN = {'type': 'command', 'command': 'python3 /opt/elsewhere/mine.py'}


def run(home, *args):
    env = {**os.environ, 'HOME': str(home)}
    return subprocess.run([sys.executable, '-I', str(INSTALL), '--no-plugins', *args],
                          capture_output=True, text=True, env=env, timeout=60)


class InstallTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        (self.home / '.claude').mkdir()
        self.settings = self.home / '.claude' / 'settings.json'
        self.settings.write_text(json.dumps({'theme': 'dark', 'hooks': {'PreToolUse': [
            {'matcher': 'Bash', 'hooks': [FOREIGN]}]}}))

    def tearDown(self):
        self.tmp.cleanup()

    def test_fresh_machine_is_drift(self):
        r = run(self.home, '--check')
        self.assertEqual(r.returncode, 1)
        self.assertIn('missing   ' + str(self.home / '.claude' / 'agents' / 'pipeline-breaker.md'), r.stdout)
        self.assertIn('unwired   SessionStart[*] python3 ' + str(self.home / '.claude' / 'hooks' / 'epistemic-observe-guard.py'), r.stdout)
        self.assertFalse((self.home / '.claude' / 'agents').exists(), '--check must not write')

    def test_install_then_check_is_clean_and_idempotent(self):
        self.assertEqual(run(self.home).returncode, 0)
        second = run(self.home)
        self.assertEqual(second.returncode, 0)
        self.assertIn('done: 0 file(s) updated', second.stdout)
        self.assertNotIn('wired', second.stdout)
        r = run(self.home, '--check')
        self.assertEqual((r.returncode, r.stdout.strip()), (0, 'OK: in sync with the repo'))

        d = json.loads(self.settings.read_text())
        self.assertEqual(d['theme'], 'dark')
        bash = [g for g in d['hooks']['PreToolUse'] if g.get('matcher') == 'Bash']
        self.assertEqual(len(bash), 1)
        cmds = [h['command'] for h in bash[0]['hooks']]
        hooks_dir = self.home / '.claude' / 'hooks'
        self.assertEqual(cmds, [FOREIGN['command']] + [f"python3 {hooks_dir / e['file']}" for e in MANIFEST['hooks']
                                                        if e['matcher'] == 'Bash'])
        self.assertEqual(len(d['hooks']['SessionStart']), 1)
        self.assertNotIn('matcher', d['hooks']['SessionStart'][0])
        self.assertEqual(len(list((self.home / '.claude').glob('settings.json.bak-*'))), 1)

    def test_a_changed_file_is_drift_and_install_restores_it(self):
        run(self.home)
        target = self.home / '.claude' / 'hooks' / 'secret-scanner.py'
        target.write_text(target.read_text() + '\n# local edit\n')
        r = run(self.home, '--check')
        self.assertEqual(r.returncode, 1)
        self.assertIn('differs   ' + str(target), r.stdout)
        self.assertEqual(run(self.home).returncode, 0)
        self.assertEqual(run(self.home, '--check').returncode, 0)

    def test_installed_hooks_run_from_their_new_home(self):
        run(self.home)
        hooks = self.home / '.claude' / 'hooks'
        block = subprocess.run([sys.executable, str(hooks / 'dangerous-command-blocker.py')], text=True,
                               input=json.dumps({'tool_name': 'Bash', 'tool_input': {'command': 'rm -rf /'}}),
                               capture_output=True)
        allow = subprocess.run([sys.executable, str(hooks / 'dangerous-command-blocker.py')], text=True,
                               input=json.dumps({'tool_name': 'Bash', 'tool_input': {'command': 'ls'}}),
                               capture_output=True)
        self.assertEqual((block.returncode, allow.returncode), (2, 0))


if __name__ == '__main__':
    unittest.main()
