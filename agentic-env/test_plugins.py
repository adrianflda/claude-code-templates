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

    def check(self, plugins):
        env = {**os.environ, 'HOME': str(self.home), 'PATH': f'{self.bin}{os.pathsep}{os.environ["PATH"]}',
               'FAKE_REPO': str(REPO), 'FAKE_PLUGINS': json.dumps(plugins)}
        r = subprocess.run([sys.executable, '-I', str(INSTALL), '--check'],
                           capture_output=True, text=True, env=env, timeout=60)
        self.assertNotIn('ERROR', r.stderr)
        return r, [l for l in r.stdout.splitlines() if l.startswith('plugin ')]

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

    def test_a_disabled_second_copy_is_not_drift(self):
        _, lines = self.check(ours(*REQUIRED) + [{'id': 'aws-admin-guard@rule-guards-local', 'enabled': False}])
        self.assertEqual(lines, [])


if __name__ == '__main__':
    unittest.main()
