import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffStats, hunkContaining, parseDiff, rangeInSingleHunk, unquotePath } from '../lib/diff.mjs';
import { makeRepo, remove } from './helpers.mjs';

const lines = (n, prefix = 'line') => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n') + '\n';

function diffOf(repo, ...args) {
  return repo.git('-c', 'core.quotepath=false', 'diff', '--no-color', '--find-renames', ...args);
}

test('parseDiff — new-side line numbers match the real file', () => {
  const repo = makeRepo({ 'src/a.js': lines(20) });
  try {
    const base = repo.git('rev-parse', 'HEAD');
    const changed = lines(20).split('\n');
    changed[4] = 'line 5 CHANGED';
    changed.splice(10, 0, 'INSERTED');
    repo.commit('edit', { 'src/a.js': changed.join('\n') });

    const [file] = parseDiff(diffOf(repo, base, 'HEAD'));
    assert.equal(file.path, 'src/a.js');
    assert.equal(file.status, 'modified');
    assert.equal(file.additions, 2);
    assert.equal(file.deletions, 1);
    // Every added line, read back from the file at that line number, is the text the diff claims.
    const head = repo.git('show', 'HEAD:src/a.js').split('\n');
    for (const hunk of file.hunks) {
      for (const l of hunk.lines.filter((x) => x.type !== 'del')) assert.equal(head[l.newLine - 1], l.text);
    }
    assert.deepEqual([...file.addedLines].sort((a, b) => a - b), [5, 11]);
  } finally {
    remove(repo.root);
  }
});

test('parseDiff — a deleted line that starts with "-- " is content, not a file header', () => {
  const repo = makeRepo({ 'q.sql': 'SELECT 1;\n-- old note\nSELECT 2;\n' });
  try {
    const base = repo.git('rev-parse', 'HEAD');
    repo.commit('drop note', { 'q.sql': 'SELECT 1;\n++ odd line\nSELECT 2;\n' });
    const files = parseDiff(diffOf(repo, base, 'HEAD'));
    assert.equal(files.length, 1);
    assert.equal(files[0].path, 'q.sql');
    assert.equal(files[0].deletions, 1);
    assert.equal(files[0].additions, 1);
    assert.deepEqual([...files[0].addedLines], [2]);
  } finally {
    remove(repo.root);
  }
});

test('parseDiff — added, deleted, renamed and binary files', () => {
  const repo = makeRepo({ 'keep.txt': lines(12), 'gone.txt': 'bye\n', 'old name.txt': lines(12, 'row') });
  try {
    const base = repo.git('rev-parse', 'HEAD');
    repo.git('mv', 'old name.txt', 'new name.txt');
    repo.commit('mixed', { 'gone.txt': null, 'added.txt': 'hello\n', 'logo.bin': Buffer.from([0, 1, 2, 0, 255]).toString('latin1') });

    const byPath = new Map(parseDiff(diffOf(repo, base, 'HEAD')).map((f) => [f.path, f]));
    assert.equal(byPath.get('added.txt').status, 'added');
    assert.equal(byPath.get('gone.txt').status, 'deleted');
    assert.equal(byPath.get('new name.txt').status, 'renamed');
    assert.equal(byPath.get('new name.txt').oldPath, 'old name.txt');
    assert.equal(byPath.get('logo.bin').binary, true);
    assert.equal(byPath.has('keep.txt'), false);
  } finally {
    remove(repo.root);
  }
});

test('parseDiff — a file without a trailing newline does not shift line numbers', () => {
  const repo = makeRepo({ 'n.txt': 'a\nb\nc' });
  try {
    const base = repo.git('rev-parse', 'HEAD');
    repo.commit('append', { 'n.txt': 'a\nb\nc\nd' });
    const [file] = parseDiff(diffOf(repo, base, 'HEAD'));
    assert.deepEqual([...file.addedLines].sort((a, b) => a - b), [3, 4]);
    assert.equal(file.deletions, 1);
  } finally {
    remove(repo.root);
  }
});

test('parseDiff — empty or missing input yields no files', () => {
  assert.deepEqual(parseDiff(''), []);
  assert.deepEqual(parseDiff(undefined), []);
});

test('rangeInSingleHunk — a range spanning two hunks is rejected', () => {
  const repo = makeRepo({ 'big.txt': lines(60) });
  try {
    const base = repo.git('rev-parse', 'HEAD');
    const changed = lines(60).split('\n');
    changed[2] = 'first edit';
    changed[49] = 'second edit';
    repo.commit('two hunks', { 'big.txt': changed.join('\n') });
    const [file] = parseDiff(diffOf(repo, base, 'HEAD'));
    assert.equal(file.hunks.length, 2);
    assert.equal(rangeInSingleHunk(file, 2, 4), true);
    assert.equal(rangeInSingleHunk(file, 3, 50), false);
    assert.equal(rangeInSingleHunk(file, 25, 25), false);
    assert.equal(hunkContaining(file, 25), null);
    assert.equal(hunkContaining(file, 50), file.hunks[1]);
  } finally {
    remove(repo.root);
  }
});

test('unquotePath — decodes git C-style quoting', () => {
  assert.equal(unquotePath('"caf\\303\\251.txt"'), 'café.txt');
  assert.equal(unquotePath('"a\\tb.txt"'), 'a\tb.txt');
  assert.equal(unquotePath('plain.txt'), 'plain.txt');
});

test('diffStats — totals across files', () => {
  assert.deepEqual(diffStats([{ additions: 2, deletions: 1 }, { additions: 5, deletions: 0 }]), { files: 2, additions: 7, deletions: 1 });
});
