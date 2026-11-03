"""In-process tests for scripts/doctor.py checks against a temporary config dir."""
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "scripts"))

import doctor  # noqa: E402

CLEARED = ("CLAUDE_CODE_EFFORT_LEVEL", "CLAUDE_CODE_AUTO_COMPACT_WINDOW", "CLAUDE_CODE_SUBAGENT_MODEL",
           "CLAUDE_CODE_SUBAGENT_MODEL_FORCE", "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS", "ANTHROPIC_API_KEY",
           "CLAUDECODE", "AI_REVIEW_QUICK_LINES", "USAGE_GUARD_ACCEPTED_PINS")


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


class DoctorChecksTest(unittest.TestCase):
    def setUp(self):
        self.cfg = tempfile.mkdtemp()
        self.settings = {"effortLevel": "medium",
                         "env": {"CLAUDE_CODE_AUTO_COMPACT_WINDOW": "200000", "CLAUDE_CODE_SUBAGENT_MODEL": "sonnet"}}

    def rows(self, env=None, hook=None):
        """Run the checks with a clean environment; rows keyed by check name: (status, check, detail, fix)."""
        write(os.path.join(self.cfg, "settings.json"), json.dumps(self.settings))
        with mock.patch.dict(os.environ):
            for k in CLEARED:
                os.environ.pop(k, None)
            os.environ["CLAUDE_CONFIG_DIR"] = self.cfg
            os.environ.update(env or {})
            with mock.patch.object(doctor, "git_hook_command", return_value=hook, create=True):
                rep = doctor.Report()
                doctor.run(self.cfg, rep)
        return {r[1]: r for r in rep.rows}

    def fake_hook(self, version):
        root = os.path.join(self.cfg, "plugins", "pre-push-review")
        write(os.path.join(root, ".claude-plugin", "plugin.json"), json.dumps({"name": "pre-push-review", "version": version}))
        return f"node {os.path.join(root, 'scripts', 'git-pre-push.mjs')}"

    def test_config_dir_is_resolved_when_run_is_called(self):
        self.settings["effortLevel"] = "max"
        r = self.rows()
        self.assertEqual(r["effort"][0], "WARN")
        self.assertIn("global=max", r["effort"][2])

    def test_pre_push_review_not_installed_is_info(self):
        r = self.rows(hook=None)
        self.assertEqual(r["pre-push-review"][0], "INFO")
        self.assertIn("not set", r["pre-push-review"][2])

    def test_pre_push_review_quick_mode_knob(self):
        hook = self.fake_hook("1.8.0")
        r = self.rows(hook=hook)
        self.assertEqual(r["pre-push-review"][0], "PASS")
        self.assertIn("60", r["pre-push-review"][2])
        r = self.rows(env={"AI_REVIEW_QUICK_LINES": "0"}, hook=hook)
        self.assertEqual(r["pre-push-review"][0], "WARN")
        self.assertIn("whole panel", r["pre-push-review"][2])
        self.assertIn("60", r["pre-push-review"][3])
        self.settings["env"]["AI_REVIEW_QUICK_LINES"] = "120"
        r = self.rows(hook=hook)
        self.assertEqual(r["pre-push-review"][0], "PASS")
        self.assertIn("120", r["pre-push-review"][2])
        del self.settings["env"]["AI_REVIEW_QUICK_LINES"]
        r = self.rows(hook=self.fake_hook("1.7.2"))
        self.assertEqual(r["pre-push-review"][0], "INFO")
        self.assertIn("1.8.0", r["pre-push-review"][2])

    def test_env_drift_is_reported_only_inside_claude_code(self):
        self.assertNotIn("env-drift", self.rows(env={"CLAUDE_CODE_SUBAGENT_MODEL_FORCE": "1"}))
        live = {"CLAUDECODE": "1", "CLAUDE_CODE_SUBAGENT_MODEL": "sonnet", "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "200000"}
        r = self.rows(env=live)
        self.assertEqual(r["env-drift"][0], "PASS")
        r = self.rows(env=dict(live, CLAUDE_CODE_SUBAGENT_MODEL_FORCE="1"))
        self.assertEqual(r["env-drift"][0], "INFO")
        self.assertIn("CLAUDE_CODE_SUBAGENT_MODEL_FORCE", r["env-drift"][2])
        self.assertIn("restart", r["env-drift"][3].lower())

    def test_accepted_pins_turn_costly_agents_into_pass(self):
        write(os.path.join(self.cfg, "agents", "critic.md"), "---\nname: critic\nmodel: claude-opus-5-5\n---\n")
        write(os.path.join(self.cfg, "agents", "dev.md"), "---\nname: dev\nmodel: sonnet\n---\n")
        r = self.rows()
        self.assertEqual(r["agent-models"][0], "WARN")
        self.assertIn("critic=claude-opus-5-5", r["agent-models"][2])
        r = self.rows(env={"USAGE_GUARD_ACCEPTED_PINS": "other"})
        self.assertEqual(r["agent-models"][0], "WARN")
        self.settings["env"]["USAGE_GUARD_ACCEPTED_PINS"] = "critic"
        r = self.rows()
        self.assertEqual(r["agent-models"][0], "PASS")
        self.assertIn("accepted", r["agent-models"][2])
        self.settings["env"]["USAGE_GUARD_ACCEPTED_PINS"] = "*"
        self.assertEqual(self.rows()["agent-models"][0], "PASS")

    def test_quick_lines_mirrors_what_the_panel_accepts(self):
        # ai-review-panel.mjs: Math.max(0, Number(AI_REVIEW_QUICK_LINES ?? 60) || 0)
        self.assertEqual(doctor.quick_lines(None), 60)
        self.assertEqual(doctor.quick_lines(" 60 "), 60)
        self.assertEqual(doctor.quick_lines(120), 120)
        self.assertEqual(doctor.quick_lines("abc"), 0)
        self.assertEqual(doctor.quick_lines("-5"), 0)
        self.assertEqual(doctor.quick_lines(""), 0)
        # Number("inf") is NaN in JS -> 0; Python's float() accepts it, so the cast must not raise
        for value in ("inf", "Infinity", "-inf", "nan"):
            self.assertEqual(doctor.quick_lines(value), 0, value)

    def test_pre_push_review_reads_a_malformed_or_int_typed_knob(self):
        hook = self.fake_hook("1.8.0")
        r = self.rows(env={"AI_REVIEW_QUICK_LINES": "abc"}, hook=hook)
        self.assertEqual(r["pre-push-review"][0], "WARN")
        self.assertIn("AI_REVIEW_QUICK_LINES='abc'", r["pre-push-review"][2])
        self.assertIn("whole panel", r["pre-push-review"][2])
        self.settings["env"]["AI_REVIEW_QUICK_LINES"] = 120  # an int in settings.json, not a string
        r = self.rows(hook=hook)
        self.assertEqual(r["pre-push-review"][0], "PASS")
        self.assertIn("<=120 changed lines (AI_REVIEW_QUICK_LINES)", r["pre-push-review"][2])

    def test_pre_push_review_hook_without_a_plugin_json_is_info(self):
        script = os.path.join(self.cfg, "elsewhere", "scripts", "git-pre-push.mjs")
        r = self.rows(hook=f"node {script}")
        self.assertEqual(r["pre-push-review"][0], "INFO")
        self.assertIn("no plugin.json", r["pre-push-review"][2])
        self.assertIn(script, r["pre-push-review"][2])
        self.assertIn("git-pre-push.mjs", r["pre-push-review"][3])

    def test_hook_plugin_version_handles_quoted_paths_and_bad_quoting(self):
        root = os.path.join(self.cfg, "my plugins", "pre-push-review")
        write(os.path.join(root, ".claude-plugin", "plugin.json"), json.dumps({"version": "1.8.1"}))
        script = os.path.join(root, "scripts", "git-pre-push.mjs")
        self.assertEqual(doctor.hook_plugin_version(f'node "{script}"'), "1.8.1")
        self.assertEqual(doctor.hook_plugin_version(f"/usr/bin/env node '{script}' --flag 'a b'"), "1.8.1")
        plain = os.path.join(self.cfg, "x", "scripts", "git-pre-push.mjs")
        self.assertIsNone(doctor.hook_plugin_version(f'node "{plain}'), "unbalanced quote: no crash, no version")
        self.assertIsNone(doctor.hook_plugin_version("node"))
        r = self.rows(hook=f'node "{script}"')
        self.assertEqual(r["pre-push-review"][0], "PASS")
        self.assertIn("version 1.8.1", r["pre-push-review"][2])

    def test_accepted_pins_lists_only_the_unaccepted_agents(self):
        write(os.path.join(self.cfg, "agents", "critic.md"), "---\nname: critic\nmodel: claude-opus-5-5\n---\n")
        write(os.path.join(self.cfg, "agents", "breaker.md"), "---\nname: breaker\nmodel: opus\n---\n")
        self.settings["env"]["USAGE_GUARD_ACCEPTED_PINS"] = "critic"
        r = self.rows()
        self.assertEqual(r["agent-models"][0], "WARN")
        self.assertIn("1 of 2 agents pin a costly model: breaker=opus", r["agent-models"][2])
        self.assertNotIn("critic", r["agent-models"][2])
        del self.settings["env"]["USAGE_GUARD_ACCEPTED_PINS"]
        r = self.rows(env={"USAGE_GUARD_ACCEPTED_PINS": "breaker, critic"})
        self.assertEqual(r["agent-models"][0], "PASS")
        self.assertEqual(r["agent-models"][2], "2 agents, 2 costly pins (2 accepted on purpose)")

    def test_env_drift_never_prints_values_of_unknown_keys(self):
        self.settings["env"]["MY_SERVICE_TOKEN"] = "tok-old-1234"
        live = {"CLAUDECODE": "1", "CLAUDE_CODE_SUBAGENT_MODEL": "sonnet", "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "200000",
                "MY_SERVICE_TOKEN": "tok-new-5678"}
        r = self.rows(env=live)
        self.assertEqual(r["env-drift"][0], "INFO")
        self.assertIn("MY_SERVICE_TOKEN (values hidden) session=set settings=set", r["env-drift"][2])
        for row in r.values():
            for cell in row:
                self.assertNotIn("tok-old-1234", cell)
                self.assertNotIn("tok-new-5678", cell)
        del live["MY_SERVICE_TOKEN"]
        r = self.rows(env=live)
        self.assertIn("MY_SERVICE_TOKEN (values hidden) session=unset settings=set", r["env-drift"][2])
        live["MY_SERVICE_TOKEN"] = "tok-old-1234"
        self.assertEqual(self.rows(env=live)["env-drift"][0], "PASS")

    def test_main_prints_the_new_checks_and_exits_1_on_a_warning(self):
        hook = self.fake_hook("1.8.0")
        write(os.path.join(self.cfg, "settings.json"), json.dumps(self.settings))
        with mock.patch.dict(os.environ):
            for k in CLEARED:
                os.environ.pop(k, None)
            os.environ.update({"CLAUDE_CONFIG_DIR": self.cfg, "CLAUDECODE": "1", "AI_REVIEW_QUICK_LINES": "0"})
            with mock.patch.object(doctor, "git_hook_command", return_value=hook):
                out = io.StringIO()
                with redirect_stdout(out):
                    rc = doctor.main(["--cwd", self.cfg])
        text = out.getvalue()
        self.assertEqual(rc, 1)
        self.assertIn("WARN pre-push-review", text)
        self.assertIn("fix: unset AI_REVIEW_QUICK_LINES or set it to 60", text)
        self.assertIn("INFO env-drift", text)
        self.assertIn("AI_REVIEW_QUICK_LINES session='0' settings=None", text)
        self.assertIn("12 check(s)", text)


if __name__ == "__main__":
    unittest.main()
