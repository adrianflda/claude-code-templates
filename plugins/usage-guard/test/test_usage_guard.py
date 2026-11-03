import io
import json
import os
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stdout

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "scripts"))

import statusline  # noqa: E402
import report  # noqa: E402


class StatuslineTests(unittest.TestCase):
    def test_every_style_renders_sample(self):
        now = time.time()
        data = json.loads(json.dumps(statusline.SAMPLE))
        data["rate_limits"]["seven_day"]["resets_at"] = now + 5 * 86400
        data["rate_limits"]["five_hour"]["resets_at"] = now + 3600
        for style in statusline.STYLES:
            out = statusline.render(data, style, color=False, now=now)
            self.assertIn("43%", out, style)
            self.assertIn("42%", out, style)
            self.assertNotIn("\033[", out, style)

    def test_empty_input_never_crashes(self):
        for style in statusline.STYLES:
            out = statusline.render({}, style, color=False)
            self.assertIn("--%", out)
        self.assertTrue(statusline.render("not a dict", "minimal", False))

    def test_pace_is_used_over_expected(self):
        now = 1_000_000
        # 2 of 7 days elapsed, 43% used -> expected 28.6% -> pace 1.5x
        resets_at = now + 5 * 86400
        self.assertAlmostEqual(statusline.pace(43, resets_at, now, statusline.WEEK), 1.505, places=2)
        # window just started: no pace
        self.assertIsNone(statusline.pace(1, now + statusline.WEEK - 60, now, statusline.WEEK))

    def test_reset_labels(self):
        now = 0
        self.assertEqual(statusline.reset_label(5 * 86400 + 4 * 3600, now, statusline.WEEK), "5d04h")
        self.assertEqual(statusline.reset_label(2 * 3600 + 15 * 60, now, statusline.FIVE_H), "2h15")

    def test_main_reads_stdin(self):
        sys.stdin = io.StringIO(json.dumps(statusline.SAMPLE))
        try:
            buf = io.StringIO()
            with redirect_stdout(buf):
                statusline.main(["--style", "bar", "--no-color"])
        finally:
            sys.stdin = sys.__stdin__
        self.assertIn("7d", buf.getvalue())


def write_transcript(path, rows):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tag = os.path.basename(path)
    with open(path, "w") as f:
        for i, (model, inp, cc, cr, out) in enumerate(rows):
            f.write(json.dumps({
                "type": "assistant", "requestId": f"{tag}-req{i}",
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "message": {"id": f"{tag}-msg{i}", "model": model, "usage": {
                    "input_tokens": inp, "cache_creation_input_tokens": cc,
                    "cache_read_input_tokens": cr, "output_tokens": out}},
            }) + "\n")
        f.write("not json\n")
        f.write(json.dumps({"type": "user", "message": {}}) + "\n")


class ReportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        write_transcript(os.path.join(self.tmp, "-proj-a", "s1.jsonl"), [("claude-opus-5-5", 10, 1000, 100000, 500)])
        write_transcript(os.path.join(self.tmp, "-proj-a", "s1", "subagents", "agent-acoder-0123456789abcdef.jsonl"),
                         [("claude-sonnet-5-5", 10, 500, 300000, 200)] * 3)
        write_transcript(os.path.join(self.tmp, "-Users-x--claude-mem-observer-sessions", "o1.jsonl"),
                         [("claude-sonnet-4-6", 10, 100, 20000, 2000)])

    def test_kinds_and_dedupe(self):
        rows = report.load(self.tmp, 7)
        kinds = sorted(r["kind"] for r in rows)
        self.assertEqual(kinds, ["claude-mem", "main", "subagent", "subagent", "subagent"])
        agent = next(r["agent"] for r in rows if r["kind"] == "subagent")
        self.assertEqual(agent, "agent-acoder")

    def test_json_summary(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            report.main(["--root", self.tmp, "--days", "7", "--json"])
        s = json.loads(buf.getvalue())
        self.assertEqual(s["calls"], 5)
        self.assertAlmostEqual(sum(s["share_by_kind"].values()), 100, delta=0.3)
        self.assertEqual(s["main_calls_over_200k_pct"], 0)
        self.assertEqual(s["subagent_ctx_p50"], 300510)

    def test_duplicate_message_ids_counted_once(self):
        write_transcript(os.path.join(self.tmp, "-proj-a", "s1.jsonl"), [("claude-opus-5-5", 10, 1000, 100000, 500)])
        with open(os.path.join(self.tmp, "-proj-a", "s1.jsonl")) as f:
            line = f.readline()
        with open(os.path.join(self.tmp, "-proj-a", "s1.jsonl"), "a") as f:
            f.write(line)
        self.assertEqual(len([r for r in report.load(self.tmp, 7) if r["kind"] == "main"]), 1)

    def test_tables_print(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            report.main(["--root", self.tmp, "--days", "7", "--top", "3"])
        text = buf.getvalue()
        for section in ("by kind", "by model", "by day", "sessions", "subagents", "context per call"):
            self.assertIn(section, text)

    def test_empty_root(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            report.main(["--root", tempfile.mkdtemp(), "--days", "7"])
        self.assertIn("no assistant messages", buf.getvalue())


class ApplyTests(unittest.TestCase):
    def test_dry_run_then_apply_then_idempotent(self):
        import apply
        tmp = tempfile.mkdtemp()
        os.environ["CLAUDE_CONFIG_DIR"] = tmp
        try:
            buf = io.StringIO()
            with redirect_stdout(buf):
                rc = apply.main(["--no-claude-mem"])
            self.assertEqual(rc, 3)
            self.assertFalse(os.path.exists(os.path.join(tmp, "settings.json")))
            with redirect_stdout(io.StringIO()):
                self.assertEqual(apply.main(["--no-claude-mem", "--apply", "--style", "bar"]), 0)
            with open(os.path.join(tmp, "settings.json")) as f:
                s = json.load(f)
            self.assertEqual(s["effortLevel"], "medium")
            self.assertEqual(s["env"]["CLAUDE_CODE_SUBAGENT_MODEL_FORCE"], "1")
            self.assertIn("--style bar", s["statusLine"]["command"])
            with redirect_stdout(io.StringIO()):
                self.assertEqual(apply.main(["--no-claude-mem", "--style", "bar"]), 0)
            # per-model effort overrides are lowered too, other keys untouched
            s["modelSettings"] = {"claude-fable-5-1": {"effortLevel": "xhigh"}}
            s["permissions"] = {"deny": ["Read(./.env)"]}
            with open(os.path.join(tmp, "settings.json"), "w") as f:
                json.dump(s, f)
            with redirect_stdout(io.StringIO()):
                apply.main(["--no-claude-mem", "--apply", "--style", "keep"])
            with open(os.path.join(tmp, "settings.json")) as f:
                s2 = json.load(f)
            self.assertEqual(s2["modelSettings"]["claude-fable-5-1"]["effortLevel"], "medium")
            self.assertEqual(s2["permissions"], {"deny": ["Read(./.env)"]})
            self.assertTrue([n for n in os.listdir(tmp) if n.startswith("settings.json.bak-")])
        finally:
            os.environ.pop("CLAUDE_CONFIG_DIR", None)


    def test_keep_agent_pins_records_them_and_drops_force(self):
        import apply
        tmp = tempfile.mkdtemp()
        os.makedirs(os.path.join(tmp, "agents"))
        with open(os.path.join(tmp, "agents", "critic.md"), "w") as f:
            f.write("---\nname: critic\nmodel: claude-opus-5-5\n---\n")
        with open(os.path.join(tmp, "agents", "dev.md"), "w") as f:
            f.write("---\nname: dev\nmodel: sonnet\n---\n")
        with open(os.path.join(tmp, "settings.json"), "w") as f:
            json.dump({"env": {"CLAUDE_CODE_SUBAGENT_MODEL_FORCE": "1"}}, f)
        os.environ["CLAUDE_CONFIG_DIR"] = tmp
        try:
            buf = io.StringIO()
            with redirect_stdout(buf):
                rc = apply.main(["--no-claude-mem", "--style", "keep", "--keep-agent-pins"])
            self.assertEqual(rc, 3)
            self.assertIn("CLAUDE_CODE_SUBAGENT_MODEL_FORCE", buf.getvalue())
            with redirect_stdout(io.StringIO()):
                self.assertEqual(apply.main(["--no-claude-mem", "--apply", "--style", "keep", "--keep-agent-pins"]), 0)
            with open(os.path.join(tmp, "settings.json")) as f:
                s = json.load(f)
            self.assertNotIn("CLAUDE_CODE_SUBAGENT_MODEL_FORCE", s["env"])
            self.assertEqual(s["env"]["USAGE_GUARD_ACCEPTED_PINS"], "critic")
            self.assertEqual(s["env"]["CLAUDE_CODE_SUBAGENT_MODEL"], "sonnet")
            with redirect_stdout(io.StringIO()):
                self.assertEqual(apply.main(["--no-claude-mem", "--style", "keep", "--keep-agent-pins"]), 0)
        finally:
            os.environ.pop("CLAUDE_CONFIG_DIR", None)

    def test_keep_agent_pins_without_costly_agents_drops_the_stale_list(self):
        import apply
        tmp = tempfile.mkdtemp()
        os.makedirs(os.path.join(tmp, "agents"))
        with open(os.path.join(tmp, "agents", "dev.md"), "w") as f:
            f.write("---\nname: dev\nmodel: sonnet\n---\n")
        with open(os.path.join(tmp, "settings.json"), "w") as f:
            json.dump({"env": {"CLAUDE_CODE_SUBAGENT_MODEL_FORCE": "1", "USAGE_GUARD_ACCEPTED_PINS": "gone"}}, f)
        os.environ["CLAUDE_CONFIG_DIR"] = tmp
        try:
            buf = io.StringIO()
            with redirect_stdout(buf):
                self.assertEqual(apply.main(["--no-claude-mem", "--style", "keep", "--keep-agent-pins"]), 3)
            self.assertIn("env.USAGE_GUARD_ACCEPTED_PINS: 'gone' -> (removed)", buf.getvalue())
            with redirect_stdout(io.StringIO()):
                self.assertEqual(apply.main(["--no-claude-mem", "--apply", "--style", "keep", "--keep-agent-pins"]), 0)
            with open(os.path.join(tmp, "settings.json")) as f:
                s = json.load(f)
            self.assertNotIn("CLAUDE_CODE_SUBAGENT_MODEL_FORCE", s["env"])
            self.assertNotIn("USAGE_GUARD_ACCEPTED_PINS", s["env"])
        finally:
            os.environ.pop("CLAUDE_CONFIG_DIR", None)

    def test_keep_agent_pins_from_settings_that_never_had_force(self):
        import apply
        tmp = tempfile.mkdtemp()
        os.makedirs(os.path.join(tmp, "agents"))
        with open(os.path.join(tmp, "agents", "critic.md"), "w") as f:
            f.write("---\nname: critic\nmodel: claude-opus-5-5\n---\n")
        with open(os.path.join(tmp, "settings.json"), "w") as f:
            json.dump({"permissions": {"deny": ["Read(./.env)"]}}, f)
        os.environ["CLAUDE_CONFIG_DIR"] = tmp
        try:
            buf = io.StringIO()
            with redirect_stdout(buf):
                self.assertEqual(apply.main(["--no-claude-mem", "--style", "keep", "--keep-agent-pins"]), 3)
            self.assertNotIn("CLAUDE_CODE_SUBAGENT_MODEL_FORCE", buf.getvalue())
            self.assertIn("env.USAGE_GUARD_ACCEPTED_PINS: None -> 'critic'", buf.getvalue())
            with redirect_stdout(io.StringIO()):
                self.assertEqual(apply.main(["--no-claude-mem", "--apply", "--style", "keep", "--keep-agent-pins"]), 0)
            with open(os.path.join(tmp, "settings.json")) as f:
                s = json.load(f)
            self.assertNotIn("CLAUDE_CODE_SUBAGENT_MODEL_FORCE", s["env"])
            self.assertEqual(s["env"]["USAGE_GUARD_ACCEPTED_PINS"], "critic")
            self.assertEqual(s["permissions"], {"deny": ["Read(./.env)"]})
        finally:
            os.environ.pop("CLAUDE_CONFIG_DIR", None)


class DoctorTests(unittest.TestCase):
    def test_runs_on_empty_config(self):
        tmp = tempfile.mkdtemp()
        env = dict(os.environ)
        env["CLAUDE_CONFIG_DIR"] = tmp
        for k in ("CLAUDE_CODE_EFFORT_LEVEL", "CLAUDE_CODE_AUTO_COMPACT_WINDOW", "CLAUDE_CODE_SUBAGENT_MODEL",
                  "CLAUDE_CODE_SUBAGENT_MODEL_FORCE", "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS", "ANTHROPIC_API_KEY"):
            env.pop(k, None)
        import subprocess
        r = subprocess.run([sys.executable, "-I", os.path.join(HERE, "..", "scripts", "doctor.py"), "--cwd", tmp],
                           capture_output=True, text=True, env=env)
        self.assertIn("autocompact", r.stdout)
        self.assertIn("WARN", r.stdout)
        self.assertEqual(r.returncode, 1)


if __name__ == "__main__":
    unittest.main()
