#!/usr/bin/env python3
"""install.py's external-tool steps, against a stand-in `uv` on PATH and a throwaway HOME (no network).
Run: python3 -I agentic-env/test_tools.py"""
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
TOOL = json.loads((HERE / 'manifest.json').read_text())['tools'][0]
SPEC = f"{TOOL['package']}=={TOOL['version']}"
INSTALL_CALL = f"tool install --no-python-downloads --python {TOOL['python']} {SPEC}"

FAKE_UV = '''#!/usr/bin/env python3
import os, sys
from pathlib import Path
a = sys.argv[1:]
state = Path(os.environ['FAKE_UV_STATE'])
if a[:2] == ['tool', 'list']:
    print(state.read_text() if state.exists() else 'No tools installed', end='')
elif a[:2] == ['python', 'find']:
    sys.exit(0 if os.environ['FAKE_UV_PYTHON'] == 'present' else 2)
elif a[:2] == ['tool', 'install']:
    with open(os.environ['FAKE_UV_LOG'], 'a') as f:
        f.write(' '.join(a) + chr(10))
    package, version = a[-1].split('==')
    state.write_text(f'{package} v{version}' + chr(10) + '- some-binary' + chr(10))
else:
    sys.exit(3)
'''


class ToolsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.home = root / 'home'
        (self.home / '.claude').mkdir(parents=True)
        self.bin = root / 'bin'
        self.bin.mkdir()
        self.state = root / 'uv-state'
        self.log = root / 'uv-calls.log'
        self.put_uv()

    def tearDown(self):
        self.tmp.cleanup()

    def put_uv(self):
        uv = self.bin / 'uv'
        uv.write_text(FAKE_UV)
        uv.chmod(uv.stat().st_mode | stat.S_IXUSR)

    def run_installer(self, *args, python='present', manifest_dir=None):
        installer = (manifest_dir or HERE) / 'install.py'
        env = {'HOME': str(self.home), 'PATH': f'{self.bin}{os.pathsep}/usr/bin{os.pathsep}/bin',
               'FAKE_UV_STATE': str(self.state), 'FAKE_UV_LOG': str(self.log), 'FAKE_UV_PYTHON': python}
        return subprocess.run([sys.executable, '-I', str(installer), '--no-plugins', *args],
                              capture_output=True, text=True, env=env, timeout=60)

    def calls(self):
        return self.log.read_text().splitlines() if self.log.exists() else []

    def tool_lines(self, r):
        return [l for l in r.stdout.splitlines() if l.startswith(('tool ', 'skip '))]

    def test_a_missing_tool_is_drift_and_check_installs_nothing(self):
        r = self.run_installer('--check')
        self.assertEqual(r.returncode, 1)
        self.assertEqual(self.tool_lines(r), [f'tool      {SPEC} not installed'])
        self.assertEqual(self.calls(), [])

    def test_install_runs_the_pinned_command_once_and_is_then_in_sync(self):
        self.assertEqual(self.run_installer().returncode, 0)
        self.assertEqual(self.calls(), [INSTALL_CALL])
        second = self.run_installer()
        self.assertEqual((second.returncode, self.calls()), (0, [INSTALL_CALL]))
        r = self.run_installer('--check')
        self.assertEqual((r.returncode, r.stdout.strip()), (0, 'OK: in sync with the repo'))

    def test_another_version_is_drift_and_install_replaces_it(self):
        self.state.write_text(f"{TOOL['package']} v0.0.1\n- some-binary\n")
        r = self.run_installer('--check')
        self.assertEqual(self.tool_lines(r), [f"tool      {TOOL['package']} 0.0.1 installed, manifest pins {TOOL['version']}"])
        self.assertEqual(self.run_installer().returncode, 0)
        self.assertEqual(self.calls(), [INSTALL_CALL.replace(SPEC, f'--force {SPEC}')])

    def test_without_uv_the_rest_installs_and_the_tool_stays_reported(self):
        (self.bin / 'uv').unlink()
        check = self.run_installer('--check')
        self.assertEqual(self.tool_lines(check), [f"tool      {TOOL['package']}: uv not found (brew install uv)"])
        r = self.run_installer()
        self.assertEqual(r.returncode, 2)
        self.assertEqual(self.tool_lines(r), ['skip      tools: uv not found (brew install uv)',
                                              f"tool      {TOOL['package']}: uv not found (brew install uv)"])
        self.assertTrue((self.home / '.claude' / 'skills' / 'code-graph' / 'SKILL.md').is_file())

    def test_without_the_pinned_python_nothing_is_downloaded(self):
        r = self.run_installer(python='absent')
        self.assertEqual(r.returncode, 2)
        self.assertIn(f"skip      {TOOL['package']}: Python {TOOL['python']} not found "
                      f"(brew install python@{TOOL['python']})", r.stdout)
        self.assertEqual(self.calls(), [])

    def test_no_tools_leaves_uv_alone(self):
        (self.bin / 'uv').unlink()
        r = self.run_installer('--no-tools')
        self.assertEqual((r.returncode, self.tool_lines(r)), (0, []))

    def test_a_manifest_value_that_could_pass_a_flag_is_refused(self):
        copy = Path(self.tmp.name) / 'repo' / 'agentic-env'
        shutil.copytree(HERE, copy, ignore=shutil.ignore_patterns('__pycache__'))
        manifest = json.loads((copy / 'manifest.json').read_text())
        manifest['tools'][0]['version'] = '--index-url=http://elsewhere'
        (copy / 'manifest.json').write_text(json.dumps(manifest))
        r = self.run_installer('--check', manifest_dir=copy)
        self.assertEqual(r.returncode, 2)
        self.assertIn('unsafe or missing version', r.stderr)
        self.assertEqual(self.calls(), [])


if __name__ == '__main__':
    unittest.main()
