"""Tests for scripts/prompt_audit.py against a fake config dir and fake transcripts."""
import importlib
import json
import os
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "scripts"))


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def tool_use(name, inp, mid):
    return json.dumps({"type": "assistant", "message": {"id": mid, "content": [
        {"type": "tool_use", "id": f"tu_{mid}", "name": name, "input": inp}]}})


class PromptAuditTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.cfg = os.path.join(self.tmp, "cfg")
        os.environ["CLAUDE_CONFIG_DIR"] = self.cfg
        import prompt_audit
        self.pa = importlib.reload(prompt_audit)
        old = time.time() - 30 * 86400
        write(os.path.join(self.cfg, "skills", "used-skill", "SKILL.md"), "---\nname: used-skill\ndescription: a used skill\n---\n")
        write(os.path.join(self.cfg, "skills", "idle-skill", "SKILL.md"), "---\nname: idle-skill\ndescription: never used\n---\n")
        write(os.path.join(self.cfg, "commands", "typed-cmd.md"), "---\ndescription: typed by the user\n---\n")
        write(os.path.join(self.cfg, "commands", "idle-cmd.md"), "---\ndescription: never typed\n---\n")
        write(os.path.join(self.cfg, "agents", "busy-agent.md"), "---\nname: busy-agent\ndescription: used agent\n---\n")
        write(os.path.join(self.cfg, "agents", "idle-agent.md"), "---\nname: idle-agent\ndescription: unused agent\n---\n")
        plug = os.path.join(self.tmp, "plug")
        write(os.path.join(plug, "skills", "forge", "SKILL.md"), "---\nname: forge\ndescription: plugin skill\n---\n")
        write(os.path.join(plug, "skills", "idle-plugin-skill", "SKILL.md"), "---\nname: idle-plugin-skill\ndescription: x\n---\n")
        write(os.path.join(self.cfg, "plugins", "installed_plugins.json"),
              json.dumps({"plugins": {"qk@mk": [{"installPath": plug}]}}))
        self.settings = {"enabledPlugins": {"qk@mk": True}, "skillOverrides": {"already": "off"}}
        write(os.path.join(self.cfg, "settings.json"), json.dumps(self.settings))
        # make everything "old" so the grace period does not hide it
        for root, _, files in os.walk(self.cfg):
            for f in files:
                os.utime(os.path.join(root, f), (old, old))
        self.root = os.path.join(self.tmp, "projects")
        lines = [
            tool_use("Skill", {"skill": "used-skill"}, "m1"),
            tool_use("Skill", {"skill": "used-skill"}, "m1"),  # duplicate id, counted once
            tool_use("Skill", {"skill": "forge"}, "m2"),  # bare name resolves to the plugin skill
            tool_use("Agent", {"subagent_type": "busy-agent"}, "m3"),
            tool_use("Skill", {"skill": "anthropic-skills:docs"}, "m4"),
            json.dumps({"type": "user", "message": {"content": "<command-name>/typed-cmd</command-name>"}}),
            "not json at all",
        ]
        write(os.path.join(self.root, "p", "s1.jsonl"), "\n".join(lines) + "\n")
        stale = os.path.join(self.root, "p", "old.jsonl")
        write(stale, tool_use("Skill", {"skill": "idle-skill"}, "m9") + "\n")
        os.utime(stale, (old - 86400, old - 86400))

    def run_audit(self, **kw):
        # files are born "now"; a clock 10 days ahead keeps them outside the 7-day grace period
        kw.setdefault("now", time.time() + 10 * 86400)
        return self.pa.audit(self.settings, self.tmp, self.root, 30, **kw)

    def test_usage_counts_and_dedupe(self):
        counts, files = self.pa.usage(self.root, 30)
        self.assertEqual(files, 1)
        self.assertEqual(counts["skill"]["used-skill"], 1)
        self.assertEqual(counts["agent"]["busy-agent"], 1)
        self.assertEqual(counts["command"]["typed-cmd"], 1)
        self.assertNotIn("idle-skill", counts["skill"])

    def test_suggestions_default_mode(self):
        res = self.run_audit()
        sug = res["suggested_skill_overrides"]
        self.assertEqual(set(sug), {"idle-skill", "idle-cmd", "qk:idle-plugin-skill"})
        self.assertTrue(all(v == "user-invocable-only" for v in sug.values()))
        by = {it["name"]: it for it in res["items"]}
        self.assertEqual(by["qk:forge"]["uses"], 1)
        self.assertEqual(by["typed-cmd"]["uses"], 1)
        self.assertEqual(by["idle-agent"]["uses"], 0)
        self.assertEqual(res["synced_used"], ["anthropic-skills:docs"])

    def test_mode_off_and_grace(self):
        res = self.run_audit(mode="off")
        self.assertEqual(res["suggested_skill_overrides"]["idle-skill"], "off")
        # APFS lowers the birth time when utime sets an older mtime, so recreate the file to make it born now
        f = os.path.join(self.cfg, "skills", "idle-skill", "SKILL.md")
        os.remove(f)
        write(f, "---\nname: idle-skill\ndescription: never used\n---\n")
        res = self.run_audit(now=time.time(), grace=7)
        res_items = {it["name"]: it for it in res["items"]}
        self.assertTrue(res_items["idle-skill"]["new"])
        self.assertNotIn("idle-skill", res["suggested_skill_overrides"])
        self.assertIn("idle-cmd", res["suggested_skill_overrides"])

    def test_apply_merges_and_backs_up(self):
        path = os.path.join(self.cfg, "settings.json")
        res = self.run_audit()
        n = self.pa.apply_overrides(path, self.settings, res["suggested_skill_overrides"])
        self.assertEqual(n, 3)
        saved = json.load(open(path))
        self.assertEqual(saved["skillOverrides"]["already"], "off")
        self.assertEqual(saved["skillOverrides"]["idle-cmd"], "user-invocable-only")
        self.assertTrue(any(f.startswith("settings.json.bak-") for f in os.listdir(self.cfg)))

    def test_main_json_runs(self):
        import io
        from contextlib import redirect_stdout
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = self.pa.main(["--json", "--cwd", self.tmp, "--root", self.root])
        self.assertEqual(rc, 0)
        self.assertIn("suggested_skill_overrides", json.loads(buf.getvalue()))


if __name__ == "__main__":
    unittest.main()
