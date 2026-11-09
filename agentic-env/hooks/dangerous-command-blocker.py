#!/usr/bin/env python3
"""
Dangerous Command Blocker (PreToolUse Bash): blocks only catastrophic, irreversible commands.

Narrowed 2026-10-28 after an audit of 30 days of transcripts: 57 blocks, 0 real, all on everyday cleanup
(scratchpad dirs, `docker rm`, pycache, a `.env.dev` symlink, a grep whose pattern said "rm"), while
`rm -rf ~/`, `rm -rf $HOME` and `bash -c "rm -rf /"` passed. It now splits the command into simple
commands and judges each command's own arguments, never the text around them.
Tests: test_dangerous_command_blocker.py
"""

import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from shell_words import shell_script, simple_commands, unwrap  # noqa: E402

HOME = os.path.expanduser('~')
HOME_FORMS = ('~', '$HOME', '${HOME}', HOME)
# Arguments that mean "everything": the root, the home folder, or every file in the current folder.
WIPE_TARGETS = {'/', '/*', '*'} | {h + s for h in HOME_FORMS for s in ('', '/', '/*')}
# Folders whose loss cannot be undone from the repo itself.
KEEP_DIRS = {h + '/.claude' for h in HOME_FORMS}

RAW_PATTERNS = [
    (r':\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:', 'fork bomb'),
    (r'>\s*/dev/(sd[a-z]|disk\d|rdisk\d|nvme\d)', 'direct write to a disk device'),
]


def norm(arg):
    return arg if arg in ('/', '/*') else arg.rstrip('/') or '/'


def operands(argv):
    return [a for a in argv[1:] if not a.startswith('-') or a == '-']


def verdict(argv, depth=0):
    argv = unwrap(argv)
    if not argv:
        return None
    name = os.path.basename(argv[0])
    args = operands(argv)
    script = shell_script(argv)
    if script is not None and depth < 3:
        return check(script, depth + 1)
    if name == 'rm':
        for a in args:
            n = norm(a)
            if a in WIPE_TARGETS or n in WIPE_TARGETS:
                return f'rm on {a} (root, home folder or every file here)'
            if os.path.basename(n) == '.git':
                return f'rm on {a} (git history)'
            if n in KEEP_DIRS:
                return f'rm on {a} (Claude Code configuration)'
    if name == 'find' and ('-delete' in argv or 'rm' in argv[1:]):
        for a in argv[1:]:
            if a.startswith(('-', '(', '!')):
                break
            if norm(a) in WIPE_TARGETS:
                return f'find {a} with delete'
    if name == 'dd' and any(a.startswith('of=/dev/') for a in args):
        return 'dd onto a device'
    if name.startswith('mkfs') or name in ('mkswap', 'fdisk') or (
            name == 'diskutil' and {'eraseDisk', 'eraseVolume', 'partitionDisk'} & set(args)):
        return 'disk formatting'
    if name in ('chmod', 'chown') and any(norm(a) in WIPE_TARGETS for a in args):
        return f'{name} on the root or home folder'
    return None


def check(text, depth=0):
    for pattern, desc in RAW_PATTERNS:
        if re.search(pattern, text):
            return desc
    for argv in simple_commands(text):
        reason = verdict(argv, depth)
        if reason:
            return reason
    return None


def main():
    try:
        cmd = json.load(sys.stdin).get('tool_input', {}).get('command', '') or ''
    except (ValueError, AttributeError):
        sys.exit(0)
    reason = check(cmd)
    if reason:
        print(f'BLOCKED: catastrophic command ({reason}).', file=sys.stderr)
        print(f'Command: {cmd[:160]}', file=sys.stderr)
        print('It cannot be undone. Target a specific path; if this is truly intended, ask the user to run it.',
              file=sys.stderr)
        sys.exit(2)
    sys.exit(0)


if __name__ == '__main__':
    main()
