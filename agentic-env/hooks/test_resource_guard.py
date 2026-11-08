"""resource-guard: warns before a heavy command only when reclaimable RAM is low, never on swap alone.

2026-10-28 audit: 425 warnings in 30 days, every one triggered by swap > 75% with >= 3 GB reclaimable.
Fake `sysctl` / `vm_stat` on PATH stand in for the machine. Run: python3 -m unittest discover -s ~/.claude/hooks -p 'test_*.py'
"""
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HOOK = Path(__file__).with_name('resource-guard.py')
PAGE = 16384


def fake_machine(free_mb, swap_pct):
    d = Path(tempfile.mkdtemp())
    pages = int(free_mb * 1048576 / PAGE)
    tools = {
        'sysctl': f'echo "total = 4096.00M  used = {4096 * swap_pct / 100:.2f}M  free = 1.00M  (encrypted)"',
        'vm_stat': f'printf "Mach Virtual Memory Statistics: (page size of {PAGE} bytes)\\n'
                   f'Pages free:  {pages // 2}.\\nPages inactive:  {pages - pages // 2}.\\n"',
    }
    for name, body in tools.items():
        p = d / name
        p.write_text('#!/bin/sh\n' + body + '\n')
        p.chmod(p.stat().st_mode | stat.S_IXUSR)
    return str(d)


def run(cmd, free_mb, swap_pct):
    env = {**os.environ, 'PATH': fake_machine(free_mb, swap_pct) + os.pathsep + os.environ['PATH']}
    r = subprocess.run([sys.executable, str(HOOK)], input=json.dumps({'tool_input': {'command': cmd}}),
                       capture_output=True, text=True, timeout=10, env=env)
    return r.returncode, r.stdout


class ResourceGuardTest(unittest.TestCase):
    def test_low_ram_before_a_heavy_command_warns_without_blocking(self):
        code, out = run('npm run build', free_mb=800, swap_pct=10)
        self.assertEqual(code, 0)
        self.assertIn('RESOURCE-GUARD', json.loads(out)['hookSpecificOutput']['additionalContext'])

    def test_high_swap_with_plenty_of_ram_is_silent(self):
        self.assertEqual(run('npx playwright test', free_mb=3500, swap_pct=90), (0, ''))

    def test_a_light_command_is_silent_even_with_low_ram(self):
        self.assertEqual(run('ls -la', free_mb=500, swap_pct=95), (0, ''))


if __name__ == '__main__':
    unittest.main()
