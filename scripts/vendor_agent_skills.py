#!/usr/bin/env python3
"""Vendor the skills of addyosmani/agent-skills into plugins/agent-skills, curated.

  python3 -I scripts/vendor_agent_skills.py                 download the pinned commit and regenerate
  python3 -I scripts/vendor_agent_skills.py --source DIR    regenerate from an already extracted tree
  python3 -I scripts/vendor_agent_skills.py --check         offline: the committed tree matches VENDOR.json
  --plugin-dir DIR                                          the plugin directory (default plugins/agent-skills)

plugins/agent-skills/VENDOR.json is the whole decision: the upstream repo, version and commit, the
skills the model may invoke on its own (`active`) and the ones only the user invokes (`userOnly`).
Only `skills/` and `LICENSE` are taken. Skill text is copied verbatim; the one edit is
`disable-model-invocation: true` in the frontmatter of the user-only skills. The digest of the
result is written to VENDOR.sha256, and --check fails when the committed files no longer match it.

It refuses, writing nothing, when upstream wires a hook, has a SKILL.md whose frontmatter holds
anything but `name` and `description` (a skill can declare its own hooks or tools there), ships a
skill that VENDOR.json does not classify, lacks a classified skill, contains a link under skills/,
or reports another version than the pinned one. To take a new
upstream release: change `version` and `commit`, run it, classify what it names, review the diff.

Exit: 0 done / in sync · 1 the committed tree differs (--check) · 2 refused or failed.
"""
import hashlib
import io
import json
import shutil
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
FLAG = 'disable-model-invocation: true'
NOT_VENDORED = ('hooks', 'commands', 'agents')
READ_FROM_UPSTREAM = ('LICENSE', '.claude-plugin/plugin.json', 'hooks/hooks.json')  # besides skills/
MANIFEST_KEYS = ('name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords')


class Refused(Exception):
    """The upstream tree or VENDOR.json is not something to vendor as it is."""


def load_vendor(plugin_dir):
    vendor = json.loads((plugin_dir / 'VENDOR.json').read_text())
    both = set(vendor['active']) & set(vendor['userOnly'])
    if both:
        raise Refused(f'VENDOR.json lists a skill as both active and userOnly: {sorted(both)}')
    return vendor


def frontmatter(text, where):
    """-> (frontmatter lines, body) of a SKILL.md."""
    if not text.startswith('---\n') or '\n---\n' not in text[4:]:
        raise Refused(f'{where}: no frontmatter block')
    head, body = text[4:].split('\n---\n', 1)
    lines = head.split('\n')
    for key in ('name:', 'description:'):
        if not any(line.startswith(key) for line in lines):
            raise Refused(f'{where}: frontmatter has no {key}')
    return lines, body


def tree_digest(plugin_dir):
    """-> sha256 over the path and bytes of every vendored file (skills/ and LICENSE)."""
    digest = hashlib.sha256()
    files = [plugin_dir / 'LICENSE'] + sorted(p for p in (plugin_dir / 'skills').rglob('*') if p.is_file())
    for f in files:
        digest.update(f.relative_to(plugin_dir).as_posix().encode() + b'\0' + f.read_bytes() + b'\0')
    return digest.hexdigest()


def curated(text, user_only, where):
    lines, body = frontmatter(text, where)
    extra = [line for line in lines if line[:1] not in (' ', '\t', '') and not line.startswith(('name:', 'description:'))]
    if extra:
        raise Refused(f'{where}: frontmatter holds more than name and description ({extra[0]!r}); decide by hand')
    if user_only:
        lines.append(FLAG)
    return '---\n' + '\n'.join(lines) + '\n---\n' + body


def download(vendor, into):
    """Extract what is read from the pinned commit under `into` -> that folder."""
    url = f"https://codeload.github.com/{vendor['repo']}/tar.gz/{vendor['commit']}"
    with urllib.request.urlopen(url, timeout=60) as response:
        archive = tarfile.open(fileobj=io.BytesIO(response.read()), mode='r:gz')
    root = Path(into).resolve()
    for member in archive.getmembers():
        inner = member.name.partition('/')[2]
        if not (inner.startswith('skills/') or inner in READ_FROM_UPSTREAM):
            continue
        target = (root / inner).resolve()
        if root not in target.parents:
            raise Refused(f'archive member escapes the extraction folder: {member.name}')
        if member.isdir():
            target.mkdir(parents=True, exist_ok=True)
        elif member.isfile():
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(archive.extractfile(member).read())
            target.chmod(0o755 if member.mode & 0o100 else 0o644)
        else:
            raise Refused(f'a link or special file where a plain file was expected: {member.name}')
    return root


def upstream_problems(source, vendor):
    """-> reasons this upstream tree must not be vendored with this VENDOR.json."""
    problems = []
    manifest = json.loads((source / '.claude-plugin' / 'plugin.json').read_text())
    if 'hooks' in manifest or (source / 'hooks' / 'hooks.json').exists():
        problems.append('upstream now wires hooks (plugin.json `hooks` or hooks/hooks.json): review them first')
    if manifest.get('version') != vendor['version']:
        problems.append(f"upstream is version {manifest.get('version')}, VENDOR.json pins {vendor['version']}")
    links = sorted(p.relative_to(source).as_posix() for p in (source / 'skills').rglob('*') if p.is_symlink())
    if links:
        problems.append(f'upstream has a link under skills/: {links[0]}')
    nested = sorted(p.relative_to(source).as_posix() for p in (source / 'skills').rglob('SKILL.md')
                    if len(p.relative_to(source / 'skills').parts) != 2)
    if nested:
        problems.append(f'a SKILL.md that is not skills/<name>/SKILL.md: {nested[0]}')
    shipped = {p.name for p in (source / 'skills').iterdir() if p.is_dir()}
    classified = set(vendor['active']) | set(vendor['userOnly'])
    for name in sorted(shipped - classified):
        problems.append(f'upstream skill not classified in VENDOR.json (active or userOnly): {name}')
    for name in sorted(classified - shipped):
        problems.append(f'VENDOR.json names a skill upstream does not ship: {name}')
    return problems


def plugin_manifest(source, vendor):
    upstream = json.loads((source / '.claude-plugin' / 'plugin.json').read_text())
    manifest = {k: upstream[k] for k in MANIFEST_KEYS if k in upstream}
    manifest['description'] = (f"{upstream.get('description', '').rstrip('.')}. Vendored from {vendor['repo']} "
                               f"{vendor['version']}: skills only, most of them user-invoked (see VENDOR.json).")
    return manifest


def vendor_tree(source, plugin_dir, vendor):
    problems = upstream_problems(source, vendor)
    if problems:
        raise Refused('\n  '.join(['upstream cannot be vendored as it is:'] + problems))
    staged = Path(tempfile.mkdtemp(dir=plugin_dir.parent)) / 'skills'
    try:
        shutil.copytree(source / 'skills', staged)
        for skill_md in sorted(staged.glob('*/SKILL.md')):
            name = skill_md.parent.name
            skill_md.write_text(curated(skill_md.read_text(), name in vendor['userOnly'], f'skills/{name}/SKILL.md'))
        if (plugin_dir / 'skills').exists():
            shutil.move(str(plugin_dir / 'skills'), str(staged.parent / 'replaced'))
        shutil.move(str(staged), str(plugin_dir / 'skills'))
    finally:
        shutil.rmtree(staged.parent, ignore_errors=True)
    shutil.copy2(source / 'LICENSE', plugin_dir / 'LICENSE')
    (plugin_dir / '.claude-plugin').mkdir(exist_ok=True)
    (plugin_dir / '.claude-plugin' / 'plugin.json').write_text(
        json.dumps(plugin_manifest(source, vendor), indent=2, ensure_ascii=False) + '\n')
    (plugin_dir / 'VENDOR.sha256').write_text(tree_digest(plugin_dir) + '\n')


def tree_drift(plugin_dir, vendor):
    """-> how the committed plugin differs from what VENDOR.json says (no network)."""
    drift = []
    manifest_path = plugin_dir / '.claude-plugin' / 'plugin.json'
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    if manifest.get('version') != vendor['version']:
        drift.append(f"plugin.json version {manifest.get('version')} != VENDOR.json {vendor['version']}")
    if 'hooks' in manifest:
        drift.append('plugin.json declares hooks')
    for name in NOT_VENDORED:
        if (plugin_dir / name).exists():
            drift.append(f'{name}/ is present: only skills are vendored')
    if not (plugin_dir / 'LICENSE').is_file():
        drift.append('LICENSE is missing')
    skills = plugin_dir / 'skills'
    present = {p.name for p in skills.iterdir() if p.is_dir()} if skills.is_dir() else set()
    for name in sorted(set(vendor['active']) | set(vendor['userOnly']) | present):
        skill_md = skills / name / 'SKILL.md'
        if name not in present or not skill_md.is_file():
            drift.append(f'skills/{name}/SKILL.md is missing')
        elif name not in vendor['active'] and name not in vendor['userOnly']:
            drift.append(f'skills/{name} is not classified in VENDOR.json')
        else:
            flagged = FLAG in frontmatter(skill_md.read_text(), f'skills/{name}/SKILL.md')[0]
            if flagged != (name in vendor['userOnly']):
                drift.append(f"skills/{name}: {'has' if flagged else 'lacks'} `{FLAG}` but VENDOR.json lists it "
                             f"as {'userOnly' if name in vendor['userOnly'] else 'active'}")
    recorded = plugin_dir / 'VENDOR.sha256'
    if not drift and (not recorded.is_file() or recorded.read_text().strip() != tree_digest(plugin_dir)):
        drift.append('the vendored files do not match VENDOR.sha256: they were edited after vendoring '
                     '(run the script again and review the diff)')
    return drift


def option(argv, flag, default=None):
    if flag not in argv:
        return default
    if argv.index(flag) + 1 >= len(argv):
        raise ValueError(f'{flag} needs a value')
    return argv[argv.index(flag) + 1]


def main(argv):
    try:
        plugin_dir = Path(option(argv, '--plugin-dir', REPO / 'plugins' / 'agent-skills')).resolve()
        vendor = load_vendor(plugin_dir)
        if '--check' in argv:
            drift = tree_drift(plugin_dir, vendor)
            for line in drift:
                print(line)
            print('OK: the vendored tree matches VENDOR.json' if not drift else f'DRIFT: {len(drift)} item(s)')
            return 1 if drift else 0
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(option(argv, '--source') or download(vendor, tmp)).resolve()
            vendor_tree(source, plugin_dir, vendor)
        drift = tree_drift(plugin_dir, vendor)
        for line in drift:
            print(line)
        print(f"vendored {vendor['repo']} {vendor['version']} ({vendor['commit'][:12]}): "
              f"{len(vendor['active'])} active, {len(vendor['userOnly'])} user-only skill(s)")
        return 2 if drift else 0
    except (Refused, OSError, ValueError, KeyError) as e:
        print(f'ERROR: {e}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
