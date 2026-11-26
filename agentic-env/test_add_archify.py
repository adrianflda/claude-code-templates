#!/usr/bin/env python3
"""extras/archify/add_archify.py against archives built here: no network.
Run: python3 -I agentic-env/test_add_archify.py"""
import io
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / 'extras' / 'archify' / 'add_archify.py'
COMMIT = next(l.split("'")[1] for l in SCRIPT.read_text().splitlines() if l.startswith('COMMIT = '))
TOP = f'archify-{COMMIT}'
SKILL = '---\nname: archify\ndescription: Diagrams.\n---\n\n# Archify\n'


def archive(path, files, links=()):
    with tarfile.open(path, 'w:gz') as tar:
        for name, text in files.items():
            info = tarfile.TarInfo(name)
            data = text.encode()
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
        for name, dest in links:
            info = tarfile.TarInfo(name)
            info.type, info.linkname = tarfile.SYMTYPE, dest
            tar.addfile(info)
    return path


class AddArchifyTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        self.project = self.root / 'project'
        self.project.mkdir()
        self.target = self.project / '.claude' / 'skills' / 'archify'
        self.good = archive(self.root / 'good.tgz', {
            f'{TOP}/README.md': 'top level, not copied',
            f'{TOP}/website/index.html': 'not copied',
            f'{TOP}/archify/SKILL.md': SKILL,
            f'{TOP}/archify/bin/archify.mjs': 'console.log(1)\n',
        })

    def tearDown(self):
        self.tmp.cleanup()

    def run_script(self, *args):
        return subprocess.run([sys.executable, '-I', str(SCRIPT), *args], capture_output=True, text=True, timeout=30)

    def test_only_the_skill_folder_is_copied_and_it_is_user_only(self):
        r = self.run_script(str(self.project), '--from', str(self.good))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(sorted(p.relative_to(self.target).as_posix() for p in self.target.rglob('*') if p.is_file()),
                         ['SKILL.md', 'VENDORED.txt', 'bin/archify.mjs'])
        self.assertEqual((self.target / 'SKILL.md').read_text(),
                         '---\nname: archify\ndescription: Diagrams.\ndisable-model-invocation: true\n---\n\n# Archify\n')
        self.assertIn(COMMIT, (self.target / 'VENDORED.txt').read_text())

    def test_an_existing_copy_is_kept_unless_replace_is_given(self):
        self.assertEqual(self.run_script(str(self.project), '--from', str(self.good)).returncode, 0)
        (self.target / 'mine.txt').write_text('local note')
        r = self.run_script(str(self.project), '--from', str(self.good))
        self.assertEqual(r.returncode, 1)
        self.assertIn('already exists', r.stderr)
        self.assertTrue((self.target / 'mine.txt').exists())
        self.assertEqual(self.run_script(str(self.project), '--from', str(self.good), '--replace').returncode, 0)
        self.assertFalse((self.target / 'mine.txt').exists())

    def test_an_archive_of_another_commit_is_refused(self):
        other = archive(self.root / 'other.tgz', {'archify-0000000/archify/SKILL.md': SKILL})
        r = self.run_script(str(self.project), '--from', str(other))
        self.assertEqual(r.returncode, 1)
        self.assertIn('not the pinned commit', r.stderr)
        self.assertFalse(self.target.exists())

    def test_links_and_paths_that_leave_the_folder_are_refused(self):
        for name, files, links in (
            ('link.tgz', {f'{TOP}/archify/SKILL.md': SKILL}, [(f'{TOP}/archify/evil', '/etc/passwd')]),
            ('dots.tgz', {f'{TOP}/archify/SKILL.md': SKILL, f'{TOP}/archify/../../../escaped.txt': 'x'}, []),
        ):
            r = self.run_script(str(self.project), '--from', str(archive(self.root / name, files, links)))
            self.assertEqual(r.returncode, 1, name)
            self.assertIn('refused archive entry', r.stderr)
            self.assertFalse(self.target.exists(), name)
        self.assertFalse((self.root / 'escaped.txt').exists())

    def test_a_skill_that_declares_hooks_is_refused(self):
        hooked = archive(self.root / 'hooks.tgz', {f'{TOP}/archify/SKILL.md': SKILL.replace('description: Diagrams.\n', 'description: Diagrams.\nhooks:\n  Stop: []\n')})
        r = self.run_script(str(self.project), '--from', str(hooked))
        self.assertEqual(r.returncode, 1)
        self.assertIn('declares hooks', r.stderr)
        self.assertFalse(self.target.exists())

    def test_a_missing_project_folder_is_an_error(self):
        r = self.run_script(str(self.root / 'nowhere'), '--from', str(self.good))
        self.assertEqual(r.returncode, 1)
        self.assertIn('is not a folder', r.stderr)


if __name__ == '__main__':
    unittest.main()
