#!/usr/bin/env python3
"""install.py --check's plugin rules, against a stand-in `claude` (and `node`) on PATH and a throwaway HOME.
Run: python3 -I agentic-env/test_plugins.py"""
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
INSTALL = HERE / 'install.py'
MKT = 'adrianflda-claude-code-templates'
# The contract: every plugin the other machine must get from this repo's marketplace.
REQUIRED = ['quality-kernel', 'pre-push-review', 'usage-guard', 'pr-draft-guard', 'aws-admin-guard']

FAKE_CLAUDE = '''#!/usr/bin/env python3
import json, os, sys
a = sys.argv[1:]
if a[:3] == ['plugin', 'marketplace', 'list']:
    print(json.dumps([{'name': %r, 'path': os.environ['FAKE_REPO']}]))
elif a[:2] == ['plugin', 'list']:
    print(os.environ['FAKE_PLUGINS'])
elif a[:2] == ['plugin', 'marketplace'] or (a[:1] == ['plugin'] and a[1:2] in (['install'], ['update'], ['enable'], ['uninstall'])):
    with open(os.environ['FAKE_LOG'], 'a') as f:
        f.write(' '.join(a) + chr(10))
else:
    sys.exit(3)
''' % MKT


def ours(*names):
    return [{'id': f'{n}@{MKT}', 'enabled': True} for n in names]


class PluginCheckTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.home = root / 'home'
        (self.home / '.claude').mkdir(parents=True)
        self.bin = root / 'bin'
        self.bin.mkdir()
        for name, body in (('claude', FAKE_CLAUDE), ('node', '#!/bin/sh\nexit 0\n')):
            p = self.bin / name
            p.write_text(body)
            p.chmod(p.stat().st_mode | stat.S_IXUSR)

    def tearDown(self):
        self.tmp.cleanup()

    def run_installer(self, plugins, *args):
        self.log = self.bin.parent / 'claude-calls.log'
        env = {**os.environ, 'HOME': str(self.home), 'PATH': f'{self.bin}{os.pathsep}{os.environ["PATH"]}',
               'FAKE_REPO': str(REPO), 'FAKE_PLUGINS': json.dumps(plugins), 'FAKE_LOG': str(self.log)}
        r = subprocess.run([sys.executable, '-I', str(INSTALL), *args],
                           capture_output=True, text=True, env=env, timeout=60)
        self.assertNotIn('ERROR', r.stderr)
        return r

    def check(self, plugins):
        r = self.run_installer(plugins, '--check')
        return r, [l for l in r.stdout.splitlines() if l.startswith('plugin ')]

    def install(self, plugins):
        r = self.run_installer(plugins)
        calls = self.log.read_text().splitlines() if self.log.exists() else []
        return r, [c for c in calls if not c.startswith('plugin marketplace')]

    def test_manifest_requires_the_guards_and_the_marketplace_lists_every_one(self):
        manifest = json.loads((HERE / 'manifest.json').read_text())
        self.assertEqual(manifest['plugins'], REQUIRED)
        self.assertNotIn('optionalPlugins', manifest)
        listed = {p['name'] for p in json.loads((REPO / '.claude-plugin' / 'marketplace.json').read_text())['plugins']}
        self.assertEqual([n for n in REQUIRED if n not in listed], [])

    def test_every_plugin_from_this_marketplace_has_no_plugin_drift(self):
        _, lines = self.check(ours(*REQUIRED))
        self.assertEqual(lines, [])

    def test_a_guard_only_from_another_marketplace_is_drift(self):
        r, lines = self.check(ours(*REQUIRED[:3], 'aws-admin-guard') +
                              [{'id': 'pr-draft-guard@rule-guards-local', 'enabled': True}])
        self.assertEqual(r.returncode, 1)
        self.assertEqual(lines, [
            f'plugin    pr-draft-guard@{MKT} not installed/enabled',
            'plugin    pr-draft-guard@rule-guards-local also installed: '
            'claude plugin uninstall pr-draft-guard@rule-guards-local',
        ])

    def test_a_second_copy_from_another_marketplace_is_drift(self):
        r, lines = self.check(ours(*REQUIRED) + [{'id': 'aws-admin-guard@rule-guards-local', 'enabled': True}])
        self.assertEqual(r.returncode, 1)
        self.assertEqual(lines, ['plugin    aws-admin-guard@rule-guards-local also installed: '
                                 'claude plugin uninstall aws-admin-guard@rule-guards-local'])

    def test_our_copy_disabled_is_drift(self):
        r, lines = self.check(ours(*REQUIRED[:4]) + [{'id': f'aws-admin-guard@{MKT}', 'enabled': False}])
        self.assertEqual(r.returncode, 1)
        self.assertEqual(lines, [f'plugin    aws-admin-guard@{MKT} not installed/enabled'])

    def test_install_runs_install_update_and_enable_as_needed(self):
        _, calls = self.install(ours(*REQUIRED[:3]) + [{'id': f'pr-draft-guard@{MKT}', 'enabled': False}])
        self.assertEqual(calls, [f'plugin update {n}@{MKT}' for n in REQUIRED[:3]] + [
            f'plugin enable pr-draft-guard@{MKT}',
            f'plugin update pr-draft-guard@{MKT}',
            f'plugin install aws-admin-guard@{MKT}',
        ])

    def test_install_adds_ours_beside_a_foreign_copy_and_only_warns(self):
        r, calls = self.install(ours(*REQUIRED[:4]) + [{'id': 'aws-admin-guard@rule-guards-local', 'enabled': True}])
        self.assertEqual(calls[-1], f'plugin install aws-admin-guard@{MKT}')
        self.assertFalse([c for c in calls if 'uninstall' in c], 'the installer never deletes')
        self.assertIn('warning   aws-admin-guard@rule-guards-local is also enabled (its hooks run twice): '
                      'claude plugin uninstall aws-admin-guard@rule-guards-local', r.stdout)

    def test_a_disabled_second_copy_is_not_drift(self):
        _, lines = self.check(ours(*REQUIRED) + [{'id': 'aws-admin-guard@rule-guards-local', 'enabled': False}])
        self.assertEqual(lines, [])


if __name__ == '__main__':
    unittest.main()
