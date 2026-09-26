import { test } from "node:test";
import assert from "node:assert/strict";
import { derivePalette, renderTokenBlock } from "../bin/lib/palette.mjs";
import { contrast } from "../bin/lib/color.mjs";

const BRANDS = ["#0A5FFF", "#C2410C", "#0F766E", "#8C2F39", "#7C3AED", "#2ee6d6", "#111111"];

test("every brand colour in both modes meets its contrast targets", () => {
  for (const hex of BRANDS) {
    for (const mode of ["dark", "light"]) {
      const { report } = derivePalette(hex, mode);
      assert.equal(report.meetsTargets, true, `${hex} ${mode}: ${JSON.stringify(report.contrast)}`);
      assert.ok(report.contrast["text-primary on void"] >= 7, `${hex} ${mode} body text below AAA`);
      assert.ok(report.contrast["signal on abyss"] >= 4.5, `${hex} ${mode} accent below AA`);
    }
  }
});

test("the reported ratios are the ones the tokens actually have", () => {
  // Guards against a report that is computed from something other than the
  // emitted tokens — the failure mode that would make the whole check theatre.
  const { tokens, report } = derivePalette("#0A5FFF", "dark");
  const measured = contrast(tokens["text-primary"], tokens.void);
  assert.ok(Math.abs(measured - report.contrast["text-primary on void"]) < 0.01);
});

test("surfaces carry the brand hue at low chroma", () => {
  const { tokens, report } = derivePalette("#8C2F39", "dark");
  for (const name of ["void", "abyss", "hull", "plate", "rim"]) {
    assert.equal(Math.round(tokens[name].H), Math.round(report.hue), `${name} lost the brand hue`);
    assert.ok(tokens[name].C <= 0.03, `${name} is too saturated: ${tokens[name].C}`);
  }
});

test("dark mode surfaces are dark and light mode surfaces are light", () => {
  assert.ok(derivePalette("#0A5FFF", "dark").tokens.void.L < 0.2);
  assert.ok(derivePalette("#0A5FFF", "light").tokens.void.L > 0.9);
});

test("status hues stay semantic regardless of the brand", () => {
  // A green derived from a red brand would not read as "healthy".
  const { tokens } = derivePalette("#C2410C", "dark");
  assert.equal(Math.round(tokens.nominal.H), 158);
  assert.equal(Math.round(tokens.critical.H), 22);
  assert.equal(Math.round(tokens.warn.H), 78);
});

test("the secondary accent is a distinct hue from the primary", () => {
  const { tokens } = derivePalette("#0A5FFF", "dark");
  const separation = Math.abs(tokens.flux.H - tokens.signal.H);
  assert.ok(separation > 30, `flux and signal are only ${separation}° apart`);
});

test("an unknown mode is rejected rather than silently defaulted", () => {
  assert.throws(() => derivePalette("#0A5FFF", "sepia"), /unknown mode/);
});

test("an invalid brand colour is rejected", () => {
  assert.throws(() => derivePalette("not-a-colour", "dark"), /not a hex colour/);
});

test("renderTokenBlock emits every token as a CSS custom property", () => {
  const { tokens } = derivePalette("#0A5FFF", "dark");
  const css = renderTokenBlock(tokens, "dark");
  for (const name of Object.keys(tokens)) {
    assert.match(css, new RegExp(`--kit-${name}: oklch\\(`), `missing --kit-${name}`);
  }
  assert.doesNotMatch(css, /undefined|NaN/);
});
