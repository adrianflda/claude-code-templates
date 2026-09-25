// Static release-consistency gate (no LLM). The marketplace entry drifted from plugin.json
// for several releases (CHANGELOG 0.5.0); this keeps every declared version and every agent's
// model in one agreed state.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const marketplacePath = join(pluginRoot, '..', '..', '.claude-plugin', 'marketplace.json');
const read = (p) => readFileSync(join(pluginRoot, p), 'utf8');
const version = JSON.parse(read('.claude-plugin/plugin.json')).version;

// The contract: stage -> model alias. Literal model IDs are not allowed (they override the
// user's ANTHROPIC_DEFAULT_*_MODEL and break Bedrock/Vertex/gateway users — see README "Models").
const EXPECTED_MODELS = {
  specifier: 'sonnet',
  coder: 'sonnet',
  cleaner: 'sonnet',
  architect: 'opus',
  hardener: 'opus',
  qa: 'opus',
};
const ALLOWED_ALIASES = new Set(['sonnet', 'opus', 'haiku', 'inherit']);

function frontmatterModel(md, file) {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(m, `${file}: no YAML frontmatter`);
  const models = m[1].split('\n').filter((l) => /^model:/.test(l));
  assert.strictEqual(models.length, 1, `${file}: expected exactly one model: key`);
  return models[0].replace(/^model:\s*/, '').replace(/\s+#.*$/, '').trim();
}

test('plugin.json version is SemVer', () => {
  assert.match(version, /^\d+\.\d+\.\d+$/);
});

test('marketplace.json quality-kernel entry version equals plugin.json version', {
  skip: !existsSync(marketplacePath) && 'marketplace.json not present (installed copy, not the source repo)',
}, () => {
  const entries = JSON.parse(readFileSync(marketplacePath, 'utf8')).plugins.filter((p) => p.name === 'quality-kernel');
  assert.strictEqual(entries.length, 1, 'exactly one quality-kernel entry in marketplace.json');
  assert.strictEqual(entries[0].version, version);
});

test('README status line and gate-status heading name the plugin.json version', () => {
  const readme = read('README.md');
  assert.strictEqual(readme.match(/^> Status: \*\*v(\d+\.\d+\.\d+)\.\*\*/m)?.[1], version, 'README "> Status: **vX.Y.Z.**"');
  assert.strictEqual(readme.match(/^## Gate status .*\(v(\d+\.\d+\.\d+)\)$/m)?.[1], version, 'README "## Gate status ... (vX.Y.Z)"');
});

test('newest released CHANGELOG entry is the plugin.json version', () => {
  const top = read('CHANGELOG.md').match(/^## \[(\d+\.\d+\.\d+)\]/m)?.[1];
  assert.strictEqual(top, version);
});

test('the agent set is exactly the six pipeline stages', () => {
  const agents = readdirSync(join(pluginRoot, 'agents')).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort();
  assert.deepStrictEqual(agents, Object.keys(EXPECTED_MODELS).sort());
});

for (const [agent, expected] of Object.entries(EXPECTED_MODELS)) {
  test(`agent ${agent} declares model alias ${expected}`, () => {
    const file = `agents/${agent}.md`;
    const model = frontmatterModel(read(file), file);
    assert.ok(ALLOWED_ALIASES.has(model), `${file}: "${model}" is not an alias (literal model IDs are not allowed)`);
    assert.strictEqual(model, expected);
  });
}
