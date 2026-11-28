#!/usr/bin/env python3
"""install.py against a throwaway HOME (no `claude`/git steps: --no-plugins; no uv: --no-tools). Run: python3 -I agentic-env/test_install.py"""
import json
import os
import re
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
    return subprocess.run([sys.executable, '-I', str(INSTALL), '--no-plugins', '--no-tools', *args],
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

    def test_a_hook_wired_with_HOME_in_its_path_counts_as_wired(self):
        self.assertEqual(run(self.home).returncode, 0)
        d = json.loads(self.settings.read_text())
        wired = json.dumps(d)
        for spelling in ('$HOME', '${HOME}', '~'):
            self.settings.write_text(wired.replace(str(self.home), spelling))
            r = run(self.home, '--check')
            self.assertEqual((r.returncode, r.stdout.strip()), (0, 'OK: in sync with the repo'), spelling)

    def test_a_hook_wired_from_another_folder_is_still_missing(self):
        self.assertEqual(run(self.home).returncode, 0)
        elsewhere = self.settings.read_text().replace(str(self.home / '.claude' / 'hooks'), '/opt/elsewhere~/hooks')
        self.settings.write_text(elsewhere)
        r = run(self.home, '--check')
        self.assertEqual(r.returncode, 1)
        self.assertIn('unwired   PreToolUse[Bash]', r.stdout)

    def test_only_the_hooks_the_manifest_names_are_copied(self):
        self.assertEqual(run(self.home).returncode, 0)
        copied = sorted(p.name for p in (self.home / '.claude' / 'hooks').iterdir())
        self.assertEqual(copied, sorted([e['file'] for e in MANIFEST['hooks']] + MANIFEST['hookSupport']))
        self.assertFalse([n for n in copied if n.startswith('test_')], 'tests stay in the repo')

    def test_a_changed_file_is_drift_and_install_restores_it(self):
        run(self.home)
        target = self.home / '.claude' / 'hooks' / 'secret-scanner.py'
        target.write_text(target.read_text() + '\n# local edit\n')
        r = run(self.home, '--check')
        self.assertEqual(r.returncode, 1)
        self.assertIn('differs   ' + str(target), r.stdout)
        self.assertEqual(run(self.home).returncode, 0)
        self.assertEqual(run(self.home, '--check').returncode, 0)

    def test_the_skills_of_this_folder_ship_with_their_scripts_still_executable(self):
        run(self.home)
        skills = self.home / '.claude' / 'skills'
        self.assertTrue((skills / 'code-graph' / 'SKILL.md').is_file())
        lookup = skills / 'library-docs' / 'scripts' / 'lookup.py'
        self.assertTrue(os.access(lookup, os.X_OK))
        usage = subprocess.run([sys.executable, '-I', str(lookup)], capture_output=True, text=True)
        self.assertEqual(usage.returncode, 2)
        self.assertIn('lookup.py search <library>', usage.stderr)

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

    def test_help_prints_usage_and_an_unknown_option_installs_nothing(self):
        for flag in ('--help', '-h'):
            r = run(self.home, flag)
            self.assertEqual(r.returncode, 0, flag)
            self.assertIn('--agent-model', r.stdout, flag)
        r = run(self.home, '--bogus')
        self.assertEqual(r.returncode, 2)
        self.assertIn('unknown option: --bogus', r.stderr)
        self.assertFalse((self.home / '.claude' / 'agents').exists(), 'neither --help nor a typo may install')

    def test_an_agent_keeps_the_model_it_was_pinned_to(self):
        run(self.home)
        agent = self.home / '.claude' / 'agents' / 'backend-developer.md'
        unpinned = self.home / '.claude' / 'agents' / 'researcher.md'
        pin = 'model: claude-opus-5-5  # local pin'
        # pinned the way a person does it: edit the model line in place (sed), or add one if absent
        text = agent.read_text()
        self.assertRegex(text, r'(?m)^model: sonnet$', 'fixture: backend-developer ships a model line')
        agent.write_text(re.sub(r'(?m)^model:.*$', pin, text, count=1))
        text = unpinned.read_text()
        self.assertNotRegex(text, r'(?m)^model:', 'fixture: researcher ships no model line')
        end = text.index('\n---', 4)
        unpinned.write_text(text[:end] + '\n' + pin + text[end:])
        r = run(self.home, '--check')
        self.assertEqual((r.returncode, r.stdout.strip()), (0, 'OK: in sync with the repo'), 'a pin alone is not drift')
        agent.write_text(agent.read_text() + '\nlocal edit\n')
        r = run(self.home, '--check')
        self.assertIn('differs   ' + str(agent), r.stdout)
        r = run(self.home)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn('kept      model: claude-opus-5-5  # local pin  in ' + str(agent), r.stdout)
        text = agent.read_text()
        self.assertNotIn('local edit', text, 'the body comes from the repo')
        self.assertEqual(re.findall(r'^model:.*$', text, re.M), ['model: claude-opus-5-5  # local pin'])
        self.assertIn('model: claude-opus-5-5  # local pin', unpinned.read_text())

    def test_agent_model_pins_every_agent_and_rejects_a_bad_value(self):
        r = run(self.home, '--agent-model', 'claude-opus-5-5')
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        agents = self.home / '.claude' / 'agents'
        for rel in MANIFEST['agents']:
            text = (agents / Path(rel).name).read_text()
            head = text[:text.index('\n---', 4)]
            self.assertEqual(re.findall(r'^model:.*$', head, re.M), ['model: claude-opus-5-5'], rel)
        self.assertEqual(run(self.home, '--check').returncode, 0, 'the pin survives a plain check')
        for bad in (['--agent-model'], ['--agent-model', 'opus\ntools: Bash'], ['--agent-model', '--check']):
            r = run(self.home, *bad)
            self.assertEqual(r.returncode, 2, bad)


if __name__ == '__main__':
    unittest.main()
