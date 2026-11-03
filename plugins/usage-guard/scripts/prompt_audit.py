#!/usr/bin/env python3
"""Prompt audit: what is loaded into every request versus what was actually used.

Inventories agents and skills (user, project and enabled plugins), estimates the
tokens their descriptions add to every request and every subagent, counts the
invocations found in the transcripts of the last N days (Skill tool, Agent tool,
typed slash commands) and prints the unused ones with a ready-to-paste
``skillOverrides`` block. ``--apply`` merges that block into settings.json after
backing it up; nothing else is ever written.

Override values (verified in the Claude Code 2.1.316 binary): ``on``, ``off``,
``user-invocable-only`` (hidden from the model, so its description leaves the
prompt, but ``/name`` still works). The default suggestion is
``user-invocable-only`` because it cannot break anything; ``--mode off`` removes
the skill entirely. Keys are the skill name, prefixed with ``plugin:`` for plugin
skills. Skills whose file is younger than ``--grace`` days are never suggested,
nor is any skill named with ``--keep`` (one a CLAUDE.md declares mandatory).

    python3 -I prompt_audit.py --days 30
    python3 -I prompt_audit.py --days 30 --json
    python3 -I prompt_audit.py --apply [--mode off] [--keep epistemic-discipline]
"""
import argparse
import glob
import json
import os
import re
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import claude_config as cc  # noqa: E402

SYNCED_PREFIX = "anthropic-skills:"


def frontmatter(path):
    """Return (name, description) from a markdown frontmatter, with fallbacks."""
    fm = cc.frontmatter_fields(path)
    return fm["name"], fm["description"]


def enabled_plugin_dirs(settings):
    """Enabled plugins as (name without the marketplace suffix, install dir)."""
    return [(name.split("@")[0], p) for name, p in cc.enabled_plugin_dirs(settings)]


def add_item(items, kind, name, path, scope):
    if any(it["kind"] == kind and it["name"] == name for it in items):
        return  # a skill and a command with the same name are one skill to Claude Code
    fm_name, desc = frontmatter(path)
    try:
        st = os.stat(path)
        born = getattr(st, "st_birthtime", st.st_mtime)
    except OSError:
        born = 0
    items.append({"kind": kind, "name": name, "path": path, "scope": scope, "born": born,
                  "tokens": max(len(desc) // 4, 25), "desc": desc[:80].replace("\n", " ")})


def inventory(settings, cwd):
    items = []
    roots = [("user", cc.config_dir()), ("project", os.path.join(cwd, ".claude"))]
    for scope, root in roots:
        for p in sorted(glob.glob(os.path.join(root, "agents", "*.md"))):
            add_item(items, "agent", frontmatter(p)[0] or os.path.splitext(os.path.basename(p))[0], p, scope)
        for p in sorted(glob.glob(os.path.join(root, "skills", "*", "SKILL.md"))):
            add_item(items, "skill", os.path.basename(os.path.dirname(p)), p, scope)
        for p in sorted(glob.glob(os.path.join(root, "commands", "*.md"))):
            add_item(items, "skill", os.path.splitext(os.path.basename(p))[0], p, scope)
    for plugin, d in enabled_plugin_dirs(settings):
        for p in sorted(glob.glob(os.path.join(d, "agents", "*.md"))):
            add_item(items, "agent", f"{plugin}:{frontmatter(p)[0] or os.path.splitext(os.path.basename(p))[0]}", p, plugin)
        for p in sorted(glob.glob(os.path.join(d, "skills", "*", "SKILL.md"))):
            add_item(items, "skill", f"{plugin}:{os.path.basename(os.path.dirname(p))}", p, plugin)
        for p in sorted(glob.glob(os.path.join(d, "commands", "*.md"))):
            add_item(items, "skill", f"{plugin}:{os.path.splitext(os.path.basename(p))[0]}", p, plugin)
    return items


SKILL_RE = re.compile(r'"name":\s*"Skill"')
AGENT_RE = re.compile(r'"name":\s*"Agent"')
CMD_RE = re.compile(r"<command-name>/?([^<]+)</command-name>")


def usage(root, days):
    """Counts of skill / agent / command invocations in transcripts touched in the last N days."""
    cutoff = time.time() - days * 86400
    counts = {"skill": {}, "agent": {}, "command": {}}
    seen = set()
    files = 0
    for path in glob.iglob(os.path.join(root, "**", "*.jsonl"), recursive=True):
        try:
            if os.path.getmtime(path) < cutoff:
                continue
            f = open(path, encoding="utf-8", errors="replace")
        except OSError:
            continue
        files += 1
        with f:
            for line in f:
                if "<command-name>" in line:
                    for m in CMD_RE.finditer(line):
                        name = m.group(1).strip()
                        counts["command"][name] = counts["command"].get(name, 0) + 1
                    continue
                if not (SKILL_RE.search(line) or AGENT_RE.search(line)):
                    continue
                try:
                    d = json.loads(line)
                except ValueError:
                    continue
                if d.get("type") != "assistant":
                    continue
                msg = d.get("message") or {}
                content = msg.get("content") if isinstance(msg.get("content"), list) else []
                for block in content:
                    if block.get("type") != "tool_use":
                        continue
                    key = (msg.get("id"), block.get("id"))
                    if key in seen:
                        continue
                    seen.add(key)
                    inp = block.get("input") or {}
                    if block.get("name") == "Skill" and inp.get("skill"):
                        counts["skill"][inp["skill"]] = counts["skill"].get(inp["skill"], 0) + 1
                    elif block.get("name") == "Agent" and inp.get("subagent_type"):
                        counts["agent"][inp["subagent_type"]] = counts["agent"].get(inp["subagent_type"], 0) + 1
    return counts, files


def uses_for(item, counts):
    """Invocations matching this item by full name or by the part after the plugin prefix."""
    names = {item["name"]}
    if ":" in item["name"]:
        names.add(item["name"].split(":", 1)[1])
    n = 0
    table = counts["agent"] if item["kind"] == "agent" else counts["skill"]
    for name, c in table.items():
        if name in names or (":" in name and name.split(":", 1)[1] in names and item["scope"] not in ("user", "project")):
            n += c
    if item["kind"] == "skill":
        for name, c in counts["command"].items():
            if name in names:
                n += c
    return n


def audit(settings, cwd, root, days, mode="user-invocable-only", grace=7, now=None, keep=()):
    keep = set(keep or ())
    items = inventory(settings, cwd)
    counts, files = usage(root, days)
    overrides = settings.get("skillOverrides") or {}
    now = now or time.time()
    for it in items:
        it["uses"] = uses_for(it, counts)
        it["off"] = overrides.get(it["name"]) in ("off", "user-invocable-only")
        it["new"] = it["born"] > now - grace * 86400
    known = {it["name"] for it in items} | {it["name"].split(":", 1)[1] for it in items if ":" in it["name"]}
    unknown = sorted(n for n in list(counts["skill"]) + list(counts["agent"]) if n not in known
                     and not (":" in n and n.split(":", 1)[1] in known))
    synced_used = sorted(n for n in counts["skill"] if n.startswith(SYNCED_PREFIX))
    suggested = {it["name"]: mode for it in items
                 if it["kind"] == "skill" and it["uses"] == 0 and not it["off"] and not it["new"]
                 and it["name"] not in keep and it["name"].split(":", 1)[-1] not in keep}
    return {"days": days, "files": files, "mode": mode, "items": items, "unknown": unknown, "synced_used": synced_used,
            "suggested_skill_overrides": suggested,
            "loaded_tokens": sum(it["tokens"] for it in items if not it["off"]),
            "unused_tokens": sum(it["tokens"] for it in items if it["uses"] == 0 and not it["off"])}


def print_report(res):
    items = res["items"]
    for kind in ("agent", "skill"):
        rows = [it for it in items if it["kind"] == kind]
        used = [it for it in rows if it["uses"]]
        print(f"\n{kind}s: {len(rows)} loaded, {len(used)} used in {res['days']} days ({res['files']} transcript files)")
        print(f"  {'uses':>4}  {'~tok':>5}  {'scope':<16} name")
        for it in sorted(rows, key=lambda r: (-r["uses"], -r["tokens"])):
            flag = " (off)" if it["off"] else (" (new)" if it["new"] else "")
            print(f"  {it['uses']:>4}  {it['tokens']:>5}  {it['scope']:<16} {it['name']}{flag}")
    print(f"\ndescriptions loaded on every request: ≈{res['loaded_tokens']:,} tokens; never used in window: ≈{res['unused_tokens']:,}")
    if res["synced_used"]:
        print("synced skills used (not on disk, managed from claude.ai): " + ", ".join(res["synced_used"]))
    if res["unknown"]:
        print("invoked but not in the inventory (removed, renamed or built-in): " + ", ".join(res["unknown"]))
    unused_agents = [it["name"] for it in items if it["kind"] == "agent" and it["uses"] == 0]
    if unused_agents:
        print(f"\nagents never invoked ({len(unused_agents)}): move their files out of agents/ to drop them from the prompt:")
        for it in items:
            if it["kind"] == "agent" and it["uses"] == 0:
                print(f"  {it['path']}")
    if res["suggested_skill_overrides"]:
        what = "hidden from the model, /name still works" if res["mode"] == "user-invocable-only" else "removed entirely"
        print(f"\nsuggested skillOverrides, value {res['mode']!r} ({what}); merge into ~/.claude/settings.json or run with --apply:")
        print(json.dumps({"skillOverrides": res["suggested_skill_overrides"]}, indent=2))
    else:
        print("\nno unused skills to turn off")


def apply_overrides(settings_path, settings, suggested):
    if not suggested:
        return 0
    settings.setdefault("skillOverrides", {}).update(suggested)
    cc.write_json_with_backup(settings_path, settings)
    return len(suggested)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--days", type=int, default=30)
    ap.add_argument("--cwd", default=os.getcwd())
    ap.add_argument("--root", default=os.path.join(cc.config_dir(), "projects"))
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--mode", choices=["user-invocable-only", "off"], default="user-invocable-only",
                    help="override value to suggest (default keeps /name usable)")
    ap.add_argument("--grace", type=int, default=7, help="skip skills whose file is younger than this many days")
    ap.add_argument("--apply", action="store_true", help="merge the suggested skillOverrides into settings.json (backup kept)")
    ap.add_argument("--keep", action="append", default=[], metavar="NAME",
                    help="never suggest this skill (repeatable; a plugin skill by its full or bare name)")
    args = ap.parse_args(argv)
    settings_path = os.path.join(cc.config_dir(), "settings.json")
    # --apply writes settings.json back: a broken file must stop here, never be replaced by the merge
    settings = cc.read_json(settings_path, {}, strict=args.apply) or {}
    res = audit(settings, args.cwd, args.root, args.days, mode=args.mode, grace=args.grace, keep=args.keep)
    if args.json:
        print(json.dumps(res, indent=2))
    else:
        print_report(res)
    if args.apply:
        n = apply_overrides(settings_path, settings, res["suggested_skill_overrides"])
        print(f"\napplied: {n} skill(s) set to {args.mode!r} in {settings_path}; restart sessions to see the effect")
    return 0


if __name__ == "__main__":
    sys.exit(main())
