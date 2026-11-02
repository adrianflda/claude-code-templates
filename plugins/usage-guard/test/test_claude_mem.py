"""Tests for scripts/claude_mem.py against a temporary claude-mem data dir."""
import glob
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "scripts"))

import claude_mem as cm  # noqa: E402


class ClaudeMemTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.settings = {
            "CLAUDE_MEM_MODEL": "haiku",
            "CLAUDE_MEM_PROVIDER": "claude",
            "CLAUDE_MEM_CLAUDE_AUTH_METHOD": "cli",
            "CLAUDE_MEM_GEMINI_API_KEY": "",
            "CLAUDE_MEM_GEMINI_MODEL": "gemini-2.5-flash-lite",
            "CLAUDE_MEM_OPENROUTER_API_KEY": "",
            "CLAUDE_MEM_OPENROUTER_MODEL": "some/free-model",
            "CLAUDE_MEM_EXCLUDED_PROJECTS": "",
            "CLAUDE_MEM_WORKER_PORT": "1",
        }
        with open(cm.settings_path(self.dir), "w", encoding="utf-8") as f:
            json.dump(self.settings, f)

    def run_cli(self, *argv):
        out = io.StringIO()
        with redirect_stdout(out):
            code = cm.main(["--dir", self.dir, *argv])
        return code, out.getvalue()

    def saved(self):
        return cm.load(self.dir)

    def backups(self):
        return glob.glob(os.path.join(self.dir, "settings.json.bak-*"))

    def test_pause_sets_the_catch_all_and_keeps_the_previous_list(self):
        self.settings["CLAUDE_MEM_EXCLUDED_PROJECTS"] = "~/Projects/secret"
        with open(cm.settings_path(self.dir), "w", encoding="utf-8") as f:
            json.dump(self.settings, f)
        code, out = self.run_cli("pause")
        self.assertEqual(code, 0)
        self.assertIn("paused", out)
        self.assertEqual(self.saved()["CLAUDE_MEM_EXCLUDED_PROJECTS"], "**")
        self.assertEqual(len(self.backups()), 1)
        with open(cm.pause_file(self.dir), encoding="utf-8") as f:
            self.assertEqual(json.load(f)["previous"], "~/Projects/secret")
        # Idempotent: a second pause writes nothing.
        code, out = self.run_cli("pause")
        self.assertEqual(code, 0)
        self.assertIn("already paused", out)
        self.assertEqual(len(self.backups()), 1)

    def test_resume_restores_the_previous_list(self):
        self.settings["CLAUDE_MEM_EXCLUDED_PROJECTS"] = "a/*,b"
        with open(cm.settings_path(self.dir), "w", encoding="utf-8") as f:
            json.dump(self.settings, f)
        self.run_cli("pause")
        code, out = self.run_cli("resume")
        self.assertEqual(code, 0)
        self.assertEqual(self.saved()["CLAUDE_MEM_EXCLUDED_PROJECTS"], "a/*,b")
        self.assertFalse(os.path.exists(cm.pause_file(self.dir)))
        code, out = self.run_cli("resume")
        self.assertIn("not paused", out)

    def test_resume_clears_a_catch_all_written_by_hand(self):
        self.settings["CLAUDE_MEM_EXCLUDED_PROJECTS"] = "**"
        with open(cm.settings_path(self.dir), "w", encoding="utf-8") as f:
            json.dump(self.settings, f)
        code, out = self.run_cli("resume")
        self.assertEqual(code, 0)
        self.assertEqual(self.saved()["CLAUDE_MEM_EXCLUDED_PROJECTS"], "")

    def test_provider_refuses_an_empty_key_and_leaves_settings_alone(self):
        for name in ("gemini", "openrouter"):
            code, out = self.run_cli("provider", name, "--no-restart")
            self.assertEqual(code, 2, name)
            self.assertIn("_API_KEY is empty", out)
        self.assertEqual(self.saved()["CLAUDE_MEM_PROVIDER"], "claude")
        self.assertEqual(self.backups(), [])

    def test_provider_switches_when_the_key_is_set_without_printing_it(self):
        self.settings["CLAUDE_MEM_GEMINI_API_KEY"] = "sk-test-not-a-real-key"
        with open(cm.settings_path(self.dir), "w", encoding="utf-8") as f:
            json.dump(self.settings, f)
        code, out = self.run_cli("provider", "gemini", "--model", "gemini-2.5-flash", "--no-restart")
        self.assertEqual(code, 0)
        self.assertNotIn("sk-test", out)
        self.assertIn("restart the worker", out)
        saved = self.saved()
        self.assertEqual(saved["CLAUDE_MEM_PROVIDER"], "gemini")
        self.assertEqual(saved["CLAUDE_MEM_GEMINI_MODEL"], "gemini-2.5-flash")
        self.assertEqual(saved["CLAUDE_MEM_GEMINI_API_KEY"], "sk-test-not-a-real-key")
        self.assertEqual(len(self.backups()), 1)
        # Back to claude with a model: the claude model key is the one written.
        code, out = self.run_cli("provider", "claude", "--model", "haiku", "--no-restart")
        self.assertEqual(code, 0)
        self.assertEqual(self.saved()["CLAUDE_MEM_PROVIDER"], "claude")
        self.assertEqual(self.saved()["CLAUDE_MEM_MODEL"], "haiku")
        code, out = self.run_cli("provider", "claude", "--model", "haiku", "--no-restart")
        self.assertIn("already on claude", out)

    def test_status_reports_pause_keys_and_an_unreachable_worker(self):
        code, out = self.run_cli("status")
        self.assertEqual(code, 0)
        self.assertIn("provider: claude", out)
        self.assertIn("counts against the subscription", out)
        self.assertIn("gemini key: empty", out)
        self.assertIn("paused: no", out)
        self.assertIn("worker: not answering", out)
        self.run_cli("pause")
        code, out = self.run_cli("status")
        self.assertIn("paused: yes", out)

    def test_status_renders_a_health_reply(self):
        health = {"version": "13.11.0", "pid": 1, "ai": {"provider": "claude", "authMethod": "Claude Code OAuth token"}}
        lines = cm.status(self.dir, self.settings, health=health)
        self.assertTrue(any("worker: up, v13.11.0" in line and "OAuth" in line for line in lines))

    def test_missing_settings_is_reported(self):
        empty = tempfile.mkdtemp()
        code, out = self.run_cli_in(empty, "status")
        self.assertEqual(code, 1)
        self.assertIn("not installed", out)

    def run_cli_in(self, mem_dir, *argv):
        out = io.StringIO()
        with redirect_stdout(out):
            code = cm.main(["--dir", mem_dir, *argv])
        return code, out.getvalue()


if __name__ == "__main__":
    unittest.main()
