#!/usr/bin/env python3
"""secret-scanner.py end to end: a throwaway git repository, a staged file, the hook's exit code.
Run: python3 -I agentic-env/hooks/test_secret_scanner.py

Every token below is assembled at run time, so this file holds no string a scanner would flag.
"""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HOOK = Path(__file__).with_name('secret-scanner.py')
COMMIT = 'git ' + 'commit -m "feat: x"'
GITHUB = 'gh' + 'p_' + 'a1B2c3D4e5' * 3 + 'f6G7h8'          # 36 characters after the prefix
STRIPE = 'sk_' + 'live_' + 'Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2'
SHA256 = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'
UUID = '123e4567-e89b-12d3-a456-426614174000'


class SecretScannerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        subprocess.run(['git', 'init', '-q', str(self.repo)], check=True)

    def tearDown(self):
        self.tmp.cleanup()

    def scan(self, files, command=COMMIT, stage=True):
        for name, text in files.items():
            path = self.repo / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
            if stage:
                subprocess.run(['git', '-C', str(self.repo), 'add', name], check=True)
        return subprocess.run([sys.executable, str(HOOK)], cwd=self.repo, text=True, capture_output=True,
                              input=json.dumps({'tool_name': 'Bash', 'tool_input': {'command': command}}))

    def test_a_staged_token_blocks_the_commit_and_is_never_printed(self):
        r = self.scan({'src/config.py': f'TOKEN = "{GITHUB}"\n'})
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertIn('GitHub Personal Access Token', r.stderr)
        self.assertIn('src/config.py:1', r.stderr)
        self.assertNotIn(GITHUB, r.stderr + r.stdout)
        self.assertNotIn(GITHUB[:12], r.stderr + r.stdout)

    def test_a_clean_file_and_other_commands_pass(self):
        self.assertEqual(self.scan({'a.py': 'x = 1\n'}).returncode, 0)
        self.assertEqual(self.scan({'b.py': f'T = "{GITHUB}"\n'}, command='git status').returncode, 0)

    def test_the_word_example_on_a_code_line_does_not_excuse_a_real_token(self):
        for line in (f'url = "https://api.example.com/?k={STRIPE}"\n',
                     f'key = "{STRIPE}"  # example config\n',
                     f'EXAMPLE_TOKEN = "{GITHUB}"\n'):
            r = self.scan({'cfg.py': line})
            self.assertEqual(r.returncode, 2, line)

    def test_a_placeholder_in_the_token_or_a_comment_only_line_is_allowed(self):
        fake = 'gh' + 'p_' + 'EXAMPLE' + 'x' * 29
        self.assertEqual(self.scan({'doc.py': f'TOKEN = "{fake}"\n'}).returncode, 0)
        self.assertEqual(self.scan({'doc2.py': f'# example: TOKEN = "{GITHUB}"\n'}).returncode, 0)

    def test_hex_digests_are_not_cloudflare_tokens(self):
        r = self.scan({'lock.txt': f'cf{SHA256}\nsha256: {SHA256}\npdf_{SHA256}\n'})
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_a_low_severity_hit_alone_does_not_block(self):
        self.assertEqual(self.scan({'ids.json': f'{{"id": "{UUID}"}}\n'}).returncode, 0)
        r = self.scan({'both.py': f'ID = "{UUID}"\nT = "{GITHUB}"\n'})
        self.assertEqual(r.returncode, 2)
        self.assertNotIn('UUID', r.stderr, 'only what blocks is listed')

    def test_a_path_in_the_ignore_file_is_skipped_and_a_test_file_is_scanned(self):
        (self.repo / '.secret-scanner-ignore').write_text('# fixtures\nfixtures/*\n')
        self.assertEqual(self.scan({'fixtures/keys.txt': GITHUB + '\n'}).returncode, 0)
        self.assertEqual(self.scan({'src/app.test.js': f'const t = "{GITHUB}";\n'}).returncode, 2)

    def test_files_named_by_a_chained_git_add_are_scanned_before_they_are_staged(self):
        r = self.scan({'late.py': f'T = "{GITHUB}"\n'}, command='git add late.py && ' + COMMIT, stage=False)
        self.assertEqual(r.returncode, 2, r.stderr)


if __name__ == '__main__':
    unittest.main()
