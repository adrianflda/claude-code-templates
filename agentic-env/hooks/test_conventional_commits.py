#!/usr/bin/env python3
"""conventional-commits.py, fed the JSON a PreToolUse hook receives. Run: python3 -I agentic-env/hooks/test_conventional_commits.py"""
import json
import subprocess
import sys
import unittest
from pathlib import Path

HOOK = Path(__file__).with_name('conventional-commits.py')
COMMIT = 'git ' + 'commit'  # split so that this file's own text never looks like a commit to the hook


def denied(command, tool='Bash'):
    r = subprocess.run([sys.executable, str(HOOK)], text=True, capture_output=True,
                       input=json.dumps({'tool_name': tool, 'tool_input': {'command': command}}))
    assert r.returncode == 0, r.stderr
    return bool(r.stdout.strip()) and json.loads(r.stdout)['hookSpecificOutput']['permissionDecision'] == 'deny'


def heredoc(subject):
    return COMMIT + ' -m "$(cat <<\'EOF\'\n' + subject + "\n\nBody with an apostrophe: it's fine.\nEOF\n)\""


class ConventionalCommitsTest(unittest.TestCase):
    def test_a_conventional_message_is_allowed_in_every_quoting(self):
        for command in (COMMIT + ' -m "feat: add login"',
                        COMMIT + " -m 'fix(api): handle null'",
                        'git add -A && ' + COMMIT + ' -q -m "docs: explain the gate"',
                        heredoc('feat(auth): add tokens'),
                        COMMIT + ' -m "fix: don\'t crash on an empty list"'):
            self.assertFalse(denied(command), command)

    def test_a_message_without_a_type_is_denied_in_every_quoting(self):
        for command in (COMMIT + ' -m "Added new feature"',
                        COMMIT + " -m 'feature: add login'",
                        COMMIT + ' -m "feat:add login"',
                        'git add -A; ' + COMMIT + ' -m "wip"',
                        heredoc('Added new feature'),
                        COMMIT + ' -m "it\'s a fix: really"'):
            self.assertTrue(denied(command), command)

    def test_a_message_the_hook_cannot_read_is_allowed(self):
        for command in (COMMIT,
                        COMMIT + ' -F message.txt',
                        COMMIT + ' -F - <<EOF\nwhatever\nEOF',
                        COMMIT + ' -m "$(./make-message.sh)"',
                        COMMIT + ' --amend --no-edit'):
            self.assertFalse(denied(command), command)

    def test_the_words_inside_another_command_are_not_a_commit(self):
        for command in ('grep -rn "' + COMMIT + ' -m \\"wip\\"" docs/',
                        "python3 - <<'PY'\nprint('" + COMMIT + " -m \"wip\"')\nPY",
                        'echo "run: ' + COMMIT + ' -m \'whatever\'"'):
            self.assertFalse(denied(command), command)

    def test_other_tools_are_left_alone(self):
        self.assertFalse(denied(COMMIT + ' -m "nope"', tool='Read'))


if __name__ == '__main__':
    unittest.main()
