#!/usr/bin/env python3
"""Pause, resume and re-route the claude-mem observer (plan phase 4).

claude-mem summarizes every tool call with a model call of its own. With
``CLAUDE_MEM_PROVIDER=claude`` and the ``cli`` auth method those calls use the
Claude Code OAuth token, so they count against the subscription's 5-hour and
7-day limits (the worker's /api/health reports the token it runs on).

    python3 -I claude_mem.py status
    python3 -I claude_mem.py pause                       # the observer skips every project
    python3 -I claude_mem.py resume                      # restore the previous exclusion list
    python3 -I claude_mem.py provider gemini             # key must already be in settings.json
    python3 -I claude_mem.py provider claude --model haiku

How pause works. Every claude-mem hook (PostToolUse observation, PreToolUse
file context, FileEdit, Stop summary, session init) is a fresh process that
reads ``~/.claude-mem/settings.json`` and skips the project when its cwd
matches a glob in ``CLAUDE_MEM_EXCLUDED_PROJECTS`` (anchored; ``**`` matches
every path). ``pause`` first keeps the previous value in
``<dir>/usage-guard-pause.json``, then sets that key to ``**``; ``resume`` puts
it back and removes the file (a pause file without ``**`` in the settings is
stale and is just removed). It takes effect in running sessions too, keeps the
worker and the memory search tools up, and touches no plugin file. The session-start context injection makes no model
call and keeps working.

``provider`` writes ``CLAUDE_MEM_PROVIDER`` (and that provider's model with
``--model``), refuses gemini / openrouter while the provider's API key is empty
in settings.json, and restarts the worker so it picks the change up. API keys
are never taken from the command line, never printed and never written by this
script: put them in ``~/.claude-mem/settings.json`` by hand.

Every write first copies settings.json to ``settings.json.bak-<timestamp>``.
"""
import argparse
import json
import os
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from apply import restart_claude_mem_worker  # noqa: E402
from claude_config import write_json_with_backup  # noqa: E402

PAUSE_PATTERN = "**"
PAUSE_FILE = "usage-guard-pause.json"
PROVIDERS = ("claude", "gemini", "openrouter")
MODEL_KEY = {
    "claude": "CLAUDE_MEM_MODEL",
    "gemini": "CLAUDE_MEM_GEMINI_MODEL",
    "openrouter": "CLAUDE_MEM_OPENROUTER_MODEL",
}
KEY_KEY = {"gemini": "CLAUDE_MEM_GEMINI_API_KEY", "openrouter": "CLAUDE_MEM_OPENROUTER_API_KEY"}


def default_dir():
    return os.path.expanduser("~/.claude-mem")


def settings_path(mem_dir):
    return os.path.join(mem_dir, "settings.json")


def load(mem_dir):
    path = settings_path(mem_dir)
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def save(mem_dir, data):
    write_json_with_backup(settings_path(mem_dir), data)


def pause_file(mem_dir):
    return os.path.join(mem_dir, PAUSE_FILE)


def is_paused(mem_dir, mem):
    """Paused means the catch-all is in the settings the hooks read; the sidecar alone proves nothing."""
    excluded = (mem.get("CLAUDE_MEM_EXCLUDED_PROJECTS") or "").strip()
    return PAUSE_PATTERN in [p.strip() for p in excluded.split(",")]


def worker_health(mem, timeout=2.0):
    """The worker's /api/health as a dict, or None when it does not answer."""
    host = mem.get("CLAUDE_MEM_WORKER_HOST") or "127.0.0.1"
    port = mem.get("CLAUDE_MEM_WORKER_PORT") or str(37700 + (os.getuid() if hasattr(os, "getuid") else 77) % 100)
    try:
        with urllib.request.urlopen(f"http://{host}:{port}/api/health", timeout=timeout) as r:
            return json.load(r)
    except (OSError, ValueError):
        return None


def status(mem_dir, mem, health=None):
    """Status lines: provider, model, auth, pause state and the worker."""
    provider = mem.get("CLAUDE_MEM_PROVIDER") or "claude"
    lines = [
        f"provider: {provider}",
        f"model: {mem.get(MODEL_KEY.get(provider, 'CLAUDE_MEM_MODEL')) or '(default)'}",
        f"auth: {mem.get('CLAUDE_MEM_CLAUDE_AUTH_METHOD') or '(default)'}"
        + (" (counts against the subscription)" if provider == "claude" and mem.get("CLAUDE_MEM_CLAUDE_AUTH_METHOD") in (None, "", "cli", "subscription") else ""),
    ]
    for name, key in KEY_KEY.items():
        lines.append(f"{name} key: {'set' if (mem.get(key) or '').strip() else 'empty'}")
    excluded = mem.get("CLAUDE_MEM_EXCLUDED_PROJECTS") or ""
    lines.append(f"paused: {'yes' if is_paused(mem_dir, mem) else 'no'} (CLAUDE_MEM_EXCLUDED_PROJECTS={excluded!r})")
    if health is None:
        health = worker_health(mem)
    if health:
        ai = health.get("ai") or {}
        lines.append(f"worker: up, v{health.get('version', '?')}, pid {health.get('pid', '?')}, provider {ai.get('provider', '?')}, "
                     f"auth {ai.get('authMethod', '?')}")
    else:
        lines.append("worker: not answering (it starts with the next session)")
    return lines


def pause(mem_dir, mem):
    if is_paused(mem_dir, mem):
        return 0, ["claude-mem is already paused"]
    previous = mem.get("CLAUDE_MEM_EXCLUDED_PROJECTS") or ""
    # Sidecar first: the previous list is on disk before anything is paused. If the sidecar
    # cannot be written nothing changes; if the settings write fails the sidecar is removed
    # again, so there is never a pause without its sidecar nor a sidecar without a pause.
    path = pause_file(mem_dir)
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"paused_at": time.strftime("%Y-%m-%dT%H:%M:%S"), "previous": previous}, f, indent=2)
        f.write("\n")
    mem["CLAUDE_MEM_EXCLUDED_PROJECTS"] = PAUSE_PATTERN
    try:
        save(mem_dir, mem)
    except BaseException:
        mem["CLAUDE_MEM_EXCLUDED_PROJECTS"] = previous
        try:
            os.remove(path)
        except OSError:
            pass
        raise
    return 0, [f"claude-mem paused: CLAUDE_MEM_EXCLUDED_PROJECTS={PAUSE_PATTERN!r} (was {previous!r})",
               "the hooks skip every project from the next tool call on, in running sessions too",
               "memory search and the session context keep working; `resume` restores the list"]


def resume(mem_dir, mem):
    path = pause_file(mem_dir)
    sidecar = os.path.exists(path)
    if not is_paused(mem_dir, mem):
        if sidecar:
            os.remove(path)  # left behind by an interrupted pause or a hand edit: nothing to restore
            return 0, ["claude-mem is not paused (stale pause file removed)"]
        return 0, ["claude-mem is not paused"]
    previous = ""
    if sidecar:
        with open(path, encoding="utf-8") as f:
            previous = (json.load(f).get("previous") or "")
    mem["CLAUDE_MEM_EXCLUDED_PROJECTS"] = previous
    save(mem_dir, mem)  # settings first: a failed write keeps the sidecar, so a retry still has the list
    if sidecar:
        os.remove(path)
    return 0, [f"claude-mem resumed: CLAUDE_MEM_EXCLUDED_PROJECTS={previous!r}"]


def set_provider(mem_dir, mem, name, model=None, restart=True):
    if name not in PROVIDERS:
        return 2, [f"unknown provider {name!r}; use one of {', '.join(PROVIDERS)}"]
    key = KEY_KEY.get(name)
    if key and not (mem.get(key) or "").strip():
        return 2, [f"{key} is empty in {settings_path(mem_dir)}: paste the key there first (this script never writes keys)"]
    changes = []
    if mem.get("CLAUDE_MEM_PROVIDER") != name:
        changes.append(f"CLAUDE_MEM_PROVIDER: {mem.get('CLAUDE_MEM_PROVIDER')!r} -> {name!r}")
        mem["CLAUDE_MEM_PROVIDER"] = name
    if model and mem.get(MODEL_KEY[name]) != model:
        changes.append(f"{MODEL_KEY[name]}: {mem.get(MODEL_KEY[name])!r} -> {model!r}")
        mem[MODEL_KEY[name]] = model
    if not changes:
        return 0, [f"claude-mem already on {name}" + (f" / {model}" if model else "")]
    save(mem_dir, mem)
    lines = ["claude-mem settings updated:"] + [f"  {c}" for c in changes]
    if restart:
        lines.append(restart_claude_mem_worker())
    else:
        lines.append("restart the worker so it picks the change up")
    return 0, lines


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dir", default=default_dir(), help="claude-mem data dir (default ~/.claude-mem)")
    sub = ap.add_subparsers(dest="cmd")
    sub.add_parser("status", help="provider, model, auth, pause state, worker")
    sub.add_parser("pause", help="the observer skips every project; reversible")
    sub.add_parser("resume", help="restore the exclusion list saved by pause")
    p = sub.add_parser("provider", help="switch CLAUDE_MEM_PROVIDER and restart the worker")
    p.add_argument("name", choices=PROVIDERS)
    p.add_argument("--model", help="that provider's model")
    p.add_argument("--no-restart", action="store_true", help="do not restart the worker")
    args = ap.parse_args(argv)

    mem = load(args.dir)
    if mem is None:
        print(f"{settings_path(args.dir)} not found: claude-mem is not installed here")
        return 1
    if args.cmd in (None, "status"):
        code, lines = 0, status(args.dir, mem)
    elif args.cmd == "pause":
        code, lines = pause(args.dir, mem)
    elif args.cmd == "resume":
        code, lines = resume(args.dir, mem)
    else:
        code, lines = set_provider(args.dir, mem, args.name, args.model, restart=not args.no_restart)
    print("\n".join(lines))
    return code


if __name__ == "__main__":
    sys.exit(main())
