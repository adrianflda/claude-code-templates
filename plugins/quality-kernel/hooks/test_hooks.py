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

    def test_missing_marker_log_mode_warns_but_passes(self):
        code, err = run(GUARD, {"tool_name": "Task", "tool_input": {"prompt": "no marker here"}})
        self.assertEqual(code, 0)
        self.assertIn("epistemic guard", err)

    def test_missing_marker_block_mode_blocks(self):
        code, _ = run(
            GUARD,
            {"tool_name": "Task", "tool_input": {"prompt": "no marker"}},
            env={"QK_EPISTEMIC_MODE": "block"},
        )
        self.assertEqual(code, 2)

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

    def test_verify_command_is_recorded_without_a_fake_exit_code(self):
        # v1: Claude Code's Bash tool_response has NO exit-code field (verified by execution).
        # The hook records that a verify-shaped command RAN (source="bash-hook") + honest signals,
        # never a guessed exit code. The real exit code comes from the referee (source="referee").
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
            self.assertNotIn("exit", rec)  # never a fabricated exit code
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
        # A non-dict tool_response is still recorded (the command ran) but with null signals —
        # and never a fabricated exit code.
        with tempfile.TemporaryDirectory() as d:
            code, _ = run(
                GATE,
                {"tool_name": "Bash", "tool_input": {"command": "pytest -q"}, "tool_response": "weird string", "cwd": d},
                cwd=d,
            )
            self.assertEqual(code, 0)
            rec = json.loads(self._ledger(d)[0])
            self.assertEqual(rec["source"], "bash-hook")
            self.assertNotIn("exit", rec)
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


if __name__ == "__main__":
    unittest.main(verbosity=2)
