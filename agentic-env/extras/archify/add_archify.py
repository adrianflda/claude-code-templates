#!/usr/bin/env python3
"""Add the Archify skill (https://github.com/tt-a1i/archify, Apache-2.0) to ONE project.

    python3 -I agentic-env/extras/archify/add_archify.py <project-dir>
    python3 -I agentic-env/extras/archify/add_archify.py <project-dir> --from archive.tar.gz   # no download
    python3 -I agentic-env/extras/archify/add_archify.py <project-dir> --replace               # move to the pinned commit

It downloads the repository archive at the commit pinned below, copies only its `archify/` folder to
<project-dir>/.claude/skills/archify and marks the skill user-only, so it runs when `/archify` is typed
and never by itself. Nothing is installed globally and nothing from the archive is executed here.

Archify is not part of dev-toolbox on purpose: it is about 24 MB, it runs its own Node programs, and it
checks for updates over the network unless ARCHIFY_UPDATE_CHECK_DISABLED=1 is set.
"""
import io
import re
import shutil
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

REPO = 'tt-a1i/archify'
COMMIT = '95586bc667fa97ed73588efc13d2f14a5b3c4241'  # main on 2026-11-25, package version 3.3.2
URL = f'https://codeload.github.com/{REPO}/tar.gz/{COMMIT}'
MAX_BYTES = 200 * 1024 * 1024


class AddError(Exception):
    pass


def read_archive(source):
    if source:
        return Path(source).read_bytes()
    with urllib.request.urlopen(URL, timeout=120) as response:  # noqa: S310 - fixed https URL
        data = response.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise AddError('the archive is larger than expected')
    return data


def extract_skill(data, out):
    """Write the archive's <top>/archify/ folder under `out`. Links and paths that leave it are refused."""
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as tar:
        members = tar.getmembers()
        if not members:
            raise AddError('the archive is empty')
        top = members[0].name.split('/')[0]
        if top != f'archify-{COMMIT}':
            raise AddError(f'the archive is {top}, not the pinned commit {COMMIT[:12]}')
        prefix, count = f'{top}/archify/', 0
        for member in members:
            if not member.name.startswith(prefix) or member.isdir():
                continue
            rel = member.name[len(prefix):]
            if not member.isfile() or rel.startswith('/') or '..' in Path(rel).parts:
                raise AddError(f'refused archive entry: {member.name}')
            target = out / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(tar.extractfile(member).read())
            count += 1
    if not (out / 'SKILL.md').is_file():
        raise AddError('the archive has no archify/SKILL.md')
    return count


def make_user_only(skill_md):
    text = skill_md.read_text(encoding='utf-8')
    m = re.match(r'---\n(.*?)\n---\n', text, re.S)
    if not m:
        raise AddError('archify/SKILL.md has no frontmatter')
    front = m.group(1)
    if re.search(r'^hooks\s*:', front, re.M):
        raise AddError('archify/SKILL.md declares hooks; read it before installing')
    front = re.sub(r'^disable-model-invocation:.*\n?', '', front, flags=re.M).rstrip('\n')
    skill_md.write_text(f'---\n{front}\ndisable-model-invocation: true\n---\n{text[m.end():]}', encoding='utf-8')


def install(fresh, target):
    """Put `fresh` at `target`. The old copy is removed only after the new one is complete beside it."""
    target.parent.mkdir(parents=True, exist_ok=True)
    incoming, outgoing = target.with_name('archify.incoming'), target.with_name('archify.outgoing')
    for leftover in (incoming, outgoing):
        if leftover.exists():
            shutil.rmtree(leftover)
    try:
        shutil.copytree(fresh, incoming)
        if target.exists():
            target.rename(outgoing)
        incoming.rename(target)
    except OSError:
        if outgoing.exists() and not target.exists():
            outgoing.rename(target)
        shutil.rmtree(incoming, ignore_errors=True)
        raise
    shutil.rmtree(outgoing, ignore_errors=True)


def main(argv):
    args = [a for a in argv if not a.startswith('--')]
    source = None
    if '--from' in argv:
        at = argv.index('--from')
        if at + 1 >= len(argv) or argv[at + 1].startswith('--'):
            print('error: --from needs the path of an archive', file=sys.stderr)
            return 2
        source = argv[at + 1]
        args.remove(source)
    if len(args) != 1:
        print(__doc__)
        return 2
    project = Path(args[0]).expanduser().resolve()
    target = project / '.claude' / 'skills' / 'archify'
    try:
        if not project.is_dir():
            raise AddError(f'{project} is not a folder')
        if project == Path.home():
            raise AddError('give a project folder, not the home folder: this skill is installed per project')
        if target.exists() and '--replace' not in argv:
            raise AddError(f'{target} already exists (use --replace to move it to the pinned commit)')
        with tempfile.TemporaryDirectory() as tmp:
            fresh = Path(tmp) / 'archify'
            count = extract_skill(read_archive(source), fresh)
            make_user_only(fresh / 'SKILL.md')
            (fresh / 'VENDORED.txt').write_text(f'https://github.com/{REPO} at {COMMIT}\nApache-2.0; see LICENSE in this folder if present, and the repository.\n')
            install(fresh, target)
    except (AddError, OSError, tarfile.TarError) as e:
        print(f'error: {e}', file=sys.stderr)
        return 1
    print(f'added {count} files to {target} (archify at {COMMIT[:12]})')
    print('Next, in that project:')
    print('  - type /archify to use it; it does not start by itself')
    print('  - add `.archify/` (its output) and `.claude/skills/archify/` (24 MB) to .gitignore, unless the team wants them')
    print('  - put  "env": {"ARCHIFY_UPDATE_CHECK_DISABLED": "1"}  in .claude/settings.local.json to stop its update check')
    print('  - it needs Node, and Chrome or Chromium for its browser check and exports')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
