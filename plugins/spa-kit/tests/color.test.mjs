import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hexToRgb,
  rgbToOklch,
  oklchToRgb,
  contrast,
  ensureContrast,
  toHex,
  formatOklch,
} from "../bin/lib/color.mjs";

const oklchOf = (hex) => rgbToOklch(hexToRgb(hex));

test("hex parsing accepts 3- and 6-digit forms and rejects junk", () => {
  assert.deepEqual(hexToRgb("#fff"), hexToRgb("#ffffff"));
  assert.deepEqual(hexToRgb("000000"), { r: 0, g: 0, b: 0 });
  assert.throws(() => hexToRgb("#12345"), /not a hex colour/);
  assert.throws(() => hexToRgb("rebeccapurple"), /not a hex colour/);
});

test("hex → OKLCH → hex is lossless for real brand colours", () => {
  for (const hex of ["#0a5fff", "#c2410c", "#0f766e", "#8c2f39", "#7c3aed", "#2ee6d6"]) {
    assert.equal(toHex(oklchOf(hex)), hex, `round-trip failed for ${hex}`);
  }
});

test("contrast matches the known WCAG extremes", () => {
  const white = oklchOf("#ffffff");
  const black = oklchOf("#000000");
  // The definition's maximum is 21:1.
  assert.ok(Math.abs(contrast(white, black) - 21) < 0.1, `got ${contrast(white, black)}`);
  assert.equal(Math.round(contrast(white, white)), 1);
});

test("contrast is symmetric", () => {
  const a = oklchOf("#0a5fff");
  const b = oklchOf("#101418");
  assert.ok(Math.abs(contrast(a, b) - contrast(b, a)) < 1e-9);
});

test("ensureContrast lightens until the target is cleared", () => {
  const surface = { L: 0.16, C: 0.02, H: 260 };
  const dim = { L: 0.3, C: 0.1, H: 260 };
  assert.ok(contrast(dim, surface) < 4.5, "precondition: starts below target");

  const fixed = ensureContrast(dim, surface, 4.5, "lighter");
  assert.ok(contrast(fixed, surface) >= 4.5, `ended at ${contrast(fixed, surface)}`);
  assert.ok(fixed.L > dim.L, "lightness must have increased");
  assert.equal(fixed.H, dim.H, "hue must not drift");
});

test("ensureContrast darkens for light surfaces", () => {
  const surface = { L: 0.98, C: 0.004, H: 186 };
  const pale = { L: 0.9, C: 0.05, H: 186 };
  const fixed = ensureContrast(pale, surface, 4.5, "darker");
  assert.ok(contrast(fixed, surface) >= 4.5);
  assert.ok(fixed.L < pale.L);
});

test("ensureContrast returns its best effort rather than looping forever", () => {
  // 21:1 against mid-grey is unreachable; it must terminate and not throw.
  const surface = { L: 0.5, C: 0, H: 0 };
  const result = ensureContrast({ L: 0.5, C: 0, H: 0 }, surface, 21, "lighter");
  assert.ok(Number.isFinite(result.L));
  assert.ok(contrast(result, surface) < 21);
});

test("oklchToRgb clamps into gamut instead of emitting out-of-range channels", () => {
  const { r, g, b } = oklchToRgb({ L: 0.9, C: 0.4, H: 150 });
  for (const channel of [r, g, b]) {
    assert.ok(channel >= 0 && channel <= 1, `channel out of gamut: ${channel}`);
  }
});

test("formatOklch emits a CSS-parseable oklch() string", () => {
  assert.match(formatOklch({ L: 0.78, C: 0.152, H: 205 }), /^oklch\(78\.0% 0\.152 205\.0\)$/);
});
