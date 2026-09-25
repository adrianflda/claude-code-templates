// Static checks (no git, no LLM) that keep the suite hermetic: a test that reaches git — directly or
// through a script or hook that runs it — must import hermetic-git.mjs before anything else, and
// nothing outside the tests may import that module (it rewrites process.env for the whole process).
// A heuristic tripwire for mistakes, not a sandbox: it scans source text, so a deliberately obfuscated
// spawn would get past it.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const pluginRoot = join(scriptsDir, '..');
const hooksDir = join(pluginRoot, 'hooks');
const read = (dir, f) => readFileSync(join(dir, f), 'utf8');
const self = 'test-hygiene.test.mjs'; // names git scripts as data, never runs them
const all = readdirSync(scriptsDir).filter((f) => f.endsWith('.mjs'));
const tests = all.filter((f) => f.endsWith('.test.mjs') && f !== self);
const scripts = all.filter((f) => !f.endsWith('.test.mjs') && f !== 'hermetic-git.mjs');
// git as an argv token ('git', "git", `git`) or at the start of a shell string ('git init', `git -C`).
const JS_SPAWNS_GIT = /['"`]git(?:['"`]|\s)/;
const SHELL_RUNS_GIT = /(?:^|[\s;&|(`$])git\s/m;
const FIRST_IMPORT_IS_HERMETIC = /^(?:\/\/[^\n]*\n|\s*\n)*import (?:\{[^}]*\} from )?'\.\/hermetic-git\.mjs';/;

// Everything that runs git: scripts that spawn it, hooks that call it, closed over scripts that
// reference (import or spawn) one of them.
function gitTargets() {
  const set = new Set(scripts.filter((f) => JS_SPAWNS_GIT.test(read(scriptsDir, f))));
  for (const h of readdirSync(hooksDir)) if (!h.endsWith('.py') && SHELL_RUNS_GIT.test(read(hooksDir, h))) set.add(h);
  for (let grew = true; grew;) {
    grew = false;
    for (const f of scripts) {
      if (!set.has(f) && [...set].some((g) => read(scriptsDir, f).includes(g))) { set.add(f); grew = true; }
    }
  }
  return set;
}

test('every test that reaches git imports ./hermetic-git.mjs as its first import', () => {
  const targets = gitTargets();
  for (const anchor of ['referee.mjs', 'route.mjs', 'pre-push.sample']) {
    assert.ok(targets.has(anchor), `scanner lost track of ${anchor}: ${[...targets]}`);
  }
  const needing = tests.filter((f) => {
    const s = read(scriptsDir, f);
    return JS_SPAWNS_GIT.test(s) || [...targets].some((g) => s.includes(g));
  });
  for (const anchor of ['referee.test.mjs', 'pre-push.test.mjs']) {
    assert.ok(needing.includes(anchor), `scanner missed ${anchor}: ${needing}`);
  }
  const missing = needing.filter((f) => !FIRST_IMPORT_IS_HERMETIC.test(read(scriptsDir, f)));
  assert.deepStrictEqual(missing, [], 'these tests reach git without importing ./hermetic-git.mjs first');
});

test('no file outside the tests imports hermetic-git.mjs', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === 'node_modules' || ent.name === '.git') continue;
      const p = join(dir, ent.name);
      if (ent.isDirectory()) { walk(p); continue; }
      if (!/\.(mjs|cjs|js|ts|sh|py|sample)$/.test(ent.name) || ent.name.endsWith('.test.mjs') || ent.name === 'hermetic-git.mjs') continue;
      if (readFileSync(p, 'utf8').includes('hermetic-git')) offenders.push(relative(pluginRoot, p));
    }
  };
  walk(pluginRoot);
  assert.deepStrictEqual(offenders, []);
});
