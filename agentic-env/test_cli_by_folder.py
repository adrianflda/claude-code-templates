#!/usr/bin/env python3
"""extras/cli-by-folder/cli-by-folder against stand-in tools, in a throwaway HOME.
Run: python3 -I agentic-env/test_cli_by_folder.py"""
import shutil
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

WRAPPER = Path(__file__).resolve().parent / 'extras' / 'cli-by-folder' / 'cli-by-folder'
TOOLS = ('gcloud', 'gsutil', 'bq', 'aws')
# Prints what the wrapper handed over: the tool it ran, the account it chose and the arguments.
FAKE = '''#!/bin/sh
echo "tool=$(basename "$0") gcloud=${CLOUDSDK_ACTIVE_CONFIG_NAME:-none} aws=${AWS_PROFILE:-none} args=$*"
'''
# Like gh: `auth token --user X` prints X's stored token or fails; anything else shows what it was handed.
FAKE_GH = '''#!/bin/sh
if [ "$1" = auth ] && [ "$2" = token ]; then
  [ "$3" = --user ] || { echo tok-active; exit 0; }
  case " $FAKE_LOGGED_IN " in *" $4 "*) echo "tok-$4"; exit 0 ;; esac
  exit 1
fi
echo "tool=$(basename "$0") token=${GH_TOKEN:-none} args=$*"
'''


class CliByFolderTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name).resolve()
        self.home = root / 'home'
        self.bin = self.home / 'bin'
        self.sdk = root / 'sdk' / 'bin'
        self.client, self.other = root / 'Client', root / 'other'
        for d in (self.bin, self.home / '.config', self.sdk, self.client / 'app' / 'src', self.other):
            d.mkdir(parents=True)
        for tool in TOOLS:
            fake = self.sdk / tool
            fake.write_text(FAKE)
            fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
        # Installed the way the README says: the script once, each tool as a link to it.
        script = self.bin / 'cli-by-folder'
        shutil.copy(WRAPPER, script)
        script.chmod(script.stat().st_mode | stat.S_IXUSR)
        for tool in TOOLS:
            (self.bin / tool).symlink_to('cli-by-folder')
        fake_gh = self.sdk / 'gh'
        fake_gh.write_text(FAKE_GH)
        fake_gh.chmod(fake_gh.stat().st_mode | stat.S_IXUSR)
        (self.bin / 'gh').symlink_to('cli-by-folder')
        self.conf = self.home / '.config' / 'cli-by-folder.conf'
        self.rules(f'# accounts by folder\nfolder work {self.client}\n'
                   'gcloud default me\ngcloud work client\naws default me-aws\naws work client-ro\n'
                   'gh default me-gh\ngh work client-gh\n')

    def tearDown(self):
        self.tmp.cleanup()

    def rules(self, text):
        self.conf.write_text(text)

    def run_tool(self, tool, *args, cwd=None, path=None, **env):
        base = {'HOME': str(self.home), 'PATH': path or f'{self.bin}:{self.sdk}:/usr/bin:/bin',
                'FAKE_LOGGED_IN': 'me-gh client-gh'}
        r = subprocess.run([str(self.bin / tool), *args], cwd=cwd or self.other, env={**base, **env},
                           capture_output=True, text=True, timeout=20)
        return r.stdout.strip(), r.stderr.strip(), r.returncode

    def out(self, tool, *args, **kw):
        return self.run_tool(tool, *args, **kw)[0]

    def test_inside_the_work_folder_each_tool_uses_its_work_account(self):
        for cwd in (self.client, self.client / 'app' / 'src'):
            self.assertEqual(self.out('gcloud', 'run', 'services', 'list', cwd=cwd),
                             'tool=gcloud gcloud=client aws=none args=run services list', cwd)
            self.assertEqual(self.out('aws', 's3', 'ls', cwd=cwd), 'tool=aws gcloud=none aws=client-ro args=s3 ls', cwd)

    def test_everywhere_else_each_tool_uses_its_default_account(self):
        self.assertEqual(self.out('gcloud', 'projects', 'list'), 'tool=gcloud gcloud=me aws=none args=projects list')
        self.assertEqual(self.out('aws', 's3', 'ls'), 'tool=aws gcloud=none aws=me-aws args=s3 ls')

    def test_gsutil_and_bq_read_the_gcloud_rules(self):
        self.assertEqual(self.out('gsutil', 'ls', cwd=self.client), 'tool=gsutil gcloud=client aws=none args=ls')
        self.assertEqual(self.out('bq', 'ls'), 'tool=bq gcloud=me aws=none args=ls')

    def test_a_sibling_folder_with_the_same_prefix_is_not_the_work_folder(self):
        sibling = Path(str(self.client) + '-old')
        sibling.mkdir()
        self.assertIn('gcloud=me ', self.out('gcloud', 'info', cwd=sibling))

    def test_a_label_can_have_several_folders_and_the_first_matching_folder_wins(self):
        second = self.other / 'second client'
        second.mkdir()
        self.rules(f'folder inner {self.client}/app/\nfolder work {self.client}\nfolder work {second}\n'
                   'gcloud default me\ngcloud work client\ngcloud inner nested')
        self.assertIn('gcloud=nested ', self.out('gcloud', 'info', cwd=self.client / 'app' / 'src'))
        self.assertIn('gcloud=client ', self.out('gcloud', 'info', cwd=self.client))
        self.assertIn('gcloud=client ', self.out('gcloud', 'info', cwd=second))

    def test_the_order_of_the_lines_does_not_matter(self):
        self.rules(f'gcloud work client\ngcloud default me\nfolder work {self.client}\n')
        self.assertIn('gcloud=client ', self.out('gcloud', 'info', cwd=self.client))
        self.assertIn('gcloud=me ', self.out('gcloud', 'info'))

    def test_in_the_work_folder_a_tool_without_a_work_account_is_refused(self):
        self.rules(f'folder work {self.client}\ngcloud default me\naws default me-aws\naws work client-ro\n')
        out, err, code = self.run_tool('gcloud', 'info', cwd=self.client)
        self.assertEqual((out, code), ('', 2))
        self.assertIn("no 'gcloud work <name>' line", err)
        self.assertIn('aws=client-ro', self.out('aws', 's3', 'ls', cwd=self.client))
        self.assertIn('gcloud=me ', self.out('gcloud', 'info'))

    def test_a_tool_without_any_rule_is_the_plain_tool(self):
        self.rules(f'folder work {self.client}\ngcloud default me\ngcloud work client\n')
        self.assertEqual(self.out('aws', 's3', 'ls', cwd=self.client), 'tool=aws gcloud=none aws=none args=s3 ls')
        self.conf.unlink()
        self.assertEqual(self.out('gcloud', 'info', cwd=self.client), 'tool=gcloud gcloud=none aws=none args=info')

    def test_outside_every_folder_a_tool_without_a_default_is_the_plain_tool(self):
        self.rules(f'folder work {self.client}\ngcloud work client\n')
        self.assertIn('gcloud=none', self.out('gcloud', 'info'))
        self.assertIn('gcloud=client', self.out('gcloud', 'info', cwd=self.client))

    def test_the_rules_file_can_be_named_in_the_environment(self):
        elsewhere = self.other / 'rules.conf'
        elsewhere.write_text('gcloud default elsewhere\n')
        self.assertIn('gcloud=elsewhere', self.out('gcloud', 'info', CLI_BY_FOLDER_CONF=str(elsewhere)))

    def test_an_explicit_gcloud_choice_is_the_callers_decision(self):
        self.assertIn('gcloud=mine', self.out('gcloud', 'info', cwd=self.client, CLOUDSDK_ACTIVE_CONFIG_NAME='mine'))
        self.assertIn('gcloud=none', self.out('gcloud', 'info', cwd=self.client, CLOUDSDK_CONFIG='/somewhere'))
        for flag in (('--configuration', 'mine'), ('--configuration=mine',)):
            self.assertEqual(self.out('gcloud', 'info', *flag, cwd=self.client),
                             f"tool=gcloud gcloud=none aws=none args=info {' '.join(flag)}")
        self.assertEqual(self.out('gcloud', 'config', 'configurations', 'list', cwd=self.client),
                         'tool=gcloud gcloud=none aws=none args=config configurations list')
        # Reading or setting a property is ordinary work and follows the folder.
        self.assertIn('gcloud=client', self.out('gcloud', 'config', 'list', cwd=self.client))

    def test_an_explicit_aws_choice_is_the_callers_decision(self):
        self.assertIn('aws=mine', self.out('aws', 's3', 'ls', cwd=self.client, AWS_PROFILE='mine'))
        for var in ('AWS_DEFAULT_PROFILE', 'AWS_ACCESS_KEY_ID', 'AWS_SESSION_TOKEN'):
            self.assertIn('aws=none', self.out('aws', 's3', 'ls', cwd=self.client, **{var: 'x'}), var)
        for flag in (('--profile', 'mine'), ('--profile=mine',)):
            self.assertEqual(self.out('aws', 's3', 'ls', *flag, cwd=self.client),
                             f"tool=aws gcloud=none aws=none args=s3 ls {' '.join(flag)}")

    def test_a_guarded_aws_profile_is_never_picked_by_folder(self):
        self.rules(f'folder work {self.client}\naws default me-aws\naws work admin\n')
        out, err, code = self.run_tool('aws', 's3', 'ls', cwd=self.client)
        self.assertEqual((out, code), ('', 2))
        self.assertIn('guarded AWS profile', err)
        self.rules(f'folder work {self.client}\naws default me-aws\naws work root\n')
        self.assertIn('aws=root', self.out('aws', 's3', 'ls', cwd=self.client))
        out, _, code = self.run_tool('aws', 's3', 'ls', cwd=self.client, AWS_ADMIN_GUARD_PROFILES='admin,root')
        self.assertEqual((out, code), ('', 2))
        # The human's explicit flag still reaches the tool, where the guard hook can see it.
        self.assertIn('args=s3 ls --profile root',
                      self.out('aws', 's3', 'ls', '--profile', 'root', cwd=self.client, AWS_ADMIN_GUARD_PROFILES='admin,root'))

    def test_the_rules_file_is_data_and_is_never_executed(self):
        marker = self.other / 'ran'
        self.rules(f'gcloud default me\ntouch {marker}\n$(touch {marker})\ngcloud work $(touch {marker})\n')
        self.assertIn('gcloud=me', self.out('gcloud', 'info'))
        self.rules(f'gcloud default me\nfolder work $(touch {marker})\n')
        self.assertEqual(self.run_tool('gcloud', 'info')[2], 2)
        self.assertFalse(marker.exists())

    def test_a_rules_file_that_was_named_or_exists_but_cannot_be_read_stops_the_command(self):
        out, err, code = self.run_tool('gcloud', 'info', cwd=self.client, CLI_BY_FOLDER_CONF=str(self.other / 'typo.conf'))
        self.assertEqual((out, code), ('', 2))
        self.assertIn('cannot read the rules file', err)
        self.conf.chmod(0)
        try:
            out, err, code = self.run_tool('gcloud', 'info', cwd=self.client)
        finally:
            self.conf.chmod(0o600)
        self.assertEqual((out, code), ('', 2))
        self.assertIn('cannot read the rules file', err)

    def test_a_folder_rule_written_through_a_symlink_still_matches(self):
        link = self.other / 'link-to-client'
        link.symlink_to(self.client)
        self.rules(f'folder work {link}\ngcloud default me\ngcloud work client\n')
        self.assertIn('gcloud=client', self.out('gcloud', 'info', cwd=self.client / 'app'))
        self.assertIn('gcloud=client', self.out('gcloud', 'info', cwd=link))

    def test_a_malformed_line_stops_the_command_instead_of_picking_the_default(self):
        for bad in ('folder work', 'folder work ~/Projects/Client', 'folder work relative/path', 'gcloud work', 'gcloud'):
            self.rules(f'gcloud default me\n{bad}\n')
            out, err, code = self.run_tool('gcloud', 'info')
            self.assertEqual((out, code), ('', 2), bad)
            self.assertIn('bad line', err, bad)
        # A line of another tool is not this tool's business.
        self.rules('gcloud default me\naws work\n')
        self.assertIn('gcloud=me', self.out('gcloud', 'info'))

    def test_a_name_that_is_not_a_plain_name_is_refused(self):
        for bad in ('me;rm', '-x', 'a b'):
            self.rules(f'gcloud default {bad}\n')
            out, err, code = self.run_tool('gcloud', 'info')
            self.assertEqual((out, code), ('', 2), bad)
            self.assertIn('not a valid name', err)

    def test_arguments_with_spaces_pass_through_unchanged(self):
        self.assertEqual(self.out('gcloud', 'compute', 'ssh', '--command', 'two words'),
                         'tool=gcloud gcloud=me aws=none args=compute ssh --command two words')

    def test_the_wrapper_never_runs_itself(self):
        # The wrapper's own folder is on PATH twice, once through a link to that folder.
        alias = self.home / 'bin-link'
        alias.symlink_to(self.bin)
        out, _, code = self.run_tool('gcloud', 'info', path=f'{alias}:{self.bin}:{self.sdk}:/usr/bin:/bin')
        self.assertEqual((out, code), ('tool=gcloud gcloud=me aws=none args=info', 0))

    def test_without_the_real_tool_it_says_so(self):
        out, err, code = self.run_tool('gcloud', 'info', path=f'{self.bin}:/usr/bin:/bin')
        self.assertEqual((out, code), ('', 127))
        self.assertIn('no gcloud found on PATH', err)

    def test_gh_gets_the_stored_token_of_the_folders_account(self):
        self.assertEqual(self.out('gh', 'pr', 'list', cwd=self.client / 'app'), 'tool=gh token=tok-client-gh args=pr list')
        self.assertEqual(self.out('gh', 'pr', 'create', '--title', 'two words'),
                         'tool=gh token=tok-me-gh args=pr create --title two words')

    def test_gh_with_an_explicit_token_or_an_auth_command_is_the_callers_decision(self):
        self.assertEqual(self.out('gh', 'pr', 'list', cwd=self.client, GH_TOKEN='tok-explicit'),
                         'tool=gh token=tok-explicit args=pr list')
        self.assertEqual(self.out('gh', 'pr', 'list', cwd=self.client, GITHUB_TOKEN='x'), 'tool=gh token=none args=pr list')
        self.assertEqual(self.out('gh', 'auth', 'status', cwd=self.client), 'tool=gh token=none args=auth status')
        self.assertEqual(self.out('gh', 'auth', 'token', cwd=self.client), 'tok-active')

    def test_gh_without_a_stored_token_for_the_account_stops(self):
        for cwd in (self.client, self.other):
            out, err, code = self.run_tool('gh', 'pr', 'list', cwd=cwd, FAKE_LOGGED_IN='someone-else')
            self.assertEqual((out, code), ('', 2), cwd)
            self.assertIn('no stored token', err)
            self.assertIn('gh auth login', err)

    def test_a_real_tool_renamed_next_to_the_wrapper_is_used_first(self):
        renamed = self.bin / 'gh-real'
        renamed.write_text(FAKE_GH)
        renamed.chmod(renamed.stat().st_mode | stat.S_IXUSR)
        self.assertEqual(self.out('gh', 'pr', 'list', path=f'{self.bin}:/usr/bin:/bin'),
                         'tool=gh-real token=tok-me-gh args=pr list')

    def test_under_an_unknown_name_it_refuses(self):
        (self.bin / 'kubectl').symlink_to('cli-by-folder')
        out, err, code = self.run_tool('kubectl', 'get', 'pods')
        self.assertEqual((out, code), ('', 2))
        self.assertIn("'kubectl' is not supported", err)


if __name__ == '__main__':
    unittest.main()
