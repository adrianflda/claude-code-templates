// Test helpers: hermetic git repositories and a scripted stand-in for the claude CLI.
//
// Importing this module makes every git process the tests spawn ignore the developer's own git
// configuration. Without that, a global `core.hooksPath` runs the developer's hooks on fixture
// commits and a global excludes file hides fixture files.

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const FAKE_CLAUDE = join(here, 'fake-claude.mjs');
export const REVIEW_CLI = join(here, '..', 'review.mjs');

if (process.env.PPR_HERMETIC_GIT !== '1') {
  Object.assign(process.env, {
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'core.excludesFile',
    GIT_CONFIG_VALUE_0: devNull,
    GIT_CONFIG_KEY_1: 'core.attributesFile',
    GIT_CONFIG_VALUE_1: devNull,
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
    PPR_HERMETIC_GIT: '1',
  });
}

export function tempDir(prefix = 'ppr-test-') {
  // realpath: on macOS the temp dir is a symlink, and git reports the resolved path.
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export function remove(dir) {
  rmSync(dir, { recursive: true, force: true });
}

export function sh(cwd, file, args) {
  return execFileSync(file, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export function write(root, path, content) {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

/** A repository with one commit on `main`. Returns { root, git, commit, write }. */
export function makeRepo(files = { 'README.md': '# fixture\n' }) {
  const root = tempDir('ppr-repo-');
  const git = (...args) => sh(root, 'git', args).trim();
  git('init', '--quiet', '--initial-branch=main');
  const commit = (message, changes = {}) => {
    for (const [path, content] of Object.entries(changes)) {
      if (content === null) rmSync(join(root, path));
      else write(root, path, content);
    }
    git('add', '--all');
    git('commit', '--quiet', '--allow-empty', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  commit('initial', files);
  return { root, git, commit, write: (path, content) => write(root, path, content) };
}

/**
 * Environment that points the harness at the scripted CLI and at throwaway state.
 * `script` maps a substring of the agent's system prompt to the reply it gets; see fake-claude.mjs.
 */
export function fakeEnv(script, extra = {}) {
  const home = tempDir('ppr-home-');
  const scriptFile = join(home, 'script.json');
  const logFile = join(home, 'calls.jsonl');
  writeFileSync(scriptFile, JSON.stringify(script));
  chmodSync(FAKE_CLAUDE, 0o755);
  return {
    env: {
      ...process.env,
      CLAUDE_BIN: FAKE_CLAUDE,
      FAKE_CLAUDE_SCRIPT: scriptFile,
      FAKE_CLAUDE_LOG: logFile,
      PREPUSH_REVIEW_HOME: home,
      ...extra,
    },
    home,
    logFile,
  };
}

/** A parsed diff file stub for tests that do not need a real diff. */
export function diffFile(path, { added = [], context = [] } = {}) {
  return {
    path,
    oldPath: path,
    status: 'modified',
    binary: false,
    additions: added.length,
    deletions: 0,
    addedLines: new Set(added),
    commentableLines: new Set([...added, ...context]),
    hunks: [
      {
        lines: [...added.map((n) => ({ type: 'add', newLine: n })), ...context.map((n) => ({ type: 'ctx', newLine: n }))].sort((a, b) => a.newLine - b.newLine),
      },
    ],
    patch: '',
  };
}
