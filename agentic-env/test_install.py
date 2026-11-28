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

    def agent_models(self):
        """-> {agent file name: [model lines in its frontmatter]} for every manifest agent."""
        out = {}
        for rel in MANIFEST['agents']:
            text = (self.home / '.claude' / 'agents' / Path(rel).name).read_text()
            out[Path(rel).name] = re.findall(r'^model:.*$', text[:text.index('\n---', 4)], re.M)
        return out

    def test_agent_model_pins_every_agent_and_is_remembered(self):
        r = run(self.home, '--agent-model', 'claude-opus-5-5')
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        agent = self.home / '.claude' / 'agents' / 'backend-developer.md'
        self.assertIn('pinned    model: claude-opus-5-5  in ' + str(agent), r.stdout)
        self.assertEqual(set(map(tuple, self.agent_models().values())), {('model: claude-opus-5-5',)})
        state = json.loads((self.home / '.claude' / 'agentic-env.json').read_text())
        self.assertEqual(state, {'agentModel': 'claude-opus-5-5'})
        # later runs without the option reuse the recorded pin: no drift, nothing rewritten
        r = run(self.home, '--check')
        self.assertEqual((r.returncode, r.stdout.strip()), (0, 'OK: in sync with the repo'))
        self.assertIn('done: 0 file(s) updated', run(self.home).stdout)
        # a body edit is still drift, and the reinstall restores the body with the pin
        agent.write_text(agent.read_text() + '\nlocal edit\n')
        self.assertIn('differs   ' + str(agent), run(self.home, '--check').stdout)
        self.assertEqual(run(self.home).returncode, 0)
        self.assertNotIn('local edit', agent.read_text())
        self.assertEqual(self.agent_models()['backend-developer.md'], ['model: claude-opus-5-5'])

    def test_without_a_pin_a_repo_model_change_is_drift_and_reaches_the_machine(self):
        run(self.home)
        agent = self.home / '.claude' / 'agents' / 'backend-developer.md'
        repo_line = self.agent_models()['backend-developer.md']
        self.assertEqual(repo_line, ['model: sonnet'], 'fixture: backend-developer ships model: sonnet')
        # what an older install looks like after the repo moved the model on
        agent.write_text(re.sub(r'(?m)^model:.*$', 'model: haiku', agent.read_text(), count=1))
        r = run(self.home, '--check')
        self.assertEqual(r.returncode, 1)
        self.assertIn('differs   ' + str(agent), r.stdout)
        self.assertEqual(run(self.home).returncode, 0)
        self.assertEqual(self.agent_models()['backend-developer.md'], repo_line)

    def test_an_explicit_agent_model_overrides_the_record_and_repo_clears_it(self):
        run(self.home, '--agent-model', 'claude-opus-5-5')
        agent = self.home / '.claude' / 'agents' / 'backend-developer.md'
        r = run(self.home, '--check', '--agent-model', 'haiku')
        self.assertEqual(r.returncode, 1, 'checked against the requested model, not the recorded one')
        self.assertIn('differs   ' + str(agent), r.stdout)
        self.assertEqual(json.loads((self.home / '.claude' / 'agentic-env.json').read_text()),
                         {'agentModel': 'claude-opus-5-5'}, '--check records nothing')
        r = run(self.home, '--agent-model', 'repo')
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(json.loads((self.home / '.claude' / 'agentic-env.json').read_text()), {})
        self.assertEqual(self.agent_models()['backend-developer.md'], ['model: sonnet'])
        self.assertEqual(self.agent_models()['researcher.md'], [], 'an agent that ships no model gets none')

    def test_a_bad_agent_model_is_refused_before_anything_is_written(self):
        run(self.home)
        agents = self.home / '.claude' / 'agents'
        before = {p.name: p.read_bytes() for p in agents.iterdir()}
        for bad in (['--agent-model'], ['--agent-model', 'opus\ntools: Bash'], ['--agent-model', '--check']):
            r = run(self.home, *bad)
            self.assertEqual(r.returncode, 2, bad)
            self.assertIn('--agent-model needs a model id or alias', r.stderr, bad)
        self.assertEqual({p.name: p.read_bytes() for p in agents.iterdir()}, before)
        self.assertFalse((self.home / '.claude' / 'agentic-env.json').exists())
        (self.home / '.claude' / 'agentic-env.json').write_text('{"agentModel": "opus\\nx"}')
        r = run(self.home, '--check')
        self.assertEqual(r.returncode, 2)
        self.assertIn('is not a model id or alias', r.stderr)

    def test_an_agent_without_frontmatter_cannot_be_pinned(self):
        src = self.home / 'plain.md'
        src.write_text('no frontmatter here\n')
        code = ('import sys; sys.path.insert(0, sys.argv[1]); import install; from pathlib import Path\n'
                'try:\n install.wanted(Path(sys.argv[2]), install.CLAUDE / "agents" / "plain.md", "opus")\n'
                'except ValueError as e:\n print(e); sys.exit(3)')
        env = {**os.environ, 'HOME': str(self.home)}
        r = subprocess.run([sys.executable, '-I', '-c', code, str(INSTALL.parent), str(src)],
                           capture_output=True, text=True, env=env)
        self.assertEqual(r.returncode, 3, r.stdout + r.stderr)
        self.assertIn('no frontmatter', r.stdout)


if __name__ == '__main__':
    unittest.main()
