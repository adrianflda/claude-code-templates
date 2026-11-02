import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
HOOKS = os.path.join(HERE, "..", "hooks")
sys.path.insert(0, os.path.join(HERE, "..", "scripts"))
import guard_common as g  # noqa: E402


def assistant_line(ctx, out=10):
    return json.dumps({"type": "assistant", "message": {"usage": {
        "input_tokens": 5, "cache_creation_input_tokens": 1000, "cache_read_input_tokens": ctx - 1005,
        "output_tokens": out}}}) + "\n"


def run_hook(name, payload, env=None):
    e = dict(os.environ)
    e.pop("USAGE_GUARD_DISABLE", None)
    e.update(env or {})
    r = subprocess.run([sys.executable, "-I", os.path.join(HOOKS, name)], input=json.dumps(payload),
                       capture_output=True, text=True, env=e, timeout=30)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout) if r.stdout.strip() else None


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.session = "sess1"
        self.transcript = os.path.join(self.tmp, f"{self.session}.jsonl")
        self.scratch = tempfile.mkdtemp()

    def write_main(self, ctx):
        with open(self.transcript, "w") as f:
            f.write(json.dumps({"type": "user", "message": {"content": "x" * 5000}}) + "\n")
            f.write(assistant_line(ctx))
            f.write(json.dumps({"type": "user", "message": {"content": "tool result " * 100}}) + "\n")

    def write_sub(self, agent_id, ctx):
        d = os.path.join(self.tmp, self.session, "subagents")
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, f"agent-{agent_id}.jsonl"), "w") as f:
            f.write(assistant_line(ctx))

    def payload(self, event="PreToolUse", tool="Read", agent_id=None, prompt="hello"):
        p = {"hook_event_name": event, "session_id": self.session, "transcript_path": self.transcript,
             "scratchpad_dir": self.scratch, "tool_name": tool, "tool_input": {}, "prompt": prompt}
        if agent_id:
            p["agent_id"] = agent_id
            p["agent_type"] = "Explore"
        return p


class CommonTests(Base):
    def test_last_context_reads_tail(self):
        self.write_main(123_456)
        self.assertEqual(g.last_context(self.transcript), 123_456)

    def test_last_context_missing_or_empty(self):
        self.assertEqual(g.last_context(os.path.join(self.tmp, "nope.jsonl")), 0)
        open(self.transcript, "w").close()
        self.assertEqual(g.last_context(self.transcript), 0)

    def test_subagent_transcript_resolution(self):
        p = self.payload(agent_id="abc")
        self.assertEqual(g.transcript_for(p), os.path.join(self.tmp, self.session, "subagents", "agent-abc.jsonl"))
        self.assertEqual(g.transcript_for(self.payload()), self.transcript)

    def test_settings_env_override_and_bad_values(self):
        os.environ["USAGE_GUARD_CTX_BLOCK"] = "123"
        try:
            self.assertEqual(g.setting("USAGE_GUARD_CTX_BLOCK"), 123)
            os.environ["USAGE_GUARD_CTX_BLOCK"] = "lots"
            self.assertEqual(g.setting("USAGE_GUARD_CTX_BLOCK"), 400_000)
        finally:
            del os.environ["USAGE_GUARD_CTX_BLOCK"]


class WatchdogTests(Base):
    def test_quiet_below_warn(self):
        self.write_main(100_000)
        self.assertIsNone(run_hook("context_watchdog.py", self.payload()))

    def test_warn_once_per_step(self):
        self.write_main(260_000)
        out = run_hook("context_watchdog.py", self.payload())
        self.assertIn("260k", out["hookSpecificOutput"]["additionalContext"])
        self.assertNotIn("permissionDecision", out["hookSpecificOutput"])
        self.assertIsNone(run_hook("context_watchdog.py", self.payload()))
        self.write_main(310_000)
        self.assertIsNotNone(run_hook("context_watchdog.py", self.payload()))

    def test_block_tool_over_limit(self):
        self.write_main(450_000)
        out = run_hook("context_watchdog.py", self.payload())
        self.assertEqual(out["hookSpecificOutput"]["permissionDecision"], "deny")
        self.assertIn("/compact", out["hookSpecificOutput"]["permissionDecisionReason"])

    def test_block_prompt_but_never_slash_commands(self):
        self.write_main(450_000)
        out = run_hook("context_watchdog.py", self.payload(event="UserPromptSubmit"))
        self.assertEqual(out["decision"], "block")
        self.assertIsNone(run_hook("context_watchdog.py", self.payload(event="UserPromptSubmit", prompt="/compact")))
        out = run_hook("context_watchdog.py", self.payload(event="UserPromptSubmit"), {"USAGE_GUARD_PROMPT_BLOCK": "0"})
        self.assertNotIn("decision", out)

    def test_subagent_uses_own_transcript_and_thresholds(self):
        self.write_main(100_000)
        self.write_sub("a1", 320_000)
        out = run_hook("context_watchdog.py", self.payload(agent_id="a1"))
        self.assertEqual(out["hookSpecificOutput"]["permissionDecision"], "deny")
        self.assertIn("return your report", out["hookSpecificOutput"]["permissionDecisionReason"])
        self.write_sub("a2", 160_000)
        out = run_hook("context_watchdog.py", self.payload(agent_id="a2"))
        self.assertIn("additionalContext", out["hookSpecificOutput"])
        # a subagent whose transcript does not exist yet is left alone
        self.assertIsNone(run_hook("context_watchdog.py", self.payload(agent_id="a3")))

    def test_disabled_and_garbage_input(self):
        self.write_main(450_000)
        self.assertIsNone(run_hook("context_watchdog.py", self.payload(), {"USAGE_GUARD_DISABLE": "1"}))
        r = subprocess.run([sys.executable, "-I", os.path.join(HOOKS, "context_watchdog.py")], input="not json",
                           capture_output=True, text=True)
        self.assertEqual((r.returncode, r.stdout), (0, ""))


class SpawnBudgetTests(Base):
    def test_budget_counts_and_denies(self):
        p = self.payload(tool="Agent")
        p["tool_input"] = {"subagent_type": "Explore"}
        outs = [run_hook("spawn_budget.py", p, {"USAGE_GUARD_SPAWN_BUDGET": "3"}) for _ in range(4)]
        self.assertIsNone(outs[0])
        self.assertIn("1 subagent spawn(s) left", outs[1]["hookSpecificOutput"]["additionalContext"])
        self.assertIn("0 subagent spawn(s) left", outs[2]["hookSpecificOutput"]["additionalContext"])
        self.assertEqual(outs[3]["hookSpecificOutput"]["permissionDecision"], "deny")
        with open(os.path.join(self.scratch, "usage-guard", f"{self.session}.spawns")) as f:
            self.assertEqual(f.read().count("Explore"), 3)

    def test_unlimited_and_other_tools(self):
        p = self.payload(tool="Agent")
        for _ in range(3):
            self.assertIsNone(run_hook("spawn_budget.py", p, {"USAGE_GUARD_SPAWN_BUDGET": "0"}))
        self.assertIsNone(run_hook("spawn_budget.py", self.payload(tool="Bash"), {"USAGE_GUARD_SPAWN_BUDGET": "1"}))


class SubagentNoteTests(Base):
    def test_note(self):
        out = run_hook("subagent_note.py", self.payload(event="SubagentStart", agent_id="a1"))
        self.assertEqual(out["hookSpecificOutput"]["hookEventName"], "SubagentStart")
        self.assertIn("150k", out["hookSpecificOutput"]["additionalContext"])


class HooksJsonTests(unittest.TestCase):
    def test_every_command_points_at_an_existing_script(self):
        with open(os.path.join(HOOKS, "hooks.json")) as f:
            cfg = json.load(f)["hooks"]
        self.assertEqual(set(cfg), {"PreToolUse", "UserPromptSubmit", "SubagentStart"})
        for event in cfg.values():
            for group in event:
                for h in group["hooks"]:
                    script = h["command"].split("${CLAUDE_PLUGIN_ROOT}/")[1].rstrip('"')
                    self.assertTrue(os.path.exists(os.path.join(HOOKS, "..", script)), script)
                    self.assertLessEqual(h["timeout"], 10)


if __name__ == "__main__":
    unittest.main()
