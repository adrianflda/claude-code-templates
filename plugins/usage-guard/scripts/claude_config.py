#!/usr/bin/env python3
"""Helpers shared by the usage-guard scripts: where the Claude Code config
lives, JSON files written with a backup, the enabled plugins and the agent
frontmatter.

Everything resolves ``CLAUDE_CONFIG_DIR`` at call time, so a caller or a test
can point the scripts at another directory without reloading modules. Stdlib
only, no network, no subprocesses.
"""
import glob
import json
import os
import re
import shutil
import time

COSTLY_MODELS = ("opus", "fable", "mythos")


def config_dir():
    """``$CLAUDE_CONFIG_DIR`` or ``~/.claude``, read when called."""
    return os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")


def read_json(path, default=None, strict=False):
    """Parse a JSON file. A missing or unreadable file gives ``default``; so does
    an invalid one, unless ``strict`` is set: then it raises ``ValueError`` so a
    broken settings file is never silently replaced by a write."""
    try:
        with open(path, encoding="utf-8") as f:
            text = f.read()
    except OSError:
        return default
    try:
        return json.loads(text)
    except ValueError:
        if strict:
            raise
        return default


def write_json_with_backup(path, data):
    """Write ``data`` as indented UTF-8 JSON, first copying an existing file to
    ``<path>.bak-<timestamp>``. Returns the backup path, or None when there was
    nothing to back up."""
    backup = None
    if os.path.exists(path):
        backup = f"{path}.bak-{time.strftime('%Y%m%d-%H%M%S')}"
        shutil.copy2(path, backup)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")
    return backup


def enabled_plugin_dirs(settings, config=None):
    """``[(name as written in enabledPlugins, install dir)]`` for the enabled
    plugins whose install dir exists."""
    config = config or config_dir()
    installed = (read_json(os.path.join(config, "plugins", "installed_plugins.json"), {}) or {}).get("plugins") or {}
    dirs = []
    for name, on in (settings.get("enabledPlugins") or {}).items():
        if not on:
            continue
        for entry in installed.get(name) or []:
            p = (entry or {}).get("installPath")
            if p and os.path.isdir(p):
                dirs.append((name, p))
    return dirs


def frontmatter_fields(path, limit=6000):
    """``{"name", "description", "model"}`` from a markdown frontmatter: name and
    model without quotes (None when absent), description with its continuation
    lines ('' when absent)."""
    out = {"name": None, "description": "", "model": None}
    try:
        with open(path, encoding="utf-8") as f:
            head = f.read(limit)
    except OSError:
        return out
    m = re.search(r"^name:\s*(.+?)\s*$", head, re.M)
    if m:
        out["name"] = m.group(1).strip('"').strip("'")
    m = re.search(r"^model:\s*([^\s#]+)", head, re.M)
    if m:
        out["model"] = m.group(1).strip('"').strip("'")
    m = re.search(r"^description:\s*(.+?)(?=^\w[\w-]*:|^---)", head, re.M | re.S)
    if m:
        out["description"] = m.group(1).strip()
    return out


def agent_files(config=None, settings=None):
    """Every agent definition the model is offered: ``<config>/agents/*.md`` plus
    the ``agents/`` of the enabled plugins."""
    config = config or config_dir()
    if settings is None:
        settings = read_json(os.path.join(config, "settings.json"), {}) or {}
    files = sorted(glob.glob(os.path.join(config, "agents", "*.md")))
    for _, d in enabled_plugin_dirs(settings, config):
        files += sorted(glob.glob(os.path.join(d, "agents", "*.md")))
    return files


def costly_agent_pins(config=None, settings=None):
    """``(agent files, [(agent name, model)])`` for the agents pinned to an
    Opus / Fable / Mythos model, sorted by name. The name is the frontmatter
    ``name:`` (what the Agent tool uses), else the file stem."""
    files = agent_files(config, settings)
    costly = []
    for p in files:
        fm = frontmatter_fields(p)
        model = fm["model"]
        if model and any(x in model.lower() for x in COSTLY_MODELS):
            costly.append((fm["name"] or os.path.basename(p)[:-3], model))
    return files, sorted(costly)
