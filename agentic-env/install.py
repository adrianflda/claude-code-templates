#!/usr/bin/env python3
"""Install (or check) the agentic tooling from this repo on a machine.

  python3 -I agentic-env/install.py            install / update, idempotent
  python3 -I agentic-env/install.py --check    report drift only, change nothing
  --no-plugins                                 skip the `claude plugin` and git-gate steps
  --no-tools                                   skip the external command-line tools (`uv tool install`)

What it installs is listed in agentic-env/manifest.json: agents, skills and commands from
cli-tool/components, the hooks in agentic-env/hooks (wired into ~/.claude/settings.json), the
plugins of this repo's marketplace, the pre-push review gate in the global git config, and the
external command-line tools the skills call, each at one pinned version.
It never deletes anything and never writes anything that is not in the manifest.

Exit: 0 everything in place · 1 drift found (--check) · 2 a step failed.
"""
import filecmp
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
MANIFEST = json.loads((REPO / 'agentic-env' / 'manifest.json').read_text())
CLAUDE = Path(os.environ.get('HOME', '~')).expanduser() / '.claude'


def files_to_copy():
    """-> [(source, destination)] for every file the manifest ships."""
    pairs = []
    for rel in MANIFEST['agents']:
        pairs.append((REPO / rel, CLAUDE / 'agents' / Path(rel).name))
    for rel in MANIFEST['commands']:
        pairs.append((REPO / rel, CLAUDE / 'commands' / Path(rel).name))
    for rel in MANIFEST['skills']:
        src = REPO / rel
        for f in sorted(p for p in src.rglob('*') if p.is_file()):
            pairs.append((f, CLAUDE / 'skills' / src.name / f.relative_to(src)))
    hooks = REPO / MANIFEST['hookFiles']
    for f in sorted(p for p in hooks.iterdir() if p.is_file() and p.suffix == '.py'):
        pairs.append((f, CLAUDE / 'hooks' / f.name))
    return pairs


def hook_command(entry):
    return f"python3 {CLAUDE / 'hooks' / entry['file']}"


def missing_hooks(settings):
    """-> manifest hook entries not wired in settings (same event, matcher and command)."""
    out = []
    for e in MANIFEST['hooks']:
        groups = (settings.get('hooks') or {}).get(e['event']) or []
        wired = any(g.get('matcher') == e['matcher'] and
                    any(h.get('command') == hook_command(e) for h in g.get('hooks') or [])
                    for g in groups)
        if not wired:
            out.append(e)
    return out


def wire_hooks(settings, entries):
    for e in entries:
        groups = settings.setdefault('hooks', {}).setdefault(e['event'], [])
        group = next((g for g in groups if g.get('matcher') == e['matcher']), None)
        if group is None:
            group = {'matcher': e['matcher']} if e['matcher'] else {}
            group['hooks'] = []
            groups.append(group)
        group['hooks'].append({'type': 'command', 'command': hook_command(e)})


def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True)


def marketplace_entry():
    """-> this repo's marketplace as `claude plugin marketplace list --json` reports it, or None."""
    r = run(['claude', 'plugin', 'marketplace', 'list', '--json'])
    if r.returncode != 0:
        raise RuntimeError(f"claude plugin marketplace list failed: {r.stderr.strip()}")
    return next((m for m in json.loads(r.stdout) if m.get('name') == MANIFEST['marketplace']), None)


def installed_plugins():
    r = run(['claude', 'plugin', 'list', '--json'])
    if r.returncode != 0:
        raise RuntimeError(f"claude plugin list failed: {r.stderr.strip()}")
    return {p['id']: p for p in json.loads(r.stdout)}


def plugin_present(name, installed):
    p = installed.get(f"{name}@{MANIFEST['marketplace']}")
    return bool(p and p.get('enabled'))


def foreign_copies(name, installed):
    """-> enabled ids of `name` from another marketplace: a second copy whose hooks also run, often stale."""
    return sorted(i for i, p in installed.items()
                  if i.split('@')[0] == name and i != f"{name}@{MANIFEST['marketplace']}" and p.get('enabled'))


GIT_HOOK = REPO / 'plugins' / 'pre-push-review' / 'scripts' / 'install-git-hook.mjs'
SAFE_ARGUMENT = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]*$')


def tools():
    """-> the manifest's external tools, after checking that each value is safe to pass to a command."""
    listed = MANIFEST.get('tools', [])
    for tool in listed:
        if not isinstance(tool, dict):
            raise ValueError(f'manifest tool is not an object: {tool!r}')
        for key in ('package', 'version', 'python'):
            if not SAFE_ARGUMENT.match(str(tool.get(key, ''))):
                raise ValueError(f"manifest tool {tool.get('package')!r}: unsafe or missing {key}: {tool.get(key)!r}")
    return listed


def normalized(package):
    """-> the package name the way `uv tool list` prints it (lower case, runs of -_. as one hyphen)."""
    return re.sub(r'[-_.]+', '-', package).lower()


def uv_tools():
    """-> {package: version} of what `uv tool list` reports (its lines read `package v1.2.3`)."""
    r = run(['uv', 'tool', 'list'])
    if r.returncode != 0:
        raise RuntimeError(f"uv tool list failed: {(r.stderr or r.stdout).strip()}")
    found = {}
    for line in r.stdout.splitlines():
        m = re.match(r'^(\S+) v(\S+)', line)
        if m:
            found[normalized(m.group(1))] = m.group(2)
    return found


UV_MISSING = 'uv not found (brew install uv)'


def tool_drift():
    listed = tools()
    if not listed:
        return []
    if not shutil.which('uv'):
        return [f"tool      {t['package']}: {UV_MISSING}" for t in listed]
    installed = uv_tools()
    drift = []
    for t in listed:
        have = installed.get(normalized(t['package']))
        if have is None:
            drift.append(f"tool      {t['package']}=={t['version']} not installed")
        elif have != t['version']:
            drift.append(f"tool      {t['package']} {have} installed, manifest pins {t['version']}")
    return drift


def install_tools():
    """Install each tool that is absent or at another version. A missing prerequisite is skipped
    with the command that provides it; the check that follows the install then reports the tool."""
    listed = tools()
    if listed and not shutil.which('uv'):
        print(f'skip      tools: {UV_MISSING}')
        return
    installed = uv_tools() if listed else {}
    for t in listed:
        have = installed.get(normalized(t['package']))
        if have == t['version']:
            continue
        if run(['uv', 'python', 'find', '--no-python-downloads', t['python']]).returncode != 0:
            print(f"skip      {t['package']}: Python {t['python']} not found (brew install python@{t['python']})")
            continue
        step(['uv', 'tool', 'install', '--no-python-downloads', '--python', t['python']]
             + (['--force'] if have else []) + [f"{t['package']}=={t['version']}"])


def check(with_plugins, with_tools):
    drift = []
    for src, dst in files_to_copy():
        if not dst.exists():
            drift.append(f'missing   {dst}')
        elif not filecmp.cmp(src, dst, shallow=False):
            drift.append(f'differs   {dst}  (repo: {src.relative_to(REPO)})')
    sp = CLAUDE / 'settings.json'
    settings = json.loads(sp.read_text()) if sp.exists() else {}
    for e in missing_hooks(settings):
        drift.append(f"unwired   {e['event']}[{e['matcher'] or '*'}] {hook_command(e)}")
    if with_plugins:
        mkt = marketplace_entry()
        if mkt is None:
            drift.append(f"market    {MANIFEST['marketplace']} not added (claude plugin marketplace add {REPO})")
        elif Path(mkt.get('path') or '').resolve() != REPO:
            drift.append(f"market    {MANIFEST['marketplace']} reads {mkt.get('path') or mkt.get('source')}, "
                         f"not this clone {REPO}")
        installed = installed_plugins()
        for name in MANIFEST['plugins']:
            if not plugin_present(name, installed):
                drift.append(f"plugin    {name}@{MANIFEST['marketplace']} not installed/enabled")
            for other in foreign_copies(name, installed):
                drift.append(f'plugin    {other} also installed: claude plugin uninstall {other}')
        r = run(['node', str(GIT_HOOK), '--check'])
        if r.returncode != 0:
            drift.append(f"git-gate  {(r.stdout + r.stderr).strip().splitlines()[-1:]}")
    if with_tools:
        drift += tool_drift()
    return drift


def install(with_plugins, with_tools):
    copied = 0
    for src, dst in files_to_copy():
        if dst.exists() and filecmp.cmp(src, dst, shallow=False):
            continue
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        copied += 1
        print(f'copied    {dst}')
    sp = CLAUDE / 'settings.json'
    settings = json.loads(sp.read_text()) if sp.exists() else {}
    todo = missing_hooks(settings)
    if todo:
        if sp.exists():
            backup = sp.with_name(f'settings.json.bak-{time.strftime("%Y%m%d-%H%M%S")}')
            shutil.copy2(sp, backup)
            print(f'backup    {backup}')
        wire_hooks(settings, todo)
        sp.parent.mkdir(parents=True, exist_ok=True)
        sp.write_text(json.dumps(settings, indent=2) + '\n')
        for e in todo:
            print(f"wired     {e['event']}[{e['matcher'] or '*'}] {e['file']}")
    if with_plugins:
        mkt = MANIFEST['marketplace']
        if marketplace_entry() is None:
            step(['claude', 'plugin', 'marketplace', 'add', str(REPO)])
        else:
            step(['claude', 'plugin', 'marketplace', 'update', mkt])
        installed = installed_plugins()
        for name in MANIFEST['plugins']:
            ours = installed.get(f'{name}@{mkt}')
            if ours and not ours.get('enabled'):
                step(['claude', 'plugin', 'enable', f'{name}@{mkt}'])
            step(['claude', 'plugin', 'update' if ours else 'install', f'{name}@{mkt}'])
            for other in foreign_copies(name, installed):
                print(f'warning   {other} is also enabled (its hooks run twice): claude plugin uninstall {other}')
        step(['node', str(GIT_HOOK)])
    if with_tools:
        install_tools()
    print(f'done: {copied} file(s) updated. Restart Claude Code to load them.')


def step(cmd):
    print('run       ' + ' '.join(cmd))
    r = run(cmd)
    if r.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd)} failed ({r.returncode}): {(r.stderr or r.stdout).strip()}")


def main(argv):
    with_plugins = '--no-plugins' not in argv
    with_tools = '--no-tools' not in argv
    try:
        if '--check' in argv:
            drift = check(with_plugins, with_tools)
            for d in drift:
                print(d)
            print('OK: in sync with the repo' if not drift else f'DRIFT: {len(drift)} item(s)')
            return 1 if drift else 0
        install(with_plugins, with_tools)
        drift = check(with_plugins, with_tools)
        for d in drift:
            print(d)
        return 2 if drift else 0
    except (RuntimeError, OSError, ValueError) as e:
        print(f'ERROR: {e}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
