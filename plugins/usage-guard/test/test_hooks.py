import json
import os
import subprocess
import sys
import tempfile
import time
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
    def test_budget_counts_and_asks(self):
        outs = [run_hook("spawn_budget.py", self.agent(), {"USAGE_GUARD_SPAWN_BUDGET": "3"}) for _ in range(4)]
        self.assertIsNone(outs[0])
        self.assertEqual(outs[1]["hookSpecificOutput"]["additionalContext"],
                         "usage-guard: 1 subagent spawn(s) left in the last 120 min (budget 3).")
        self.assertEqual(outs[2]["hookSpecificOutput"]["additionalContext"],
                         "usage-guard: 0 subagent spawn(s) left in the last 120 min (budget 3).")
        over = outs[3]["hookSpecificOutput"]
        self.assertEqual(over["permissionDecision"], "ask")
        self.assertIn("3 subagents spawned in the last 120 min (budget 3)", over["permissionDecisionReason"])
        # The ledger counts attempts: a spawn the user is asked about is recorded even if they decline it.
        self.assertEqual(self.ledger().count("Explore"), 4)

    def ledger(self):
        with open(os.path.join(self.scratch, "usage-guard", f"{self.session}.spawns")) as f:
            return f.read()

    def seed(self, ages_min, legacy=0):
        d = os.path.join(self.scratch, "usage-guard")
        os.makedirs(d, exist_ok=True)
        now = time.time()
        with open(os.path.join(d, f"{self.session}.spawns"), "w") as f:
            f.write("Explore\n" * legacy)  # lines written before the ledger carried a time
            for age in ages_min:
                f.write(f"{int(now - age * 60)}\tExplore\n")

    def agent(self):
        p = self.payload(tool="Agent")
        p["tool_input"] = {"subagent_type": "Explore"}
        return p

    def test_spawns_older_than_the_window_do_not_count(self):
        self.seed([200, 190, 180, 170, 121])
        self.assertIsNone(run_hook("spawn_budget.py", self.agent(), {"USAGE_GUARD_SPAWN_BUDGET": "3"}))

    def test_spawns_inside_the_window_count(self):
        self.seed([200, 119, 60, 1])
        out = run_hook("spawn_budget.py", self.agent(), {"USAGE_GUARD_SPAWN_BUDGET": "3"})
        self.assertEqual(out["hookSpecificOutput"]["permissionDecision"], "ask")
        self.assertIn("3 subagents spawned in the last 120 min", out["hookSpecificOutput"]["permissionDecisionReason"])

    def test_window_length_is_a_knob(self):
        self.seed([50, 40, 31])
        env = {"USAGE_GUARD_SPAWN_BUDGET": "3", "USAGE_GUARD_SPAWN_WINDOW_MIN": "30"}
        self.assertIsNone(run_hook("spawn_budget.py", self.agent(), env))

    def test_window_zero_counts_the_whole_session(self):
        self.seed([900, 800], legacy=1)
        env = {"USAGE_GUARD_SPAWN_BUDGET": "3", "USAGE_GUARD_SPAWN_WINDOW_MIN": "0"}
        out = run_hook("spawn_budget.py", self.agent(), env)
        self.assertEqual(out["hookSpecificOutput"]["permissionDecision"], "ask")
        self.assertIn("3 subagents spawned in this session (budget 3)",
                      out["hookSpecificOutput"]["permissionDecisionReason"])

    def test_lines_without_a_time_count_only_with_window_zero(self):
        self.seed([], legacy=5)
        self.assertIsNone(run_hook("spawn_budget.py", self.agent(), {"USAGE_GUARD_SPAWN_BUDGET": "3"}))

    def test_reminder_names_the_session_with_window_zero(self):
        self.seed([900])
        env = {"USAGE_GUARD_SPAWN_BUDGET": "3", "USAGE_GUARD_SPAWN_WINDOW_MIN": "0"}
        out = run_hook("spawn_budget.py", self.agent(), env)
        self.assertEqual(out["hookSpecificOutput"]["additionalContext"],
                         "usage-guard: 1 subagent spawn(s) left in this session (budget 3).")

    def test_negative_window_counts_the_whole_session(self):
        self.seed([900, 800, 700])
        env = {"USAGE_GUARD_SPAWN_BUDGET": "3", "USAGE_GUARD_SPAWN_WINDOW_MIN": "-5"}
        out = run_hook("spawn_budget.py", self.agent(), env)
        self.assertEqual(out["hookSpecificOutput"]["permissionDecision"], "ask")
        self.assertIn("in this session", out["hookSpecificOutput"]["permissionDecisionReason"])

    def test_line_with_an_unreadable_time_is_ignored_inside_a_window(self):
        self.seed([3, 2, 1])
        with open(os.path.join(self.scratch, "usage-guard", f"{self.session}.spawns"), "a") as f:
            f.write("garbage\tExplore\n")
        out = run_hook("spawn_budget.py", self.agent(), {"USAGE_GUARD_SPAWN_BUDGET": "4"})
        self.assertEqual(out["hookSpecificOutput"]["additionalContext"],
                         "usage-guard: 0 subagent spawn(s) left in the last 120 min (budget 4).")

    def test_hard_mode_denies_and_does_not_record(self):
        self.seed([3, 2, 1])
        env = {"USAGE_GUARD_SPAWN_BUDGET": "3", "USAGE_GUARD_SPAWN_HARD": "1"}
        out = run_hook("spawn_budget.py", self.agent(), env)
        self.assertEqual(out["hookSpecificOutput"]["permissionDecision"], "deny")
        self.assertEqual(self.ledger().count("Explore"), 3)

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
