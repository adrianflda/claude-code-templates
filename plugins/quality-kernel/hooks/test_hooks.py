#!/usr/bin/env python3
"""Tests for the quality-kernel hooks (epistemic-guard, evidence-gate).

Run: python3 -m unittest discover -s plugins/quality-kernel/hooks -p 'test_*.py'
  or: python3 plugins/quality-kernel/hooks/test_hooks.py
"""
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
GUARD = HERE / "epistemic-guard.py"
GATE = HERE / "evidence-gate.py"
MARKER = "[EPISTEMIC-DISCIPLINE v1]"


def run(script, payload, env=None, cwd=None):
    proc = subprocess.run(
        [sys.executable, str(script)],
        input=json.dumps(payload),
        text=True,
        capture_output=True,
        env={**os.environ, **(env or {})},
        cwd=cwd,
    )
    run.last_stdout = proc.stdout
    return proc.returncode, proc.stderr


class EpistemicGuard(unittest.TestCase):
    def test_non_agent_tool_passes(self):
        code, _ = run(GUARD, {"tool_name": "Bash", "tool_input": {"command": "ls"}})
        self.assertEqual(code, 0)

    def test_marker_present_passes(self):
        code, _ = run(GUARD, {"tool_name": "Task", "tool_input": {"prompt": f"{MARKER} do x"}})
        self.assertEqual(code, 0)

    def test_exempt_present_passes(self):
        code, _ = run(GUARD, {"tool_name": "Agent", "tool_input": {"prompt": "[EPISTEMIC-EXEMPT: quick fetch] go"}})
        self.assertEqual(code, 0)

    def test_missing_marker_injects_preamble_via_updated_input(self):
        # Live probe (CLI 2.1.293): updatedInput applies WITHOUT a permissionDecision.
        tool_input = {"prompt": "no marker here", "description": "d", "subagent_type": "general-purpose"}
        code, _ = run(GUARD, {"tool_name": "Task", "tool_input": tool_input})
        self.assertEqual(code, 0)
        out = json.loads(run.last_stdout)
        hso = out["hookSpecificOutput"]
        self.assertEqual(hso["hookEventName"], "PreToolUse")
        upd = hso["updatedInput"]
        self.assertTrue(upd["prompt"].startswith(MARKER))
        self.assertTrue(upd["prompt"].endswith("no marker here"))
        self.assertEqual({k: v for k, v in upd.items() if k != "prompt"},
                         {"description": "d", "subagent_type": "general-purpose"})

    def test_injection_never_sets_a_permission_decision(self):
        run(GUARD, {"tool_name": "Agent", "tool_input": {"prompt": "x"}})
        self.assertNotIn("permissionDecision", run.last_stdout)

    def test_marker_or_exempt_produces_no_output(self):
        for prompt in (f"{MARKER} go", "[EPISTEMIC-EXEMPT: fetch] go"):
            run(GUARD, {"tool_name": "Task", "tool_input": {"prompt": prompt}})
            self.assertEqual(run.last_stdout, "")

    def test_malformed_stdin_produces_no_output(self):
        proc = subprocess.run([sys.executable, str(GUARD)], input="{bad", text=True, capture_output=True)
        self.assertEqual(proc.stdout, "")

    def test_missing_marker_block_mode_blocks(self):
        code, _ = run(
            GUARD,
            {"tool_name": "Task", "tool_input": {"prompt": "no marker"}},
            env={"QK_EPISTEMIC_MODE": "block"},
        )
        self.assertEqual(code, 2)
        self.assertEqual(run.last_stdout, "")

    def test_agent_tool_name_is_covered(self):
        # regression for the pre-push HIGH finding: the guard must fire for "Agent" too
        code, _ = run(
            GUARD,
            {"tool_name": "Agent", "tool_input": {"prompt": "no marker"}},
            env={"QK_EPISTEMIC_MODE": "block"},
        )
        self.assertEqual(code, 2)

    def test_malformed_stdin_fails_open(self):
        proc = subprocess.run([sys.executable, str(GUARD)], input="{bad json", text=True, capture_output=True)
        self.assertEqual(proc.returncode, 0)


class EvidenceGate(unittest.TestCase):
    def _ledger(self, cwd):
        p = pathlib.Path(cwd) / ".quality-kernel" / "evidence-ledger.jsonl"
        return p.read_text().strip().splitlines() if p.exists() else []

    def test_non_bash_writes_nothing(self):
        with tempfile.TemporaryDirectory() as d:
            code, _ = run(GATE, {"tool_name": "Read", "tool_input": {}}, cwd=d)
            self.assertEqual(code, 0)
            self.assertEqual(self._ledger(d), [])

    def test_non_verify_command_writes_nothing(self):
        with tempfile.TemporaryDirectory() as d:
            code, _ = run(GATE, {"tool_name": "Bash", "tool_input": {"command": "ls -la"}}, cwd=d)
            self.assertEqual(code, 0)
            self.assertEqual(self._ledger(d), [])

    def test_verify_command_success_is_recorded_with_exit_code_0(self):
        # PostToolUse fires only on success -> exit_code 0. Failures arrive via PostToolUseFailure.
        with tempfile.TemporaryDirectory() as d:
            code, _ = run(
                GATE,
                {"tool_name": "Bash", "tool_input": {"command": "pytest -q"},
                 "tool_response": {"stdout": "ok", "stderr": "", "interrupted": False}, "cwd": d},
                cwd=d,
            )
            self.assertEqual(code, 0)
            lines = self._ledger(d)
            self.assertEqual(len(lines), 1)
            rec = json.loads(lines[0])
            self.assertEqual(rec["source"], "bash-hook")
            self.assertEqual(rec["exit_code"], 0)  # PostToolUse == success
            self.assertIs(rec["interrupted"], False)
            self.assertIs(rec["stderr_nonempty"], False)

    def test_node_test_runner_is_recorded(self):
        with tempfile.TemporaryDirectory() as d:
            code, _ = run(
                GATE,
                {"tool_name": "Bash", "tool_input": {"command": "node --test"},
                 "tool_response": {"stdout": "", "stderr": "", "interrupted": False}, "cwd": d},
                cwd=d,
            )
            self.assertEqual(code, 0)
            self.assertEqual(len(self._ledger(d)), 1)
            self.assertEqual(json.loads(self._ledger(d)[0])["source"], "bash-hook")

    def test_prose_in_a_non_verify_command_is_NOT_recorded(self):
        # The exact regression that produced 112 false "verification events": a runner word
        # inside a quoted BODY (a PR comment) must NOT count as a verify command (INV5b).
        with tempfile.TemporaryDirectory() as d:
            cmd = 'gh pr comment 599 -b "ran pytest and vitest, coverage green, all tests pass"'
            code, _ = run(GATE, {"tool_name": "Bash", "tool_input": {"command": cmd}, "cwd": d}, cwd=d)
            self.assertEqual(code, 0)
            self.assertEqual(self._ledger(d), [])

    def test_echo_mentioning_a_runner_is_NOT_recorded(self):
        with tempfile.TemporaryDirectory() as d:
            code, _ = run(GATE, {"tool_name": "Bash", "tool_input": {"command": 'echo "run pytest first"'}, "cwd": d}, cwd=d)
            self.assertEqual(code, 0)
            self.assertEqual(self._ledger(d), [])

    def test_prose_with_metacharacters_in_a_quoted_body_is_NOT_recorded(self):
        # RED-TEAM regression: the general 112-false-events class — a runner word together with a
        # shell metachar (;, |, &&) inside a QUOTED body must not create/start a command segment.
        for cmd in (
            'gh pr comment 599 -b "ran the suite; pytest is green"',
            'echo "results && pytest ok"',
            'gh pr comment 599 -b "steps: npm i; pytest -q all green | vitest too"',
        ):
            with tempfile.TemporaryDirectory() as d:
                code, _ = run(GATE, {"tool_name": "Bash", "tool_input": {"command": cmd}, "cwd": d}, cwd=d)
                self.assertEqual(code, 0)
                self.assertEqual(self._ledger(d), [], f"should not record: {cmd}")

    def test_chained_verify_command_is_recorded(self):
        # `cd foo && pytest` — the runner starts the SECOND segment → still recorded.
        with tempfile.TemporaryDirectory() as d:
            code, _ = run(
                GATE,
                {"tool_name": "Bash", "tool_input": {"command": "cd foo && pytest -q"},
                 "tool_response": {"stdout": "", "stderr": "", "interrupted": False}, "cwd": d},
                cwd=d,
            )
            self.assertEqual(code, 0)
            self.assertEqual(len(self._ledger(d)), 1)

    def test_non_dict_response_is_recorded_with_null_signals(self):
        # A non-dict tool_response is still recorded (the command ran) but with null signals.
        with tempfile.TemporaryDirectory() as d:
            code, _ = run(
                GATE,
                {"tool_name": "Bash", "tool_input": {"command": "pytest -q"}, "tool_response": "weird string", "cwd": d},
                cwd=d,
            )
            self.assertEqual(code, 0)
            rec = json.loads(self._ledger(d)[0])
            self.assertEqual(rec["source"], "bash-hook")
            self.assertEqual(rec["exit_code"], 0)
            self.assertIsNone(rec["interrupted"])
            self.assertIsNone(rec["stderr_nonempty"])

    def test_recorder_error_is_fail_open(self):
        # Point cwd at a *file* so mkdir('.quality-kernel') raises inside the try block.
        with tempfile.TemporaryDirectory() as d:
            not_a_dir = pathlib.Path(d) / "not-a-dir"
            not_a_dir.write_text("x")
            code, err = run(
                GATE,
                {"tool_name": "Bash", "tool_input": {"command": "pytest -q"}, "tool_response": {"exit_code": 0}, "cwd": str(not_a_dir)},
            )
            self.assertEqual(code, 0)
            self.assertIn("recorder error (fail-open)", err)

    # ---- PostToolUseFailure: exit codes parsed from `error` ----
    def _fail(self, d, error, command="pytest -q", **extra):
        payload = {"hook_event_name": "PostToolUseFailure", "tool_name": "Bash",
                   "tool_input": {"command": command}, "error": error, "cwd": d, **extra}
        return run(GATE, payload, cwd=d)

    def test_failure_exit_code_1_is_parsed(self):
        with tempfile.TemporaryDirectory() as d:
            code, _ = self._fail(d, "Exit code 1\nError: Cannot find module 'express'",
                                 duration_ms=42, is_interrupt=False)
            self.assertEqual(code, 0)
            rec = json.loads(self._ledger(d)[0])
            self.assertEqual(rec["exit_code"], 1)
            self.assertEqual(rec["duration_ms"], 42)
            self.assertIs(rec["is_interrupt"], False)
            self.assertEqual(rec["source"], "bash-hook")

    def test_failure_exit_code_3_is_parsed(self):
        with tempfile.TemporaryDirectory() as d:
            self._fail(d, "Exit code 3")
            self.assertEqual(json.loads(self._ledger(d)[0])["exit_code"], 3)

    def test_failure_without_exit_code_line_records_null(self):
        with tempfile.TemporaryDirectory() as d:
            self._fail(d, "Command interrupted by user", is_interrupt=True)
            rec = json.loads(self._ledger(d)[0])
            self.assertIsNone(rec["exit_code"])
            self.assertIs(rec["is_interrupt"], True)

    def test_exit_code_only_parsed_from_first_line(self):
        with tempfile.TemporaryDirectory() as d:
            self._fail(d, "boom\nExit code 9")
            self.assertIsNone(json.loads(self._ledger(d)[0])["exit_code"])

    def test_agent_id_recorded_when_present(self):
        with tempfile.TemporaryDirectory() as d:
            self._fail(d, "Exit code 1", agent_id="agent-123")
            self.assertEqual(json.loads(self._ledger(d)[0])["agent_id"], "agent-123")

    def test_no_row_contains_error_or_output_text(self):
        with tempfile.TemporaryDirectory() as d:
            self._fail(d, "Exit code 1\nSECRET-ERROR-TEXT-777")
            run(GATE, {"tool_name": "Bash", "tool_input": {"command": "pytest -q"}, "cwd": d,
                       "tool_response": {"stdout": "SECRET-STDOUT-888", "stderr": "SECRET-STDERR-999",
                                         "interrupted": False}}, cwd=d)
            raw = "\n".join(self._ledger(d))
            self.assertEqual(len(self._ledger(d)), 2)
            for t in ("SECRET-ERROR-TEXT-777", "SECRET-STDOUT-888", "SECRET-STDERR-999"):
                self.assertNotIn(t, raw)

    def test_non_verify_failure_writes_nothing(self):
        with tempfile.TemporaryDirectory() as d:
            self._fail(d, "Exit code 1", command="false")
            self.assertEqual(self._ledger(d), [])

    def test_command_secrets_are_redacted(self):
        # Fixtures are assembled at runtime so no literal token shape sits in the repo.
        aws = "AK" + "IA" + "ABCDEFGHIJKLMNOP"
        sk = "sk" + "-abcdefghijklmnopqrstuv"
        gh = "gh" + "p_" + "abcdefghijklmnopqrstuvwxyz0123456789"
        slack = "xo" + "xb-123456789-abcdef"
        secrets = [aws, sk, gh, slack, "Bearer abc.def-ghi", "hunter2hunter2"]
        cmd = (f"pytest -q AWS={aws} K={sk} T={gh} S={slack} "
               "-H 'Authorization: Bearer abc.def-ghi' password=hunter2hunter2")
        with tempfile.TemporaryDirectory() as d:
            self._fail(d, "Exit code 1", command=cmd)
            raw = self._ledger(d)[0]
            for s in secrets:
                self.assertNotIn(s, raw)
            self.assertIn("pytest -q", raw)
            self.assertIn("[REDACTED]", raw)

    def test_command_truncated_to_300_after_redaction(self):
        with tempfile.TemporaryDirectory() as d:
            self._fail(d, "Exit code 1", command="pytest " + "a" * 1000)
            self.assertEqual(len(json.loads(self._ledger(d)[0])["command"]), 300)

    def _git_repo(self, d, ignore):
        subprocess.run(["git", "init", "-q", d], check=True)
        if ignore:
            pathlib.Path(d, ".gitignore").write_text(".quality-kernel/\n")

    def test_non_gitignored_ledger_in_git_repo_is_not_written(self):
        with tempfile.TemporaryDirectory() as d:
            self._git_repo(d, ignore=False)
            code, _ = self._fail(d, "Exit code 1")
            self.assertEqual(code, 0)
            self.assertFalse((pathlib.Path(d) / ".quality-kernel").exists())

    def test_gitignored_ledger_in_git_repo_is_written(self):
        with tempfile.TemporaryDirectory() as d:
            self._git_repo(d, ignore=True)
            self._fail(d, "Exit code 1")
            self.assertEqual(len(self._ledger(d)), 1)

    def test_malformed_json_exit_0_nothing_written(self):
        with tempfile.TemporaryDirectory() as d:
            proc = subprocess.run([sys.executable, str(GATE)], input="{bad", text=True,
                                  capture_output=True, cwd=d)
            self.assertEqual(proc.returncode, 0)
            self.assertEqual(self._ledger(d), [])

    def test_hooks_json_registers_post_tool_use_failure_for_bash(self):
        cfg = json.loads((HERE / "hooks.json").read_text())["hooks"]
        for ev in ("PostToolUse", "PostToolUseFailure"):
            entry = cfg[ev][0]
            self.assertEqual(entry["matcher"], "Bash")
            self.assertIn("evidence-gate.py", entry["hooks"][0]["command"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
