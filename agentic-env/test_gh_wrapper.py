#!/usr/bin/env python3
"""extras/gh-wrapper/gh against a stand-in gh-real and git, in a throwaway HOME.
Run: python3 -I agentic-env/test_gh_wrapper.py"""
import os
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

WRAPPER = Path(__file__).resolve().parent / 'extras' / 'gh-wrapper' / 'gh'
# Prints what the wrapper handed over: the token it would use and the arguments.
# The stored token belongs to the account `ana`; any other request gets the active account's.
FAKE_GH = '''#!/bin/sh
if [ "$1" = auth ] && [ "$2" = token ]; then
  # Like gh: without --user it answers with the active account's token.
  [ "$3" = --user ] && [ "$4" = ana ] || { echo tok-active; exit 0; }
  [ -n "$FAKE_STORED_TOKEN" ] || exit 1
  echo "$FAKE_STORED_TOKEN"; exit 0
fi
echo "token=${GH_TOKEN:-none} args=$*"
'''
FAKE_GIT = '#!/bin/sh\n[ -n "$FAKE_ORIGIN" ] || exit 2\necho "$FAKE_ORIGIN"\n'


class GhWrapperTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name).resolve()
        self.home, self.bin = root / 'home', root / 'bin'
        self.personal, self.work = root / 'personal', root / 'work'
        for d in (self.home / 'bin', self.bin, self.personal / 'app', self.work):
            d.mkdir(parents=True)
        for path, body in ((self.home / 'bin' / 'gh-real', FAKE_GH), (self.bin / 'git', FAKE_GIT)):
            path.write_text(body)
            path.chmod(path.stat().st_mode | stat.S_IXUSR)

    def tearDown(self):
        self.tmp.cleanup()

    def gh(self, *args, cwd=None, origin='', stored='tok-personal', **env):
        base = {'HOME': str(self.home), 'PATH': f'{self.bin}{os.pathsep}/usr/bin{os.pathsep}/bin',
                'FAKE_ORIGIN': origin, 'FAKE_STORED_TOKEN': stored}
        r = subprocess.run(['/bin/sh', str(WRAPPER), *args], cwd=cwd or self.work, env={**base, **env},
                           capture_output=True, text=True, timeout=20)
        return r.stdout.strip(), r.stderr.strip()

    def test_without_a_configured_account_it_is_plain_gh(self):
        out, _ = self.gh('pr', 'list', cwd=self.personal, origin='git@github.com:ana/app.git', GH_PERSONAL_DIR=str(self.personal))
        self.assertEqual(out, 'token=none args=pr list')

    def test_a_repo_of_the_personal_account_gets_the_personal_token(self):
        for origin in ('git@github.com:ana/app.git', 'https://github.com/ana/app.git', 'github-personal:other/app.git'):
            out, _ = self.gh('pr', 'list', origin=origin, GH_PERSONAL_USER='ana')
            self.assertEqual(out, 'token=tok-personal args=pr list', origin)

    def test_a_folder_under_the_personal_directory_gets_the_personal_token(self):
        out, _ = self.gh('repo', 'view', cwd=self.personal / 'app', GH_PERSONAL_USER='ana', GH_PERSONAL_DIR=str(self.personal))
        self.assertEqual(out, 'token=tok-personal args=repo view')

    def test_other_work_is_left_alone(self):
        for origin in ('git@github.com:company/app.git', 'git@github.com:banana/app.git', ''):
            out, _ = self.gh('pr', 'list', origin=origin, GH_PERSONAL_USER='ana', GH_PERSONAL_DIR=str(self.personal))
            self.assertEqual(out, 'token=none args=pr list', origin)

    def test_a_sibling_folder_with_the_same_prefix_is_not_personal(self):
        sibling = Path(str(self.personal) + '-old')
        sibling.mkdir()
        out, _ = self.gh('pr', 'list', cwd=sibling, GH_PERSONAL_USER='ana', GH_PERSONAL_DIR=str(self.personal))
        self.assertEqual(out, 'token=none args=pr list')

    def test_an_explicit_token_and_auth_commands_are_the_callers_decision(self):
        out, _ = self.gh('pr', 'list', origin='git@github.com:ana/app.git', GH_PERSONAL_USER='ana', GH_TOKEN='tok-explicit')
        self.assertEqual(out, 'token=tok-explicit args=pr list')
        out, _ = self.gh('pr', 'list', origin='git@github.com:ana/app.git', GH_PERSONAL_USER='ana', GITHUB_TOKEN='x')
        self.assertEqual(out, 'token=none args=pr list')
        out, _ = self.gh('auth', 'status', origin='git@github.com:ana/app.git', GH_PERSONAL_USER='ana')
        self.assertEqual(out, 'token=none args=auth status')

    def test_no_stored_token_warns_and_uses_the_active_account(self):
        out, err = self.gh('pr', 'list', origin='git@github.com:ana/app.git', stored='', GH_PERSONAL_USER='ana')
        self.assertEqual(out, 'token=none args=pr list')
        self.assertIn('no stored token for ana', err)

    def test_arguments_with_spaces_pass_through_unchanged(self):
        out, _ = self.gh('pr', 'create', '--title', 'two words', origin='git@github.com:ana/app.git', GH_PERSONAL_USER='ana')
        self.assertEqual(out, 'token=tok-personal args=pr create --title two words')


if __name__ == '__main__':
    unittest.main()
