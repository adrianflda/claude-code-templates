/**
 * Derives a full token ramp from a single brand colour.
 *
 * Rules encoded here, so one formula serves any brand:
 *  - Surfaces carry a trace of the brand hue at very low chroma. A neutral grey
 *    reads as unfinished; a fully saturated background reads as a toy.
 *  - Only the accents carry real chroma. Saturation is a signal.
 *  - Status colours (warn/critical/nominal) keep their semantic hues. A green
 *    derived from a red brand would be unreadable as "healthy".
 *  - Text and accent lightness is adjusted until it clears a contrast target
 *    against the surface it sits on, and the achieved ratios are reported.
 */
import { hexToRgb, rgbToOklch, formatOklch, contrast, ensureContrast } from "./color.mjs";

const SEMANTIC_HUES = { warn: 78, critical: 22, nominal: 158 };

/** Contrast targets: AAA for body text, AA for secondary and for accents. */
const TARGET = { primaryText: 7, secondaryText: 4.5, mutedText: 4.5, accent: 4.5 };

export function derivePalette(brandHex, mode = "dark") {
  if (mode !== "dark" && mode !== "light") {
    throw new Error(`unknown mode "${mode}" — use "dark" or "light"`);
  }
  const brand = rgbToOklch(hexToRgb(brandHex));
  const H = brand.H;
  const dark = mode === "dark";

  // Surface ramp: five steps, brand-tinted, chroma kept near-neutral.
  const surfaceL = dark ? [0.12, 0.16, 0.21, 0.27, 0.38] : [0.985, 0.96, 0.93, 0.89, 0.82];
  const surfaceC = dark ? [0.018, 0.021, 0.023, 0.024, 0.028] : [0.004, 0.008, 0.012, 0.016, 0.022];
  const [void_, abyss, hull, plate, rim] = surfaceL.map((L, i) => ({ L, C: surfaceC[i], H }));

  // Text ramp, then pushed until it clears its contrast target on the surface
  // it actually sits on.
  const textDirection = dark ? "lighter" : "darker";
  const primary = ensureContrast(
    { L: dark ? 0.96 : 0.22, C: 0.006, H },
    void_,
    TARGET.primaryText,
    textDirection,
  );
  const secondary = ensureContrast(
    { L: dark ? 0.78 : 0.38, C: 0.012, H },
    abyss,
    TARGET.secondaryText,
    textDirection,
  );
  const muted = ensureContrast(
    { L: dark ? 0.62 : 0.5, C: 0.014, H },
    abyss,
    TARGET.mutedText,
    textDirection,
  );

  // The accent keeps the brand's hue and as much of its chroma as the target
  // lightness allows; pure brand colours are often too dark to read on dark.
  const signalBase = { L: dark ? Math.max(brand.L, 0.72) : Math.min(brand.L, 0.55), C: brand.C, H };
  const signal = ensureContrast(signalBase, abyss, TARGET.accent, textDirection);
  const signalDim = { ...signal, L: Math.max(0.3, signal.L - (dark ? 0.16 : -0.12)) };

  // Secondary accent: an analogous hue, far enough to read as a second voice.
  const flux = ensureContrast(
    { L: dark ? 0.68 : 0.5, C: Math.min(brand.C, 0.17), H: (H + 55) % 360 },
    abyss,
    TARGET.accent,
    textDirection,
  );

  const status = Object.fromEntries(
    Object.entries(SEMANTIC_HUES).map(([name, hue]) => [
      name,
      ensureContrast(
        { L: dark ? 0.78 : 0.52, C: name === "critical" ? 0.19 : 0.145, H: hue },
        abyss,
        TARGET.accent,
        textDirection,
      ),
    ]),
  );

  const tokens = {
    void: void_,
    abyss,
    hull,
    plate,
    rim,
    "text-primary": primary,
    "text-secondary": secondary,
    "text-muted": muted,
    signal,
    "signal-dim": signalDim,
    flux,
    warn: status.warn,
    critical: status.critical,
    nominal: status.nominal,
  };

  const report = {
    brand: { hex: brandHex, oklch: formatOklch(brand) },
    mode,
    hue: Number(H.toFixed(1)),
    contrast: {
      "text-primary on void": round(contrast(primary, void_)),
      "text-secondary on abyss": round(contrast(secondary, abyss)),
      "text-muted on abyss": round(contrast(muted, abyss)),
      "signal on abyss": round(contrast(signal, abyss)),
      "flux on abyss": round(contrast(flux, abyss)),
    },
  };

  report.meetsTargets =
    report.contrast["text-primary on void"] >= TARGET.primaryText &&
    report.contrast["text-secondary on abyss"] >= TARGET.secondaryText &&
    report.contrast["text-muted on abyss"] >= TARGET.mutedText &&
    report.contrast["signal on abyss"] >= TARGET.accent;

  return { tokens, report };
}

const round = (n) => Number(n.toFixed(2));

/** Renders the derived tokens as the CSS custom-property block. */
export function renderTokenBlock(tokens, mode) {
  const line = (name, comment) =>
    `    --kit-${name}: ${formatOklch(tokens[name])};${comment ? ` /* ${comment} */` : ""}`;

  return [
    `    /* Surfaces — ${mode} mode, tinted with the brand hue at low chroma. */`,
    line("void"),
    line("abyss"),
    line("hull"),
    line("plate"),
    line("rim"),
    "",
    "    /* Text — stepped, contrast-checked against the surface it sits on. */",
    line("text-primary"),
    line("text-secondary"),
    line("text-muted"),
    "",
    "    /* Signal accents — the only high-chroma values. */",
    line("signal", "brand — primary action"),
    line("signal-dim"),
    line("flux", "secondary"),
    line("warn", "caution"),
    line("critical", "failure"),
    line("nominal", "healthy"),
  ].join("\n");
}
