#!/usr/bin/env python3
"""Copy third-party skills into plugins/dev-toolbox at a pinned commit, with the edits VENDOR.json declares.

    python3 -I scripts/vendor_dev_toolbox.py --src DIR           # write plugins/dev-toolbox/skills/<name>
    python3 -I scripts/vendor_dev_toolbox.py --src DIR --check   # exit 1 if the tree differs from a fresh copy

DIR holds one checkout per source, at DIR/<id>/repo, with HEAD at the commit VENDOR.json pins
(`git clone https://github.com/<repo> DIR/<id>/repo && git -C DIR/<id>/repo checkout <commit>`).
Nothing is downloaded and nothing from a source is executed: files are read, edited as text and written.

Per skill, VENDOR.json may declare:
  userOnly      true adds `disable-model-invocation: true`: the skill runs only when the user types it
  dropSections  heading titles; each section goes, down to the next heading of the same or a higher level
  dropLines     regular expressions; a matching line goes, in every Markdown file of the skill
  dropFiles     paths inside the skill that are not copied
  replace       [old, new] pairs applied to SKILL.md; an `old` that is absent is an error (upstream moved)
  description   a new frontmatter description
A skill whose frontmatter declares hooks is refused: a vendored skill must not run commands by itself.
"""
import filecmp
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PLUGIN = REPO / 'plugins' / 'dev-toolbox'
TEXT = {'.md', '.json', '.txt', '.py', '.xml', '.yml', '.yaml', '.sh', '.mjs', '.js', '.ts', '.html', '.css', ''}


class VendorError(Exception):
    pass


def split_frontmatter(text, where):
    m = re.match(r'---\n(.*?)\n---\n', text, re.S)
    if not m:
        raise VendorError(f'{where}: no frontmatter')
    return m.group(1), text[m.end():]


def drop_sections(body, titles, where):
    lines, out, skipping, in_fence = body.split('\n'), [], 0, False
    seen = set()
    for line in lines:
        if line.lstrip().startswith('```'):
            in_fence = not in_fence
        h = None if in_fence else re.match(r'(#{1,6})\s+(.*?)\s*$', line)
        if h:
            level, title = len(h.group(1)), h.group(2)
            if skipping and level <= skipping:
                skipping = 0
            if not skipping and title in titles:
                skipping = level
                seen.add(title)
        if not skipping:
            out.append(line)
    missing = set(titles) - seen
    if missing:
        raise VendorError(f'{where}: no section named {sorted(missing)}')
    return '\n'.join(out)


def edit_skill_md(text, spec, where):
    front, body = split_frontmatter(text, where)
    if re.search(r'^hooks\s*:', front, re.M):
        raise VendorError(f'{where}: the frontmatter declares hooks')
    if spec.get('description'):
        front, n = re.subn(r'^description:.*?(?=^\S|\Z)', 'description: ' + json.dumps(spec['description']) + '\n',
                           front + '\n', count=1, flags=re.M | re.S)
        front = front.rstrip('\n')
        if n != 1:
            raise VendorError(f'{where}: no description to replace')
    front = re.sub(r'^disable-model-invocation:.*\n?', '', front, flags=re.M).rstrip('\n')
    if spec.get('userOnly'):
        front += '\ndisable-model-invocation: true'
    if spec.get('dropSections'):
        body = drop_sections(body, spec['dropSections'], where)
    for old, new in spec.get('replace', []):
        if old not in body:
            raise VendorError(f'{where}: text to replace not found: {old[:60]!r}')
        body = body.replace(old, new)
    return f'---\n{front}\n---\n{body}'


def drop_lines(text, patterns):
    if not patterns:
        return text
    rx = [re.compile(p) for p in patterns]
    return '\n'.join(l for l in text.split('\n') if not any(r.search(l) for r in rx))


def head_of(checkout):
    r = subprocess.run(['git', '-C', str(checkout), 'rev-parse', 'HEAD'], capture_output=True, text=True)
    if r.returncode:
        raise VendorError(f'{checkout}: not a git checkout')
    return r.stdout.strip()


def build(vendor, src, out):
    """Write every vendored skill and the license files under `out` (a stand-in for the plugin folder)."""
    names = set()
    for source in vendor['sources']:
        checkout = src / source['id'] / 'repo'
        if head_of(checkout) != source['commit']:
            raise VendorError(f"{source['id']}: checkout is at {head_of(checkout)[:12]}, VENDOR.json pins {source['commit'][:12]}")
        lic = checkout / source['licenseFile']
        if not lic.is_file():
            raise VendorError(f"{source['id']}: license file {source['licenseFile']} not found")
        (out / 'licenses').mkdir(parents=True, exist_ok=True)
        shutil.copyfile(lic, out / 'licenses' / f"{source['id']}.txt")
        for spec in source['skills']:
            name, origin = spec['name'], checkout / spec['from']
            if name in names:
                raise VendorError(f'{name}: vendored twice')
            names.add(name)
            if not (origin / 'SKILL.md').is_file():
                raise VendorError(f"{source['id']}: {spec['from']}/SKILL.md not found")
            dropped = set(spec.get('dropFiles', []))
            missing = [d for d in dropped if not (origin / d).exists()]
            if missing:
                raise VendorError(f'{name}: dropFiles not in the source: {missing}')
            for path in sorted(p for p in origin.rglob('*') if p.is_file()):
                rel = path.relative_to(origin).as_posix()
                if rel in dropped or path.name == '.DS_Store':
                    continue
                if path.is_symlink() or path.suffix not in TEXT:
                    raise VendorError(f'{name}: {rel} is not a plain text file')
                text = path.read_text(encoding='utf-8')
                if rel == 'SKILL.md':
                    text = edit_skill_md(text, spec, f'{name}/SKILL.md')
                if path.suffix == '.md':
                    text = drop_lines(text, spec.get('dropLines'))
                target = out / 'skills' / name / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(text, encoding='utf-8')
    return names


def differences(a, b):
    cmp, found = filecmp.dircmp(a, b), []
    found += [f'only in the tree: {a / n}' for n in cmp.left_only]
    found += [f'missing from the tree: {a / n}' for n in cmp.right_only]
    found += [f'differs: {a / n}' for n in filecmp.cmpfiles(a, b, cmp.common_files, shallow=False)[1]]
    for sub in cmp.common_dirs:
        found += differences(a / sub, b / sub)
    return found


def main(argv):
    if '--src' not in argv:
        print(__doc__)
        return 2
    src = Path(argv[argv.index('--src') + 1]).resolve()
    plugin = Path(argv[argv.index('--plugin') + 1]).resolve() if '--plugin' in argv else PLUGIN
    vendor = json.loads((plugin / 'VENDOR.json').read_text())
    try:
        with tempfile.TemporaryDirectory() as tmp:
            fresh = Path(tmp)
            names = build(vendor, src, fresh)
            if '--check' in argv:
                drift = differences(plugin / 'licenses', fresh / 'licenses') if (plugin / 'licenses').is_dir() else ['no licenses folder']
                for name in sorted(names):
                    mine = plugin / 'skills' / name
                    drift += differences(mine, fresh / 'skills' / name) if mine.is_dir() else [f'missing skill: {name}']
                print('\n'.join(drift) if drift else f'OK: {len(names)} vendored skills match VENDOR.json')
                return 1 if drift else 0
            for name in sorted(names):
                target = plugin / 'skills' / name
                if target.exists():
                    shutil.rmtree(target)
                shutil.copytree(fresh / 'skills' / name, target)
            if (plugin / 'licenses').exists():
                shutil.rmtree(plugin / 'licenses')
            shutil.copytree(fresh / 'licenses', plugin / 'licenses')
            print(f'vendored {len(names)} skills into {plugin / "skills"}')
            return 0
    except VendorError as e:
        print(f'error: {e}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
