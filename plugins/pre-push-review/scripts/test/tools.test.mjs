import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULTS } from '../lib/config.mjs';
import { makeRelativizer, parseEslintJson, parseEslintStylish, parseGnu, parseSarif, parseTsc } from '../lib/parsers.mjs';
import { resolveScope } from '../lib/scope.mjs';
import { buildSnapshot, detectCommands, filterToChange, isInstalled, runTools } from '../lib/tools.mjs';
import { diffFile, makeRepo, remove, tempDir, write } from './helpers.mjs';

const rel = makeRelativizer(['/repo']);

// Captured from tsc 5.9.3, non-TTY and --pretty (ANSI sequences included).
const TSC_PLAIN = `src/a.ts(4,7): error TS2322: Type 'number' is not assignable to type 'string'.
src/a.ts(5,27): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.
`;
const TSC_PRETTY = `\u001b[96msrc/a.ts\u001b[0m:\u001b[93m4\u001b[0m:\u001b[93m7\u001b[0m - \u001b[91merror\u001b[0m\u001b[90m TS2322: \u001b[0mType 'number' is not assignable to type 'string'.

\u001b[7m4\u001b[0m const total: string = add(1, 2);
\u001b[7m \u001b[0m \u001b[91m      ~~~~~\u001b[0m

Found 1 error in src/a.ts\u001b[90m:4\u001b[0m
`;

test('parseTsc — plain and pretty output give the same findings', () => {
  const plain = parseTsc(TSC_PLAIN, rel);
  assert.equal(plain.length, 2);
  assert.deepEqual({ file: plain[0].file, line: plain[0].line, rule: plain[0].rule, severity: plain[0].severity }, { file: 'src/a.ts', line: 4, rule: 'TS2322', severity: 'high' });
  assert.equal(plain[1].line, 5);
  const pretty = parseTsc(TSC_PRETTY, rel);
  assert.equal(pretty.length, 1);
  assert.equal(pretty[0].title, plain[0].title);
});

test('parseTsc — unrelated output produces nothing', () => {
  assert.deepEqual(parseTsc('> build\n> tsc --noEmit\n\nDone in 2.1s\n', rel), []);
});

test('parseEslintStylish — rows are attributed to the file header above them', () => {
  const out = `
/repo/src/a.ts
   3:10  error    'x' is defined but never used  @typescript-eslint/no-unused-vars
  12:1   warning  Unexpected console statement   no-console

/repo/src/b.ts
  7:5  error  Parsing error: Unexpected token

✖ 3 problems (2 errors, 1 warning)
`;
  const f = parseEslintStylish(out, rel);
  assert.equal(f.length, 3);
  assert.deepEqual([f[0].file, f[0].line, f[0].rule, f[0].severity], ['src/a.ts', 3, '@typescript-eslint/no-unused-vars', 'medium']);
  assert.deepEqual([f[1].file, f[1].line, f[1].rule, f[1].severity], ['src/a.ts', 12, 'no-console', 'low']);
  assert.deepEqual([f[2].file, f[2].line, f[2].rule], ['src/b.ts', 7, null]);
  assert.equal(f[2].title, 'Parsing error: Unexpected token');
});

test('parseEslintJson — tolerates text printed before the JSON', () => {
  const doc = [{ filePath: '/repo/src/a.ts', messages: [{ ruleId: 'eqeqeq', severity: 2, message: 'Expected ===', line: 9, endLine: 9 }, { ruleId: null, severity: 1, message: 'soft', line: 2 }] }];
  const f = parseEslintJson(`Warning: something deprecated\n${JSON.stringify(doc)}`, rel);
  assert.equal(f.length, 2);
  assert.deepEqual([f[0].file, f[0].line, f[0].severity, f[0].rule], ['src/a.ts', 9, 'medium', 'eqeqeq']);
  assert.equal(f[1].severity, 'low');
  assert.throws(() => parseEslintJson('no json here', rel));
});

test('parseGnu — file:line[:col]: message, ignoring prose and URLs', () => {
  const f = parseGnu('src/a.py:12:4: error: undefined name x\nsrc/b.go:3: unused variable\nsee https://example.com:443/docs: more\nSome sentence: 12: not a path\n', rel);
  assert.equal(f.length, 2);
  assert.deepEqual([f[0].file, f[0].line, f[0].severity, f[0].title], ['src/a.py', 12, 'high', 'undefined name x']);
  assert.deepEqual([f[1].file, f[1].line, f[1].severity], ['src/b.go', 3, 'medium']);
});

test('parseSarif — levels, security-severity, and paths outside every base are dropped', () => {
  const sarif = {
    version: '2.1.0',
    runs: [
      {
        tool: { driver: { name: 'scanner', rules: [{ id: 'R1', properties: { 'security-severity': '9.1' } }, { id: 'R2', defaultConfiguration: { level: 'note' } }] } },
        results: [
          { ruleId: 'R1', message: { text: 'injection' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'file:///repo/src/a.ts' }, region: { startLine: 4, endLine: 6 } } }] },
          { ruleId: 'R2', message: { text: 'style' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'src/b.ts' }, region: { startLine: 1 } } }] },
          { ruleId: 'R3', level: 'error', message: { text: 'elsewhere' }, locations: [{ physicalLocation: { artifactLocation: { uri: '/etc/passwd' }, region: { startLine: 1 } } }] },
          { ruleId: 'R4', message: { text: 'no location' } },
        ],
      },
    ],
  };
  const f = parseSarif(JSON.stringify(sarif), rel);
  assert.equal(f.length, 2);
  assert.deepEqual([f[0].file, f[0].line, f[0].endLine, f[0].severity], ['src/a.ts', 4, 6, 'critical']);
  assert.deepEqual([f[1].file, f[1].severity], ['src/b.ts', 'low']);
  assert.throws(() => parseSarif('not json', rel));
});

test('relativizer — absolute paths are mapped through any base, including its real path', () => {
  const dir = tempDir();
  try {
    const r = makeRelativizer([dir]);
    assert.equal(r(join(dir, 'src', 'a.ts')), 'src/a.ts');
    assert.equal(r('./src/a.ts'), 'src/a.ts');
    assert.equal(r(dir), null);
    assert.equal(r('/somewhere/else.ts'), null);
    assert.equal(r(''), null);
  } finally {
    remove(dir);
  }
});

test('filterToChange — "lines" keeps only added lines, "file" keeps the whole changed file', () => {
  const byPath = new Map([['src/a.ts', diffFile('src/a.ts', { added: [10], context: [9, 11] })]]);
  const findings = [
    { file: 'src/a.ts', line: 10 },
    { file: 'src/a.ts', line: 11 },
    { file: 'src/a.ts', line: null },
    { file: 'src/untouched.ts', line: 10 },
  ];
  const lines = filterToChange(findings, byPath, 'lines');
  assert.deepEqual(lines.kept.map((f) => f.line), [10, null]);
  assert.equal(lines.outside, 2);
  const file = filterToChange(findings, byPath, 'file');
  assert.deepEqual(file.kept.map((f) => f.line), [10, 11, null]);
  assert.equal(file.outside, 1);
});

test('detectCommands — needs package.json scripts AND installed dependencies', () => {
  const dir = tempDir();
  try {
    assert.deepEqual(detectCommands(dir), []);
    write(dir, 'package.json', JSON.stringify({ scripts: { 'type-check': 'tsc --noEmit', lint: 'eslint .', test: 'jest' } }));
    assert.deepEqual(detectCommands(dir), [], 'without node_modules the commands cannot run');
    write(dir, 'node_modules/.keep', '');
    const found = detectCommands(dir);
    assert.deepEqual(found.map((c) => [c.name, c.run, c.parser, c.scope]), [
      ['typecheck', 'npm run --silent type-check', 'tsc', 'file'],
      ['lint', 'npm run --silent lint', 'eslint-stylish', 'lines'],
    ]);
    write(dir, 'package.json', '{ broken');
    assert.deepEqual(detectCommands(dir), []);
  } finally {
    remove(dir);
  }
});

const config = (over = {}) => ({ ...DEFAULTS, tools: { ...DEFAULTS.tools, gitleaks: false, autoDetect: false, timeoutMs: 20_000, ...over } });

function branchScope(repo) {
  return resolveScope({ cwd: repo.root, mode: 'base', base: 'main', exclude: [] });
}

test('snapshot — holds the reviewed version of changed files, not deleted or binary ones', () => {
  const repo = makeRepo({ 'a.txt': 'one\n', 'gone.txt': 'x\n' });
  try {
    repo.git('switch', '--quiet', '-c', 'feature');
    repo.commit('change', { 'a.txt': 'one\ntwo\n', 'gone.txt': null, 'new/b.txt': 'b\n' });
    repo.write('a.txt', 'one\ntwo\nUNCOMMITTED\n');
    const scope = branchScope(repo);
    const snap = buildSnapshot(scope);
    try {
      assert.equal(snap.written, 2);
      assert.equal(existsSync(join(snap.dir, 'gone.txt')), false);
      assert.equal(existsSync(join(snap.dir, 'new/b.txt')), true);
      assert.equal(repo.git('hash-object', join(snap.dir, 'a.txt')), repo.git('rev-parse', 'HEAD:a.txt'), 'committed content, not the working tree');
    } finally {
      snap.cleanup();
    }
    assert.equal(existsSync(snap.dir), false);
  } finally {
    remove(repo.root);
  }
});

test('runTools — a configured command reports findings on the change and counts the rest', async () => {
  const repo = makeRepo({ 'src/a.ts': 'one\ntwo\nthree\n', 'src/old.ts': 'x\n' });
  try {
    repo.git('switch', '--quiet', '-c', 'feature');
    repo.commit('change', { 'src/a.ts': 'one\ntwo\nthree\nfour\n' });
    const scope = branchScope(repo);
    const byPath = new Map(scope.files.map((f) => [f.path, f]));
    const run = `printf 'src/a.ts:4:1: error: bad thing\\nsrc/a.ts:1:1: error: old thing\\nsrc/old.ts:1:1: error: untouched\\n'; exit 1`;
    const [result] = await runTools({ scope, config: config({ commands: [{ name: 'check', run, parser: 'gnu' }] }), byPath });
    assert.equal(result.status, 'findings');
    assert.deepEqual(result.findings.map((f) => [f.file, f.line]), [['src/a.ts', 4]]);
    assert.equal(result.outsideChange, 2);
  } finally {
    remove(repo.root);
  }
});

test('runTools — a failing command with nothing parseable is "failed", never a silent pass', async () => {
  const repo = makeRepo({ 'a.txt': 'one\n' });
  try {
    repo.git('switch', '--quiet', '-c', 'feature');
    repo.commit('change', { 'a.txt': 'two\n' });
    const scope = branchScope(repo);
    const byPath = new Map(scope.files.map((f) => [f.path, f]));
    const results = await runTools({
      scope,
      byPath,
      config: config({
        commands: [
          { name: 'tests', run: 'echo "3 tests failed" >&2; exit 1', parser: 'exit-code', required: true },
          { name: 'green', run: 'exit 0', parser: 'exit-code' },
          { name: 'garbage', run: 'echo "not sarif"', parser: 'sarif' },
          { name: 'slow', run: 'sleep 30', parser: 'exit-code', timeoutMs: 300 },
        ],
      }),
    });
    const by = Object.fromEntries(results.map((r) => [r.name, r]));
    assert.equal(by.tests.status, 'failed');
    assert.equal(by.tests.required, true);
    assert.match(by.tests.outputTail, /3 tests failed/);
    assert.equal(by.green.status, 'ok');
    assert.equal(by.garbage.status, 'error');
    assert.match(by.garbage.reason, /could not parse sarif/);
    assert.equal(by.slow.status, 'timeout');
  } finally {
    remove(repo.root);
  }
});

test('runTools — repo commands are refused for fetched code and for a dirty working tree', async () => {
  const repo = makeRepo({ 'a.txt': 'one\n' });
  try {
    repo.git('switch', '--quiet', '-c', 'feature');
    repo.commit('change', { 'a.txt': 'two\n' });
    const cfg = config({ commands: [{ name: 'check', run: 'touch SHOULD_NOT_EXIST', parser: 'exit-code' }] });

    const fetched = { ...branchScope(repo), repoCommandsAllowed: false };
    const [a] = await runTools({ scope: fetched, config: cfg, byPath: new Map() });
    assert.equal(a.status, 'skipped');
    assert.match(a.reason, /fetched from a pull request/);

    repo.write('a.txt', 'three\n');
    const dirty = branchScope(repo);
    assert.deepEqual(dirty.dirtyPaths, ['a.txt']);
    const [b] = await runTools({ scope: dirty, config: cfg, byPath: new Map() });
    assert.equal(b.status, 'skipped');
    assert.match(b.reason, /working tree differs/);

    const [c] = await runTools({ scope: branchScope(repo), config: cfg, byPath: new Map(), allowRepoCommands: false });
    assert.equal(c.status, 'skipped');
    assert.equal(existsSync(join(repo.root, 'SHOULD_NOT_EXIST')), false);
  } finally {
    remove(repo.root);
  }
});

test('gitleaks — a secret added by the change is critical; one already in the file is not reported', async (t) => {
  if (!(await isInstalled('gitleaks'))) return t.skip('gitleaks is not installed');
  // Assembled at runtime so this test file itself holds no secret-shaped literal.
  // The GitHub token rule needs exactly 36 characters after the prefix.
  const token = (seed) => ['ghp', `${seed}1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8`].join('_');
  const repo = makeRepo({ 'src/cfg.js': `const old = "${token('X')}";\nconst region = "us-east-1";\n` });
  try {
    repo.git('switch', '--quiet', '-c', 'feature');
    repo.commit('add token', { 'src/cfg.js': `const old = "${token('X')}";\nconst region = "us-east-1";\nconst fresh = "${token('Y')}";\n` });
    const scope = branchScope(repo);
    const byPath = new Map(scope.files.map((f) => [f.path, f]));
    const [result] = await runTools({ scope, config: config({ gitleaks: true }), byPath });
    assert.equal(result.name, 'gitleaks');
    assert.equal(result.status, 'findings', result.reason);
    assert.deepEqual(result.findings.map((f) => [f.file, f.line, f.severity]), [['src/cfg.js', 3, 'critical']]);
    assert.equal(result.outsideChange, 1);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(token('Y')), 'the secret itself never appears in the result');
  } finally {
    remove(repo.root);
  }
});
