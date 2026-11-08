"""spanish-gate: Spanish prose in an outgoing diff blocks the push; a lone accented name does not.

The allowed lines are the false positives the 2026-10-28 audit found (Adrián in authorship lines,
María/López test fixtures). Run: python3 -m unittest discover -s ~/.claude/hooks -p 'test_*.py'
"""
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HOOK = Path(__file__).with_name('spanish-gate.py')
spec = importlib.util.spec_from_file_location('spanish_gate', HOOK)
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)

SPANISH = [  # EXEMPT-ES: Spanish test data the gate must catch
    '# Guardar el archivo antes de salir',  # EXEMPT-ES: test data
    '// Esta función valida el correo del usuario',  # EXEMPT-ES: test data
    '¿Qué pasa aquí?',  # EXEMPT-ES: test data
    '| CRÍTICO | the token leaks |',  # EXEMPT-ES: test data
    'Revisión pendiente del usuario',  # EXEMPT-ES: test data
    'se ejecutó para todos los eventos',  # EXEMPT-ES: test data
]
ENGLISH = [
    'Author: Adrián Moreno',  # EXEMPT-ES: proper noun under test
    'const fixture = { first: "María", last: "López" }',  # EXEMPT-ES: proper nouns under test
    "expect(user.lastName).toBe('López')",  # EXEMPT-ES: proper noun under test
    "const city = 'San José'",  # EXEMPT-ES: proper noun under test
    'Fix the event handler for the user list',
    'Rent the La Jolla office de facto',
    'Reviewed with Adrián before the cutover',  # EXEMPT-ES: proper noun under test
]


class IsSpanishTest(unittest.TestCase):
    def test_spanish_prose_is_flagged(self):
        for line in SPANISH:
            with self.subTest(line=line):
                self.assertTrue(gate.is_spanish(line), line)

    def test_names_and_english_are_not(self):
        for line in ENGLISH:
            with self.subTest(line=line):
                self.assertIsNone(gate.is_spanish(line), line)


class PushTest(unittest.TestCase):
    def push(self, added):
        repo = Path(tempfile.mkdtemp())
        git = lambda *a: subprocess.run(['git', '-C', str(repo), *a], capture_output=True, text=True, check=True)  # noqa: E731
        git('init', '-q', '-b', 'main')
        git('config', 'user.email', 't@example.com')
        git('config', 'user.name', 't')
        (repo / 'a.md').write_text('start\n')
        git('add', '.')
        git('commit', '-qm', 'base')
        git('checkout', '-qb', 'feature')
        (repo / 'a.md').write_text('start\n' + added + '\n')
        git('commit', '-qam', 'change')
        r = subprocess.run([sys.executable, str(HOOK)], capture_output=True, text=True, timeout=30,
                           input=json.dumps({'tool_input': {'command': 'git push origin feature'}, 'cwd': str(repo)}))
        return r.returncode, r.stderr

    def test_a_push_adding_spanish_is_blocked(self):
        code, err = self.push(SPANISH[0])
        self.assertEqual(code, 2, err)
        self.assertIn('LANGUAGE GATE', err)

    def test_a_push_adding_a_spanish_name_passes(self):
        self.assertEqual(self.push(ENGLISH[0]), (0, ''))


if __name__ == '__main__':
    unittest.main()
