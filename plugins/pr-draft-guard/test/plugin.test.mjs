import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('the SessionStart hook puts RULE.md into the session context', () => {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'inject-rule.mjs')], {
    input: '{}', encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_ROOT: ROOT },
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, 'SessionStart');
  assert.equal(out.additionalContext, readFileSync(join(ROOT, 'RULE.md'), 'utf8').trim());
});

test('every script hooks.json points to exists, and the manifest names the plugin', () => {
  const hooks = JSON.parse(readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks;
  const cmds = Object.values(hooks).flat().flatMap((h) => h.hooks.map((x) => x.command));
  assert.ok(cmds.length >= 2);
  for (const c of cmds) {
    const rel = c.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)/)[1];
    assert.ok(existsSync(join(ROOT, rel)), rel);
  }
  const manifest = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(manifest.name, pkg.name);
});
