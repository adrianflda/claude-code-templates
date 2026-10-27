// Property tests for the pure parts of the org guide (separate command:
// `node --test scripts/*.prop.mjs`; seeded — a failure prints its seed, replay with QK_PROP_SEED=<seed>).
// Starter set; the hardener extends it.
import { test } from 'node:test';
import assert from 'node:assert';
import { gen, forAll } from './prop-kit.mjs';
import { spliceBlock, summarizeEdges, stampGuide, BEGIN, END } from './org-guide.mjs';
import { isRepoName, isBoundedSingleLineText, TEXT_MAX_LENGTH } from './org-policy.mjs';

const count = (s, m) => s.split(m).length - 1;
// Free text around the managed block: any lines, never the markers themselves.
const outside = gen.string({ chars: 'abc XYZ#-|<>`\n', maxLength: 40 });
const block = gen.map(gen.string({ chars: 'abc #|-\n', maxLength: 30 }), (body) => `${BEGIN}\n${body}\n${END}`);

test('spliceBlock: re-applying the same block is a no-op, and the result has exactly one block', () => {
  forAll(gen.record({ current: outside, b: block }), ({ current, b }) => {
    const once = spliceBlock(current, b);
    return spliceBlock(once, b) === once && count(once, BEGIN) === 1 && count(once, END) === 1 && once.includes(b);
  });
});

test('spliceBlock: replacing the block never touches the text before or after it', () => {
  forAll(gen.record({ before: outside, after: outside, b1: block, b2: block }), ({ before, after, b1, b2 }) => {
    const current = `${before}${b1}${after}`;
    return spliceBlock(current, b2) === `${before}${b2}${after}` && spliceBlock(spliceBlock(current, b1), b2) === spliceBlock(current, b2);
  });
});

test('spliceBlock: appending to a file without a block keeps that file as an exact prefix', () => {
  forAll(gen.record({ current: outside, b: block }), ({ current, b }) => spliceBlock(current, b).startsWith(current));
});

const repo = gen.elements('web', 'api', 'admin', 'aws', 'a-b', 'a', 'b-c');
const edges = gen.array(gen.record({ from: repo, to: repo }), { maxLength: 20 });

test('summarizeEdges: one row per distinct pair, counts sum to the edge count, every count >= 1', () => {
  forAll(edges, (es) => {
    const pairs = summarizeEdges(es);
    const keys = pairs.map((p) => `${p.from}\0${p.to}`);
    return new Set(keys).size === keys.length
      && pairs.reduce((s, p) => s + p.n, 0) === es.length
      && pairs.every((p) => p.n >= 1 && p.n === es.filter((e) => e.from === p.from && e.to === p.to).length);
  });
});

test('stampGuide: always version 1; summary is exactly the computed pairs, or absent when null', () => {
  const proposal = gen.record({ org: gen.string(), version: gen.oneOf(gen.constant(undefined), gen.int(0, 3)), summary: gen.oneOf(gen.constant(undefined), edges) });
  forAll(gen.record({ g: proposal, pairs: gen.oneOf(gen.constant(null), gen.map(edges, summarizeEdges)) }), ({ g, pairs }) => {
    const s = stampGuide(g, pairs);
    assert.strictEqual(s.version, 1);
    if (pairs === null) assert.ok(!Object.hasOwn(s, 'summary'));
    else assert.deepStrictEqual(s.summary, pairs);
    assert.strictEqual(s.org, g.org);
  });
});

test('org-policy: a repo name is never a path, and bounded text is never multi-line or over the limit', () => {
  forAll(gen.string({ chars: 'ab./-_\n ', maxLength: 12 }), (n) => !isRepoName(n) || (!n.includes('/') && !n.includes('\n') && n !== '.' && n !== '..'));
  forAll(gen.string({ chars: 'ab \n\t', maxLength: TEXT_MAX_LENGTH + 5 }), (t) =>
    !isBoundedSingleLineText(t) || (!t.includes('\n') && !t.includes('\t') && t.length <= TEXT_MAX_LENGTH && t.trim() !== ''));
});
