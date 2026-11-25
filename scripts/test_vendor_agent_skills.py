#!/usr/bin/env python3
"""vendor_agent_skills.py against a stand-in upstream tree (no network), plus the committed plugin.
Run: python3 -I scripts/test_vendor_agent_skills.py"""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name('vendor_agent_skills.py')
REPO = SCRIPT.parent.parent
FLAG = 'disable-model-invocation: true'


def skill_text(name):
    return f'---\nname: {name}\ndescription: Does {name}. Use when testing.\n---\n\n# {name}\n\nBody with --- inside.\n'


class VendorTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.source = root / 'upstream'
        self.plugin = root / 'plugins' / 'agent-skills'
        self.plugin.mkdir(parents=True)
        for name in ('debugging', 'spec-writing'):
            d = self.source / 'skills' / name
            (d / 'references').mkdir(parents=True)
            (d / 'SKILL.md').write_text(skill_text(name))
            (d / 'references' / 'notes.md').write_text('notes\n')
        (self.source / '.claude-plugin').mkdir()
        self.write_upstream_manifest({'name': 'agent-skills', 'version': '1.2.3', 'description': 'Skills.',
                                      'license': 'MIT', 'skills': './skills', 'commands': ['./commands']})
        (self.source / 'LICENSE').write_text('MIT License\n')
        (self.source / 'agents').mkdir()
        (self.source / 'agents' / 'reviewer.md').write_text('an agent\n')
        self.write_vendor(active=['debugging'], userOnly=['spec-writing'])

    def tearDown(self):
        self.tmp.cleanup()

    def write_upstream_manifest(self, manifest):
        (self.source / '.claude-plugin' / 'plugin.json').write_text(json.dumps(manifest))

    def write_vendor(self, **lists):
        (self.plugin / 'VENDOR.json').write_text(json.dumps(
            {'repo': 'someone/agent-skills', 'version': '1.2.3', 'commit': 'a' * 40, **lists}))

    def run_script(self, *args):
        return subprocess.run([sys.executable, '-I', str(SCRIPT), '--plugin-dir', str(self.plugin), *args],
                              capture_output=True, text=True, timeout=60)

    def vendor(self):
        return self.run_script('--source', str(self.source))

    def test_only_user_only_skills_get_the_flag_and_the_text_is_otherwise_verbatim(self):
        r = self.vendor()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual((self.plugin / 'skills' / 'debugging' / 'SKILL.md').read_text(), skill_text('debugging'))
        self.assertEqual((self.plugin / 'skills' / 'spec-writing' / 'SKILL.md').read_text(),
                         skill_text('spec-writing').replace('testing.\n---', f'testing.\n{FLAG}\n---', 1))
        self.assertEqual((self.plugin / 'skills' / 'debugging' / 'references' / 'notes.md').read_text(), 'notes\n')

    def test_only_skills_and_the_licence_are_taken(self):
        self.vendor()
        self.assertEqual(sorted(p.name for p in self.plugin.iterdir()),
                         ['.claude-plugin', 'LICENSE', 'VENDOR.json', 'VENDOR.sha256', 'skills'])
        manifest = json.loads((self.plugin / '.claude-plugin' / 'plugin.json').read_text())
        self.assertEqual((manifest['name'], manifest['version'], manifest['license']), ('agent-skills', '1.2.3', 'MIT'))
        self.assertNotIn('commands', manifest)
        self.assertIn('Vendored from someone/agent-skills 1.2.3', manifest['description'])

    def test_vendoring_twice_changes_nothing_and_check_is_clean(self):
        self.vendor()
        before = {p: p.read_bytes() for p in self.plugin.rglob('*') if p.is_file()}
        self.assertEqual(self.vendor().returncode, 0)
        self.assertEqual({p: p.read_bytes() for p in self.plugin.rglob('*') if p.is_file()}, before)
        r = self.run_script('--check')
        self.assertEqual((r.returncode, r.stdout.strip()), (0, 'OK: the vendored tree matches VENDOR.json'))

    def assert_refused(self, reason):
        r = self.vendor()
        self.assertEqual(r.returncode, 2)
        self.assertIn(reason, r.stderr)
        self.assertFalse((self.plugin / 'skills').exists(), 'a refusal must write nothing')

    def test_an_unclassified_upstream_skill_is_refused(self):
        self.write_vendor(active=['debugging'], userOnly=[])
        self.assert_refused('upstream skill not classified in VENDOR.json (active or userOnly): spec-writing')

    def test_a_classified_skill_upstream_no_longer_ships_is_refused(self):
        self.write_vendor(active=['debugging', 'gone'], userOnly=['spec-writing'])
        self.assert_refused('VENDOR.json names a skill upstream does not ship: gone')

    def test_wired_hooks_upstream_are_refused(self):
        (self.source / 'hooks').mkdir()
        (self.source / 'hooks' / 'hooks.json').write_text('{}')
        self.assert_refused('upstream now wires hooks')

    def test_another_upstream_version_is_refused(self):
        self.write_upstream_manifest({'name': 'agent-skills', 'version': '1.3.0'})
        self.assert_refused('upstream is version 1.3.0, VENDOR.json pins 1.2.3')

    def test_a_skill_that_declares_more_than_name_and_description_is_refused(self):
        skill = self.source / 'skills' / 'debugging' / 'SKILL.md'
        skill.write_text(skill_text('debugging').replace('testing.\n', 'testing.\nhooks:\n  PreToolUse: []\n', 1))
        self.assert_refused("frontmatter holds more than name and description ('hooks:')")

    def test_a_link_or_a_nested_skill_upstream_is_refused(self):
        (self.source / 'skills' / 'debugging' / 'passwd').symlink_to('/etc/passwd')
        self.assert_refused('upstream has a link under skills/: skills/debugging/passwd')
        (self.source / 'skills' / 'debugging' / 'passwd').unlink()
        nested = self.source / 'skills' / 'debugging' / 'inner'
        nested.mkdir()
        (nested / 'SKILL.md').write_text(skill_text('inner'))
        self.assert_refused('a SKILL.md that is not skills/<name>/SKILL.md: skills/debugging/inner/SKILL.md')

    def test_check_reports_vendored_text_edited_by_hand(self):
        self.vendor()
        body = self.plugin / 'skills' / 'debugging' / 'references' / 'notes.md'
        body.write_text('notes\nAlso run this.\n')
        r = self.run_script('--check')
        self.assertEqual(r.returncode, 1)
        self.assertIn('the vendored files do not match VENDOR.sha256', r.stdout)

    def test_a_flag_without_its_value_exits_2(self):
        r = self.run_script('--source')
        self.assertEqual(r.returncode, 2)
        self.assertIn('--source needs a value', r.stderr)

    def test_a_skill_listed_twice_is_refused(self):
        self.write_vendor(active=['debugging', 'spec-writing'], userOnly=['spec-writing'])
        self.assert_refused('both active and userOnly')

    def test_check_reports_a_flag_that_disagrees_with_the_lists(self):
        self.vendor()
        skill = self.plugin / 'skills' / 'spec-writing' / 'SKILL.md'
        skill.write_text(skill.read_text().replace(FLAG + '\n', ''))
        (self.plugin / 'agents').mkdir()
        r = self.run_script('--check')
        self.assertEqual(r.returncode, 1)
        self.assertIn(f'skills/spec-writing: lacks `{FLAG}` but VENDOR.json lists it as userOnly', r.stdout)
        self.assertIn('agents/ is present: only skills are vendored', r.stdout)

    def test_the_committed_plugin_matches_its_vendor_file_and_is_listed_in_the_marketplace(self):
        r = subprocess.run([sys.executable, '-I', str(SCRIPT), '--check'], capture_output=True, text=True, timeout=60)
        self.assertEqual((r.returncode, r.stdout.strip()), (0, 'OK: the vendored tree matches VENDOR.json'))
        vendor = json.loads((REPO / 'plugins' / 'agent-skills' / 'VENDOR.json').read_text())
        entry = next(p for p in json.loads((REPO / '.claude-plugin' / 'marketplace.json').read_text())['plugins']
                     if p['name'] == 'agent-skills')
        self.assertEqual((entry['source'], entry['version']), ('./plugins/agent-skills', vendor['version']))
        self.assertTrue((REPO / 'plugins' / 'agent-skills' / 'README.md').is_file())


if __name__ == '__main__':
    unittest.main()
