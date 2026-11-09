// Property tests for the shared contract-section parser (specs/qk-breaker-robust-input/spec.md,
// EARS-H1/H2/H4/H5). Separate command: `node --test scripts/*.prop.mjs` (dependency-free kit in
// scripts/prop-kit.mjs). EARS-H1/H2/H4/H5 are themselves universally-quantified ("regardless of any
// numeric or text prefix", "repeating [the parenthetical strip] until none remain", "scan left to
// right... odd number of unescaped backticks") — a handful of fixed examples in
// contract-sections.test.mjs samples only a few points of that space; a seeded generator samples it
// cheaply instead (pure functions, no I/O, no new dependency).
import { test } from 'node:test';
import { gen, forAll } from './prop-kit.mjs';
import { splitRow, normalizeId, scanSections } from './contract-sections.mjs';

const plainCell = gen.string({ chars: 'abcXYZ019 _.=/', maxLength: 10 });

// EARS-H5: a cell containing none of `|`, `` ` ``, `\` is never split or merged — splitRow round-trips
// any number of such cells exactly, for any content.
test('EARS-H5: plain cells (no |/`/\\) round-trip exactly through splitRow, for any count/content', () => {
  forAll(gen.array(plainCell, { maxLength: 6 }), (cells) => {
    const row = cells.join('|');
    const got = splitRow(row);
    return JSON.stringify(got) === JSON.stringify(cells.length ? cells : ['']);
  });
});

// EARS-H4: a bare id (letters/digits/hyphen only, so it can't itself look like `**`/`(...)`), wrapped
// in a matching **bold** pair around the WHOLE cell (id + every trailing annotation, per the
// `**EO-6 (re-run)**` shape) and followed by any number of " (...)" annotations, always normalizes
// back to exactly the bare id, regardless of how many annotations or whether it is bold.
test('EARS-H4: a bold-or-not id with N trailing "(...)" annotations always normalizes to the bare id', () => {
  const idGen = gen.map(
    gen.array(gen.elements(..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-"), { maxLength: 8 }),
    (xs) => `${xs.length ? xs.join('') : 'A'}-0`,
  );
  const parenGen = gen.string({ chars: 'abc 0123', maxLength: 6 });
  forAll(
    gen.record({ id: idGen, bold: gen.bool(), parens: gen.array(parenGen, { maxLength: 3 }) }),
    ({ id, bold, parens }) => {
      const annotated = id + parens.map((p) => ` (${p})`).join('');
      const cell = bold ? `**${annotated}**` : annotated;
      return normalizeId(cell) === id;
    },
  );
});

// EARS-H1/H2: a "## .../### ..." heading whose text contains the required phrase opens its section
// and its body is extracted non-empty, regardless of any numeric prefix before the phrase or any text
// after it on the same line (the exact tolerance EARS-H1/H2 specify).
test('EARS-H1/H2: any numeric prefix or trailing suffix on the heading line still opens its section', () => {
  const numberingGen = gen.map(
    gen.array(gen.int(1, 99), { maxLength: 4 }),
    (ns) => (ns.length ? `${ns.join('.')}. ` : ''),
  );
  const suffixGen = gen.elements('', ' (UI-only)', ' — details', ': notes', ' (re-run)');
  const levelGen = gen.elements('##', '###');
  const phraseGen = gen.elements('QA procedure', 'qa PROCEDURE', 'External Observable Invariants', 'Invariants', 'INVARIANTS');
  forAll(
    gen.record({ level: levelGen, numbering: numberingGen, phrase: phraseGen, suffix: suffixGen }),
    ({ level, numbering, phrase, suffix }) => {
      const isQa = /qa procedure/i.test(phrase);
      const heading = `${level} ${numbering}${phrase}${suffix}`;
      const body = isQa ? 'qa body text' : '| INV-A | d | 1 |';
      const s = scanSections(`${heading}\n${body}`);
      return isQa ? s.qaProcedure.includes('qa body text') : s.invariants.some((i) => i.id === 'INV-A');
    },
  );
});
