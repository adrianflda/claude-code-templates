// Static checks (no git, no LLM) that keep the suite hermetic: a test that reaches git — directly or
// through a script that spawns it — must import hermetic-git.mjs, and nothing outside the tests may
// import that module (it rewrites process.env for the whole process).
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const pluginRoot = join(scriptsDir, '..');
const src = (f) => readFileSync(join(scriptsDir, f), 'utf8');
const all = readdirSync(scriptsDir).filter((f) => f.endsWith('.mjs'));
const self = 'test-hygiene.test.mjs'; // names git scripts as data, never runs them
const tests = all.filter((f) => f.endsWith('.test.mjs') && f !== self);
const scripts = all.filter((f) => !f.endsWith('.test.mjs') && f !== 'hermetic-git.mjs');
const SPAWNS_GIT = /['"]git['"]/;
const IMPORTS_HERMETIC = /^import (?:\{[^}]*\} from )?'\.\/hermetic-git\.mjs';$/m;

// Scripts that spawn git, closed over scripts that reference (import or spawn) one of them.
function gitScripts() {
  const set = new Set(scripts.filter((f) => SPAWNS_GIT.test(src(f))));
  for (let grew = true; grew;) {
    grew = false;
    for (const f of scripts) {
      if (!set.has(f) && [...set].some((g) => src(f).includes(g))) { set.add(f); grew = true; }
    }
  }
  return set;
}

test('every test that reaches git imports ./hermetic-git.mjs', () => {
  const reach = gitScripts();
  assert.ok(reach.has('referee.mjs') && reach.has('route.mjs'), `scanner lost track of git scripts: ${[...reach]}`);
  const needing = tests.filter((f) => SPAWNS_GIT.test(src(f)) || [...reach].some((g) => src(f).includes(g)));
  assert.ok(needing.includes('referee.test.mjs'), `scanner found no git-using tests: ${needing}`);
  const missing = needing.filter((f) => !IMPORTS_HERMETIC.test(src(f)));
  assert.deepStrictEqual(missing, [], 'these tests reach git without importing ./hermetic-git.mjs');
});

test('no file outside the tests imports hermetic-git.mjs', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === 'node_modules' || ent.name === '.git') continue;
      const p = join(dir, ent.name);
      if (ent.isDirectory()) { walk(p); continue; }
      if (!/\.(mjs|cjs|js|ts|sh|py)$/.test(ent.name) || ent.name.endsWith('.test.mjs') || ent.name === 'hermetic-git.mjs') continue;
      if (readFileSync(p, 'utf8').includes('hermetic-git')) offenders.push(relative(pluginRoot, p));
    }
  };
  walk(pluginRoot);
  assert.deepStrictEqual(offenders, []);
});
