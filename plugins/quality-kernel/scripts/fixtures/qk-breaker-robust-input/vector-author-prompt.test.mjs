// Executable check for EARS-V8 (breaker/vector-author.md prompt requirements).
// Reads the real prompt file via a relative path (never an absolute path) and asserts the three
// required substrings a blind breaker's author prompt must contain after this change. Pre-fix,
// this RED-fails (OBSERVED: vector-author.md today contains neither "registrable" nor the literal
// phrase "only that vector") — it is wired against the real file, not a fixture copy, so it turns
// green exactly when breaker/vector-author.md is actually edited to satisfy EARS-V8.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const promptPath = join(here, '../../../breaker/vector-author.md');
const prompt = readFileSync(promptPath, 'utf8');
const paragraphs = prompt.split(/\n\s*\n/);

test('EARS-V8(a): a paragraph mentions both "Host" and "registrable" (case-insensitive)', () => {
  const hit = paragraphs.some((p) => /host/i.test(p) && /registrable/i.test(p));
  assert.ok(hit, 'no paragraph of vector-author.md mentions both "Host" and "registrable"');
});

test('EARS-V8(b): the literal substring "only that vector" is present', () => {
  assert.ok(prompt.includes('only that vector'), 'vector-author.md is missing the literal phrase "only that vector"');
});

test('EARS-V8(c): HTTP methods and UI commands each appear at least once in production casing', () => {
  const tokens = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'goto', 'click', 'text', 'is', 'attrs'];
  for (const token of tokens) {
    assert.ok(prompt.includes(token), `vector-author.md never contains "${token}" in production casing`);
  }
});
