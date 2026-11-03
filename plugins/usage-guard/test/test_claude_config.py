"""Tests for scripts/claude_config.py, the helpers shared by doctor, apply, prompt_audit and claude_mem."""
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "scripts"))

import claude_config as cc  # noqa: E402


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


class ConfigDirTest(unittest.TestCase):
    def test_env_is_read_at_call_time(self):
        with mock.patch.dict(os.environ, {"CLAUDE_CONFIG_DIR": "/tmp/x-cfg"}):
            self.assertEqual(cc.config_dir(), "/tmp/x-cfg")
        with mock.patch.dict(os.environ):
            os.environ.pop("CLAUDE_CONFIG_DIR", None)
            self.assertEqual(cc.config_dir(), os.path.expanduser("~/.claude"))


class JsonTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def test_read_json_defaults_and_strictness(self):
        missing = os.path.join(self.tmp, "nope.json")
        self.assertIsNone(cc.read_json(missing))
        self.assertEqual(cc.read_json(missing, {}), {})
        bad = os.path.join(self.tmp, "bad.json")
        write(bad, "{not json")
        self.assertEqual(cc.read_json(bad, {}), {})
        with self.assertRaises(ValueError):
            cc.read_json(bad, strict=True)
        good = os.path.join(self.tmp, "good.json")
        write(good, '{"a": 1}')
        self.assertEqual(cc.read_json(good), {"a": 1})

    def test_write_json_with_backup(self):
        path = os.path.join(self.tmp, "settings.json")
        self.assertIsNone(cc.write_json_with_backup(path, {"a": "é"}))
        with open(path, encoding="utf-8") as f:
            text = f.read()
        self.assertTrue(text.endswith("\n"))
        self.assertIn("é", text)
        self.assertEqual(json.loads(text), {"a": "é"})
        bak = cc.write_json_with_backup(path, {"a": 2})
        self.assertTrue(bak.startswith(path + ".bak-"))
        self.assertEqual(cc.read_json(bak), {"a": "é"})
        self.assertEqual(cc.read_json(path), {"a": 2})


class PluginsAndAgentsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.cfg = os.path.join(self.tmp, "cfg")
        self.plug = os.path.join(self.tmp, "plug")
        write(os.path.join(self.plug, "agents", "plugagent.md"), "---\nname: plugagent\nmodel: claude-opus-5-5\n---\n")
        write(os.path.join(self.cfg, "plugins", "installed_plugins.json"), json.dumps({"plugins": {
            "qk@mk": [{"installPath": self.plug}],
            "gone@mk": [{"installPath": os.path.join(self.tmp, "missing")}],
            "off@mk": [{"installPath": self.plug}],
        }}))
        self.settings = {"enabledPlugins": {"qk@mk": True, "gone@mk": True, "off@mk": False}}

    def test_enabled_plugin_dirs_keeps_the_full_name_and_skips_missing_dirs(self):
        self.assertEqual(cc.enabled_plugin_dirs(self.settings, self.cfg), [("qk@mk", self.plug)])

    def test_frontmatter_fields(self):
        p = os.path.join(self.tmp, "a.md")
        write(p, "---\nname: \"critic\"\ndescription: line one\n  line two\nmodel: 'claude-opus-5-5'\n---\nbody\n")
        fm = cc.frontmatter_fields(p)
        self.assertEqual(fm["name"], "critic")
        self.assertEqual(fm["model"], "claude-opus-5-5")
        self.assertEqual(fm["description"], "line one\n  line two")
        self.assertEqual(cc.frontmatter_fields(os.path.join(self.tmp, "missing.md")),
                         {"name": None, "description": "", "model": None})

    def test_costly_agent_pins(self):
        write(os.path.join(self.cfg, "agents", "critic.md"), "---\nname: critic\nmodel: claude-opus-5-5\n---\n")
        write(os.path.join(self.cfg, "agents", "dev.md"), "---\nname: dev\nmodel: sonnet\n---\n")
        write(os.path.join(self.cfg, "agents", "bare.md"), "---\nname: bare\n---\n")
        files, costly = cc.costly_agent_pins(self.cfg, self.settings)
        self.assertEqual(len(files), 4)
        self.assertEqual(costly, [("critic", "claude-opus-5-5"), ("plugagent", "claude-opus-5-5")])


if __name__ == "__main__":
    unittest.main()
