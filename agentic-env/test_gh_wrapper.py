#!/usr/bin/env python3
"""extras/gh-wrapper/gh against a stand-in gh-real, in a throwaway HOME.
Run: python3 -I agentic-env/test_gh_wrapper.py"""
import os
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

WRAPPER = Path(__file__).resolve().parent / 'extras' / 'gh-wrapper' / 'gh'
# Prints what the wrapper handed over: the token it would use and the arguments.
# Like gh, `auth token` without --user answers with the active account's token.
FAKE_GH = '''#!/bin/sh
if [ "$1" = auth ] && [ "$2" = token ]; then
  [ "$3" = --user ] || { echo tok-active; exit 0; }
  case " $FAKE_LOGGED_IN " in *" $4 "*) echo "tok-$4"; exit 0 ;; esac
  exit 1
fi
echo "token=${GH_TOKEN:-none} args=$*"
'''


class GhWrapperTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name).resolve()
        self.home = root / 'home'
        self.client, self.other = root / 'Client', root / 'other'
        for d in (self.home / 'bin', self.home / '.config', self.client / 'app' / 'src', self.other):
            d.mkdir(parents=True)
        fake = self.home / 'bin' / 'gh-real'
        fake.write_text(FAKE_GH)
        fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
        self.conf = self.home / '.config' / 'gh-wrapper.conf'
        self.rules(f'# accounts by folder\ndefault me\ndir work {self.client}\n')

    def tearDown(self):
        self.tmp.cleanup()

    def rules(self, text):
        self.conf.write_text(text)

    def gh(self, *args, cwd=None, logged_in='me work', **env):
        base = {'HOME': str(self.home), 'PATH': '/usr/bin:/bin', 'FAKE_LOGGED_IN': logged_in}
        r = subprocess.run(['/bin/sh', str(WRAPPER), *args], cwd=cwd or self.other, env={**base, **env},
                           capture_output=True, text=True, timeout=20)
        return r.stdout.strip(), r.stderr.strip()

    def test_inside_a_listed_folder_its_account_is_used(self):
        for cwd in (self.client, self.client / 'app' / 'src'):
            out, _ = self.gh('pr', 'list', cwd=cwd)
            self.assertEqual(out, 'token=tok-work args=pr list', cwd)

    def test_everywhere_else_the_default_account_is_used(self):
        out, _ = self.gh('pr', 'list', '--repo', 'me/app')
        self.assertEqual(out, 'token=tok-me args=pr list --repo me/app')

    def test_a_sibling_folder_with_the_same_prefix_is_not_the_listed_folder(self):
        sibling = Path(str(self.client) + '-old')
        sibling.mkdir()
        out, _ = self.gh('pr', 'list', cwd=sibling)
        self.assertEqual(out, 'token=tok-me args=pr list')

    def test_the_first_matching_folder_wins_and_a_trailing_slash_is_accepted(self):
        self.rules(f'default me\ndir inner {self.client}/app/\ndir work {self.client}\n')
        out, _ = self.gh('pr', 'list', cwd=self.client / 'app' / 'src', logged_in='me work inner')
        self.assertEqual(out, 'token=tok-inner args=pr list')
        out, _ = self.gh('pr', 'list', cwd=self.client, logged_in='me work inner')
        self.assertEqual(out, 'token=tok-work args=pr list')

    def test_a_folder_with_a_space_and_a_last_line_without_a_newline_are_read(self):
        spaced = self.other / 'two words'
        spaced.mkdir()
        self.rules(f'default me\ndir work {spaced}')
        out, _ = self.gh('pr', 'list', cwd=spaced)
        self.assertEqual(out, 'token=tok-work args=pr list')

    def test_without_rules_it_is_plain_gh(self):
        self.conf.unlink()
        out, _ = self.gh('pr', 'list', cwd=self.client)
        self.assertEqual(out, 'token=none args=pr list')
        self.rules(f'dir work {self.client}\n')
        out, _ = self.gh('pr', 'list')
        self.assertEqual(out, 'token=none args=pr list')

    def test_an_explicit_token_and_auth_commands_are_the_callers_decision(self):
        out, _ = self.gh('pr', 'list', GH_TOKEN='tok-explicit')
        self.assertEqual(out, 'token=tok-explicit args=pr list')
        out, _ = self.gh('pr', 'list', GITHUB_TOKEN='x')
        self.assertEqual(out, 'token=none args=pr list')
        out, _ = self.gh('auth', 'status', cwd=self.client)
        self.assertEqual(out, 'token=none args=auth status')

    def test_an_account_that_is_not_logged_in_warns_and_uses_the_active_account(self):
        out, err = self.gh('pr', 'list', cwd=self.client, logged_in='me')
        self.assertEqual(out, 'token=none args=pr list')
        self.assertIn('no stored token for work', err)

    def test_the_rules_file_is_data_and_is_never_executed(self):
        marker = self.other / 'ran'
        self.rules(f'default me\ntouch {marker}\n$(touch {marker})\ndir work $(touch {marker})\n')
        out, _ = self.gh('pr', 'list')
        self.assertEqual(out, 'token=tok-me args=pr list')
        self.assertFalse(marker.exists())

    def test_arguments_with_spaces_pass_through_unchanged(self):
        out, _ = self.gh('pr', 'create', '--title', 'two words')
        self.assertEqual(out, 'token=tok-me args=pr create --title two words')


if __name__ == '__main__':
    unittest.main()
