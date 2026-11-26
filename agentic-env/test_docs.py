#!/usr/bin/env python3
"""SETUP.md and GUIDE.md name things that exist in the repo.
Run: python3 -I agentic-env/test_docs.py"""
import json
import re
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
DOCS = [HERE / 'SETUP.md', HERE / 'GUIDE.md']
MANIFEST = json.loads((HERE / 'manifest.json').read_text())


def skill_names(folder):
    return {p.parent.name for p in folder.glob('*/SKILL.md')}


class DocsTest(unittest.TestCase):
    def test_every_repo_path_in_the_docs_exists(self):
        for doc in DOCS:
            for path in re.findall(r'`((?:agentic-env|plugins|scripts)/[\w./-]+)', doc.read_text()):
                self.assertTrue((REPO / path).exists(), f'{doc.name}: {path}')

    def test_every_dev_toolbox_skill_is_in_the_guide_and_nothing_else_is_named_as_one(self):
        guide = (HERE / 'GUIDE.md').read_text()
        named = set(re.findall(r'`([a-z][a-z0-9-]+)`', guide))
        toolbox = skill_names(REPO / 'plugins' / 'dev-toolbox' / 'skills')
        self.assertEqual(sorted(toolbox - named), [])

    def test_the_guide_lists_each_skill_under_the_way_it_is_invoked(self):
        guide = (HERE / 'GUIDE.md').read_text()
        auto = guide.split('## Skills that load by themselves')[1].split('## Skills you type')[0]
        typed = guide.split('## Skills you type')[1].split('## Guards')[0]
        for path in sorted((REPO / 'plugins' / 'dev-toolbox' / 'skills').glob('*/SKILL.md')):
            user_only = bool(re.search(r'^disable-model-invocation: true$', path.read_text().split('---\n')[1], re.M))
            section, other = (typed, auto) if user_only else (auto, typed)
            name = f'`{path.parent.name}`'
            self.assertTrue(name in section, f'{name} (user-only: {user_only}) is not in its section')
            self.assertFalse(name in other, f'{name} is in the wrong section')

    def test_every_manifest_plugin_and_wired_hook_is_explained(self):
        text = ''.join(d.read_text() for d in DOCS)
        for name in MANIFEST['plugins'] + [h['file'][:-3] for h in MANIFEST['hooks']]:
            self.assertTrue(f'`{name}`' in text, f'{name} is not explained')


if __name__ == '__main__':
    unittest.main()
