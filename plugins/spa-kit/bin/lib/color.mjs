/**
 * Colour derivation: one brand hex in, a full token ramp out.
 *
 * Everything works in OKLCH because it is perceptually uniform: holding L fixed
 * and rotating H keeps apparent brightness, which is what lets one formula serve
 * any brand colour without a designer re-balancing it per client.
 *
 * No dependencies — the conversions are short and pinning a colour library for
 * this would be more code to trust, not less.
 */

// ---------------------------------------------------------------- sRGB ↔ OKLab

const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(c) {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
}

export function hexToRgb(hex) {
  const clean = hex.trim().replace(/^#/, "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) throw new Error(`"${hex}" is not a hex colour`);
  return {
    r: parseInt(full.slice(0, 2), 16) / 255,
    g: parseInt(full.slice(2, 4), 16) / 255,
    b: parseInt(full.slice(4, 6), 16) / 255,
  };
}

/** sRGB (0..1) → OKLCH with L in 0..1, C in 0..~0.4, H in degrees. */
export function rgbToOklch({ r, g, b }) {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);

  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);

  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;

  const C = Math.sqrt(a * a + bb * bb);
  let H = (Math.atan2(bb, a) * 180) / Math.PI;
  if (H < 0) H += 360;
  return { L, C, H };
}

export function oklchToRgb({ L, C, H }) {
  const hRad = (H * Math.PI) / 180;
  const a = C * Math.cos(hRad);
  const b = C * Math.sin(hRad);

  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;

  return {
    r: clamp(linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)),
    g: clamp(linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)),
    b: clamp(linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)),
  };
}

// ------------------------------------------------------------------ contrast

/** WCAG 2.1 relative luminance from sRGB 0..1. */
function luminance({ r, g, b }) {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

/** WCAG 2.1 contrast ratio between two OKLCH colours, 1..21. */
export function contrast(a, b) {
  const la = luminance(oklchToRgb(a));
  const lb = luminance(oklchToRgb(b));
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Raises or lowers L until the colour clears `target` contrast against `against`.
 * Returns the adjusted colour, or the best it reached if the target is
 * unreachable — the caller reports that rather than pretending it passed.
 */
export function ensureContrast(colour, against, target, direction = "lighter") {
  let candidate = { ...colour };
  const step = direction === "lighter" ? 0.01 : -0.01;
  for (let i = 0; i < 100; i += 1) {
    if (contrast(candidate, against) >= target) return candidate;
    const nextL = clamp(candidate.L + step, 0.02, 0.99);
    if (nextL === candidate.L) break;
    candidate = { ...candidate, L: nextL };
  }
  return candidate;
}

// ------------------------------------------------------------------- output

export function formatOklch({ L, C, H }, precision = 3) {
  const l = `${(L * 100).toFixed(1)}%`;
  const c = C.toFixed(precision);
  const h = H.toFixed(1);
  return `oklch(${l} ${c} ${h})`;
}

export function toHex({ L, C, H }) {
  const { r, g, b } = oklchToRgb({ L, C, H });
  const channel = (v) => Math.round(v * 255).toString(16).padStart(2, "0");
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}
