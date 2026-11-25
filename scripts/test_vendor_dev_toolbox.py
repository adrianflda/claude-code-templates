#!/usr/bin/env python3
"""vendor_dev_toolbox.py against a throwaway checkout, and the committed tree against VENDOR.json.
Run: python3 -I scripts/test_vendor_dev_toolbox.py"""
import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SCRIPT = REPO / 'scripts' / 'vendor_dev_toolbox.py'
PLUGIN = REPO / 'plugins' / 'dev-toolbox'
SKILL = """---
name: demo
description: A demo skill.
---

# Demo

## Initial Response

Say hello first.

## Rules

- Keep this. See references/attribution.md
- Keep that.

### Detail

More.
"""


def git(cwd, *args):
    return subprocess.run(['git', '-C', str(cwd), '-c', 'user.name=t', '-c', 'user.email=t@example.com', *args],
                          check=True, capture_output=True, text=True).stdout.strip()


class VendorScriptTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.src, self.plugin = root / 'src', root / 'plugin'
        self.checkout = self.src / 'demo-source' / 'repo'
        (self.checkout / 'skills' / 'demo' / 'references').mkdir(parents=True)
        (self.checkout / 'skills' / 'demo' / 'SKILL.md').write_text(SKILL)
        (self.checkout / 'skills' / 'demo' / 'references' / 'attribution.md').write_text('tag every command\n')
        (self.checkout / 'skills' / 'demo' / 'references' / 'usage.md').write_text('usage\n')
        (self.checkout / 'LICENSE').write_text('MIT License\n')
        git(self.checkout, 'init', '-q')
        git(self.checkout, 'add', '-A')
        git(self.checkout, 'commit', '-q', '-m', 'init')
        self.plugin.mkdir()
        self.spec = {'from': 'skills/demo', 'name': 'demo', 'userOnly': True, 'dropSections': ['Initial Response'],
                     'dropFiles': ['references/attribution.md'], 'dropLines': ['attribution\\.md'],
                     'replace': [['- Keep that.', '- Keep that, always.']]}
        self.write(git(self.checkout, 'rev-parse', 'HEAD'))

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, commit):
        (self.plugin / 'VENDOR.json').write_text(json.dumps({'sources': [{
            'id': 'demo-source', 'repo': 'x/y', 'commit': commit, 'license': 'MIT', 'licenseFile': 'LICENSE',
            'skills': [self.spec]}]}))

    def run_script(self, *args):
        return subprocess.run([sys.executable, '-I', str(SCRIPT), '--src', str(self.src), '--plugin', str(self.plugin), *args],
                              capture_output=True, text=True)

    def test_the_declared_edits_are_applied_and_nothing_else_changes(self):
        r = self.run_script()
        self.assertEqual(r.returncode, 0, r.stderr)
        text = (self.plugin / 'skills' / 'demo' / 'SKILL.md').read_text()
        self.assertEqual(text, """---
name: demo
description: A demo skill.
disable-model-invocation: true
---

# Demo

## Rules

- Keep that, always.

### Detail

More.
""")
        self.assertFalse((self.plugin / 'skills' / 'demo' / 'references' / 'attribution.md').exists())
        self.assertEqual((self.plugin / 'skills' / 'demo' / 'references' / 'usage.md').read_text(), 'usage\n')
        self.assertEqual((self.plugin / 'licenses' / 'demo-source.txt').read_text(), 'MIT License\n')

    def test_check_passes_on_a_fresh_copy_and_fails_after_a_hand_edit(self):
        self.assertEqual(self.run_script().returncode, 0)
        self.assertEqual(self.run_script('--check').returncode, 0)
        with open(self.plugin / 'skills' / 'demo' / 'SKILL.md', 'a') as f:
            f.write('edited by hand\n')
        r = self.run_script('--check')
        self.assertEqual(r.returncode, 1)
        self.assertIn('differs:', r.stdout)

    def test_a_checkout_at_another_commit_is_refused(self):
        self.write('0' * 40)
        r = self.run_script()
        self.assertEqual(r.returncode, 2)
        self.assertIn('VENDOR.json pins 000000000000', r.stderr)
        self.assertFalse((self.plugin / 'skills').exists())

    def test_an_edit_that_no_longer_matches_upstream_is_an_error(self):
        for key, value, message in (('dropSections', ['Gone'], "no section named ['Gone']"),
                                    ('replace', [['absent text', 'x']], 'text to replace not found'),
                                    ('dropFiles', ['references/none.md'], 'dropFiles not in the source')):
            saved = self.spec[key]
            self.spec[key] = value
            self.write(git(self.checkout, 'rev-parse', 'HEAD'))
            r = self.run_script()
            self.assertEqual(r.returncode, 2, key)
            self.assertIn(message, r.stderr)
            self.spec[key] = saved

    def test_a_skill_that_declares_hooks_is_refused(self):
        path = self.checkout / 'skills' / 'demo' / 'SKILL.md'
        path.write_text(SKILL.replace('description: A demo skill.\n', 'description: A demo skill.\nhooks:\n  Stop: []\n'))
        git(self.checkout, 'commit', '-q', '-am', 'hooks')
        self.write(git(self.checkout, 'rev-parse', 'HEAD'))
        r = self.run_script()
        self.assertEqual(r.returncode, 2)
        self.assertIn('declares hooks', r.stderr)


class CommittedTreeTest(unittest.TestCase):
    """What can be checked without the upstream checkouts."""

    def setUp(self):
        self.vendor = json.loads((PLUGIN / 'VENDOR.json').read_text())
        self.specs = {k['name']: (s, k) for s in self.vendor['sources'] for k in s['skills']}

    def frontmatter(self, name):
        return (PLUGIN / 'skills' / name / 'SKILL.md').read_text().split('---\n')[1]

    def test_every_vendored_skill_is_in_the_tree_with_its_invocation_mode(self):
        for name, (_, spec) in self.specs.items():
            manual = bool(re.search(r'^disable-model-invocation: true$', self.frontmatter(name), re.M))
            self.assertEqual(manual, bool(spec.get('userOnly')), name)

    def test_every_source_pins_a_full_commit_and_ships_its_license(self):
        for source in self.vendor['sources']:
            self.assertRegex(source['commit'], r'^[0-9a-f]{40}$', source['id'])
            self.assertTrue((PLUGIN / 'licenses' / f"{source['id']}.txt").stat().st_size > 0, source['id'])

    def test_no_skill_of_the_plugin_declares_hooks(self):
        for path in sorted((PLUGIN / 'skills').glob('*/SKILL.md')):
            self.assertNotRegex(path.read_text().split('---\n')[1], r'(?m)^hooks\s*:', path.parent.name)

    def test_the_trimmed_instructions_are_gone(self):
        text = ''.join(p.read_text() for name in self.specs for p in (PLUGIN / 'skills' / name).rglob('*.md'))
        for gone in ('CLOUDSDK_METRICS_REQUEST_ATTRIBUTION', '## Initial Response', 'npm install -g @playwright/cli@latest',
                     'install.sh | sh'):
            self.assertNotIn(gone, text)


if __name__ == '__main__':
    unittest.main()
