import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { SCRIPTS, executable, git, makeRepo, runNode, tempDir, write } from './helpers.mjs';

const PANEL = join(SCRIPTS, 'ai-review-panel.mjs');

/** A `claude` stand-in: records the prompt it was given and replies as told. */
function fakeClaude({ reply = '{"findings":[],"summary":"LGTM"}', exit = 0 } = {}) {
  const dir = tempDir('claude');
  const capture = join(dir, 'prompts.txt');
  const argvCapture = join(dir, 'argv.jsonl');
  const bin = executable(
    join(dir, 'claude'),
    `#!/usr/bin/env node
const fs = require('node:fs');
let prompt = '';
process.stdin.on('data', (d) => { prompt += d; });
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(argvCapture)}, JSON.stringify(process.argv.slice(2)) + '\\n');
  fs.appendFileSync(${JSON.stringify(capture)}, prompt + '\\n=====\\n');
  process.stdout.write(${JSON.stringify(reply)});
  process.exit(${exit});
});
`,
  );
  return {
    bin,
    prompts: () => (existsSync(capture) ? readFileSync(capture, 'utf8') : ''),
    argvs: () =>
      existsSync(argvCapture)
        ? readFileSync(argvCapture, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
        : [],
  };
}

/** `main` plus a feature branch that deletes one file, edits one and adds one. */
function repoWithDeletion() {
  const repo = makeRepo('panel', {
    'keep.js': 'export const keep = 1;\n',
    'dead.js': 'export const SECRET_MARKER_IN_DELETED_FILE = 1;\n',
  });
  git(repo, 'checkout', '-q', '-b', 'feature');
  rmSync(join(repo, 'dead.js'));
  write(repo, { 'keep.js': 'export const keep = 2;\n', 'new.js': 'export const added = true;\n' });
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'remove dead.js');
  return repo;
}

test('deleted files reach the reviewers by name, without their content', () => {
  const repo = repoWithDeletion();
  const claude = fakeClaude();
  const result = runNode(PANEL, { args: ['--branch', '--base', 'main'], cwd: repo, env: { CLAUDE_BIN: claude.bin } });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /1 deleted file\(s\)/);
  assert.match(result.stdout, /SUMMARY: 0 critical/);

  const prompts = claude.prompts();
  assert.match(prompts, /deleted file mode/);
  assert.match(prompts, /a\/dead\.js/);
  assert.match(prompts, /1 file\(s\) are deleted in this diff/);
  assert.doesNotMatch(prompts, /SECRET_MARKER_IN_DELETED_FILE/, 'removed content is not sent');
  assert.match(prompts, /export const keep = 2;/);
  assert.match(prompts, /export const added = true;/);
});

/** The value that follows `flag` in an argv, or undefined when the flag is absent. */
const flagValue = (argv, flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);

test('reviewers run with no tools, so a diff cannot steer them into running commands', () => {
  const repo = repoWithDeletion();
  const claude = fakeClaude();
  const result = runNode(PANEL, { args: ['--branch', '--base', 'main'], cwd: repo, env: { CLAUDE_BIN: claude.bin } });

  assert.equal(result.code, 0, result.stderr);
  const argvs = claude.argvs();
  assert.ok(argvs.length >= 1, 'at least one reviewer ran');
  for (const argv of argvs) {
    assert.equal(flagValue(argv, '--tools'), '', 'every built-in tool is disabled');
    assert.equal(flagValue(argv, '--permission-mode'), 'dontAsk', 'never auto mode');
    assert.equal(flagValue(argv, '--permission-prompts'), 'none', 'nothing waits for or gets an approval');
    assert.ok(argv.includes('--strict-mcp-config'), 'no MCP servers');
    assert.equal(flagValue(argv, '--setting-sources'), '', 'no user or project settings');
  }
});

test('reviewers are told to report real defects only, keeping the output and severity rules', () => {
  const repo = repoWithDeletion();
  const claude = fakeClaude();
  const result = runNode(PANEL, { args: ['--branch', '--base', 'main'], cwd: repo, env: { CLAUDE_BIN: claude.bin } });

  assert.equal(result.code, 0, result.stderr);
  const prompts = claude.prompts();
  assert.match(prompts, /report only real defects within your focus area/);
  assert.match(prompts, /never speculative hardening/);
  assert.match(prompts, /reserve "critical" for defects that must block a release/);
  assert.match(prompts, /\{"findings":\[\{"severity":"critical\|high\|medium\|low"/);
});

test('a deletion-only change is reviewed instead of reported as no changes', () => {
  const repo = makeRepo('panel', { 'a.js': 'a\n', 'b.js': 'b\n' });
  git(repo, 'checkout', '-q', '-b', 'feature');
  rmSync(join(repo, 'b.js'));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'remove b.js');
  const claude = fakeClaude();
  const result = runNode(PANEL, { args: ['--branch', '--base', 'main'], cwd: repo, env: { CLAUDE_BIN: claude.bin } });

  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /No code changes to review/);
  assert.match(claude.prompts(), /b\/b\.js|a\/b\.js/);
});

test('--base alone reviews the branch', () => {
  const repo = repoWithDeletion();
  const claude = fakeClaude();
  const result = runNode(PANEL, { args: ['--base', 'main'], cwd: repo, env: { CLAUDE_BIN: claude.bin } });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Reviewing branch changes vs main/);
  assert.match(claude.prompts(), /export const keep = 2;/);
});

test('staged mode sees a staged deletion', () => {
  const repo = makeRepo('panel', { 'a.js': 'a\n', 'b.js': 'b\n' });
  git(repo, 'rm', '-q', 'b.js');
  const claude = fakeClaude();
  const result = runNode(PANEL, { cwd: repo, env: { CLAUDE_BIN: claude.bin } });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /1 deleted file\(s\)/);
});

test('blocks on a critical finding', () => {
  const repo = repoWithDeletion();
  const claude = fakeClaude({
    reply: '{"findings":[{"severity":"critical","file":"keep.js","line":1,"issue":"breaks the core","suggestion":"revert"}],"summary":"bad"}',
  });
  const result = runNode(PANEL, { args: ['--branch', '--base', 'main'], cwd: repo, env: { CLAUDE_BIN: claude.bin } });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /breaks the core/);
});

test('when no reviewer can run: exit 2 if required, exit 0 if advisory', () => {
  const repo = repoWithDeletion();
  const claude = fakeClaude({ reply: 'not json', exit: 1 });
  const env = { CLAUDE_BIN: claude.bin, AI_REVIEW_TIMEOUT_MS: '20000' };

  const required = runNode(PANEL, {
    args: ['--branch', '--base', 'main'],
    cwd: repo,
    env: { ...env, AI_REVIEW_REQUIRED: '1' },
  });
  assert.equal(required.code, 2);
  assert.match(required.stderr, /All review agents failed/);

  const advisory = runNode(PANEL, { args: ['--branch', '--base', 'main'], cwd: repo, env });
  assert.equal(advisory.code, 0);
  assert.match(advisory.stderr, /All review agents failed/);
});

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

test('--range from the empty tree reviews a root commit (first push to an empty remote)', () => {
  const repo = makeRepo('root', { 'first.js': 'export const first = 1;\n' });
  const head = git(repo, 'rev-parse', 'HEAD');
  const claude = fakeClaude();
  const result = runNode(PANEL, { args: ['--range', EMPTY_TREE, head], cwd: repo, env: { CLAUDE_BIN: claude.bin } });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Reviewing 1 commit\(s\) being pushed/);
  assert.match(claude.prompts(), /export const first = 1;/);
});

test('--range reviews the given head, not HEAD', () => {
  const repo = makeRepo('range', { 'a.js': 'a\n' });
  const base = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'switch', '-q', '-c', 'feat');
  write(repo, { 'feat.js': 'export const onFeat = true;\n' });
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'feat');
  const head = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'switch', '-q', 'main');
  write(repo, { 'main.js': 'export const onMain = true;\n' });
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'main');
  const claude = fakeClaude();
  const result = runNode(PANEL, { args: ['--range', base, head], cwd: repo, env: { CLAUDE_BIN: claude.bin } });

  assert.equal(result.code, 0, result.stderr);
  assert.match(claude.prompts(), /onFeat/);
  assert.doesNotMatch(claude.prompts(), /onMain/);
});

test('--range refuses anything but full object names', () => {
  const repo = makeRepo('bad');
  for (const args of [['--range', 'HEAD~1', 'HEAD'], ['--range', 'abc', 'def'], ['--range', `${EMPTY_TREE};id`, EMPTY_TREE]]) {
    const result = runNode(PANEL, { args, cwd: repo });
    assert.equal(result.code, 2, args.join(' '));
    assert.match(result.stderr, /--range needs two full object names/);
  }
});
