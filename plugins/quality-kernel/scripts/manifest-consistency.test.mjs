// Static release-consistency gate (no LLM). The marketplace entry drifted from plugin.json
// for several releases (CHANGELOG 0.5.0); this keeps every declared version and every agent's
// model in one agreed state.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(pluginRoot, '..', '..');
const marketplacePath = join(repoRoot, '.claude-plugin', 'marketplace.json');
// An installed copy (plugin cache) has no marketplace above it; the source repo must.
const inSourceRepo = existsSync(join(repoRoot, '.git'));
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
// Claude Code's model aliases; any agent file, known or not, must use one of them.
const ALLOWED_ALIASES = new Set(['sonnet', 'opus', 'haiku', 'inherit']);

function frontmatterModel(md, file) {
  const m = md.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---/);
  assert.ok(m, `${file}: no YAML frontmatter`);
  const models = m[1].split('\n').filter((l) => /^model:/.test(l));
  assert.strictEqual(models.length, 1, `${file}: expected exactly one model: key`);
  return models[0].replace(/^model:\s*/, '').replace(/\s+#.*$/, '').trim().replace(/^(['"])(.*)\1$/, '$2');
}

test('plugin.json version is SemVer', () => {
  assert.match(version, /^\d+\.\d+\.\d+$/);
});

test('marketplace.json quality-kernel entry version equals plugin.json version', {
  skip: !inSourceRepo && 'installed copy: no source repo, so no marketplace.json to compare',
}, () => {
  assert.ok(existsSync(marketplacePath), `source repo without ${relative(repoRoot, marketplacePath)}`);
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

const agentFiles = readdirSync(join(pluginRoot, 'agents')).filter((f) => f.endsWith('.md'));

test('the agent set is exactly the six pipeline stages', () => {
  assert.deepStrictEqual(agentFiles.map((f) => f.slice(0, -3)).sort(), Object.keys(EXPECTED_MODELS).sort());
});

test('every agent file, known or not, declares a model alias (never a literal ID)', () => {
  const literal = agentFiles
    .map((f) => [f, frontmatterModel(read(`agents/${f}`), `agents/${f}`)])
    .filter(([, model]) => !ALLOWED_ALIASES.has(model));
  assert.deepStrictEqual(literal, []);
});

for (const [agent, expected] of Object.entries(EXPECTED_MODELS)) {
  test(`agent ${agent} declares model alias ${expected}`, () => {
    const file = `agents/${agent}.md`;
    assert.strictEqual(frontmatterModel(read(file), file), expected);
  });
}
