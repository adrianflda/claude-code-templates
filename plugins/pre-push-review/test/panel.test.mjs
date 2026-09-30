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
  const bin = executable(
    join(dir, 'claude'),
    `#!/usr/bin/env node
const fs = require('node:fs');
let prompt = '';
process.stdin.on('data', (d) => { prompt += d; });
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(capture)}, prompt + '\\n=====\\n');
  process.stdout.write(${JSON.stringify(reply)});
  process.exit(${exit});
});
`,
  );
  return { bin, prompts: () => (existsSync(capture) ? readFileSync(capture, 'utf8') : '') };
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
