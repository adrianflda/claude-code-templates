#!/usr/bin/env python3
"""Install (or check) the agentic tooling from this repo on a machine.

  python3 -I agentic-env/install.py            install / update, idempotent
  python3 -I agentic-env/install.py --check    report drift only, change nothing
  --no-plugins                                 skip the `claude plugin` and git-gate steps

What it installs is listed in agentic-env/manifest.json: agents, skills and commands from
cli-tool/components, the hooks in agentic-env/hooks (wired into ~/.claude/settings.json), the
plugins of this repo's marketplace, and the pre-push review gate in the global git config.
It never deletes anything and never writes anything that is not in the manifest.

Exit: 0 everything in place · 1 drift found (--check) · 2 a step failed.
"""
import filecmp
import json
import os
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


def check(with_plugins):
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
    return drift


def install(with_plugins):
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
        step(['node', str(GIT_HOOK)])
    print(f'done: {copied} file(s) updated. Restart Claude Code to load them.')


def step(cmd):
    print('run       ' + ' '.join(cmd))
    r = run(cmd)
    if r.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd)} failed ({r.returncode}): {(r.stderr or r.stdout).strip()}")


def main(argv):
    with_plugins = '--no-plugins' not in argv
    try:
        if '--check' in argv:
            drift = check(with_plugins)
            for d in drift:
                print(d)
            print('OK: in sync with the repo' if not drift else f'DRIFT: {len(drift)} item(s)')
            return 1 if drift else 0
        install(with_plugins)
        drift = check(with_plugins)
        for d in drift:
            print(d)
        return 2 if drift else 0
    except (RuntimeError, OSError, ValueError) as e:
        print(f'ERROR: {e}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
