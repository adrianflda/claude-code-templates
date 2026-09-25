# Visual and motion system

The brief was "visually bold, serious, professional, science-fiction". Those
words pull in opposite directions unless you decide where the drama lives. The
decision here: **the drama is in light, depth and timing — never in colour count
or in decoration.**

## Colour

Defined in `packages/design-system/src/tokens.css`, in OKLCH, so lightness steps
are perceptually even and rotating a hue never changes apparent brightness.

- **Surfaces** are a cold near-black ramp (`--kit-void` → `--kit-rim`), tinted
  blue at very low chroma. Never pure `#000`: a slight tint reads as a material
  under light, while pure black reads as a hole.
- **Text** steps down through three levels and never reaches pure white. Pure
  white on near-black is the single fastest way to make a dark interface look
  amateur — it vibrates.
- **Saturation is a signal, not a background.** Only six tokens carry real
  chroma, and each one means something: `--kit-signal` (primary action),
  `--kit-flux` (secondary), `--kit-warn`, `--kit-critical`, `--kit-nominal`.
  If everything glows, nothing reads as important.

## Depth

Depth comes from **emitted light**, not drop shadows: a 1px signal-coloured ring
plus a soft outer bloom (`--kit-glow-signal`), and an inner rim highlight
(`--kit-rim-light`). This is what reads as "instrument panel" rather than
"card UI". A hairline grid (`.kit-grid-field`), masked with a radial gradient so
it fades out rather than tiling to the edge, does the rest.

## Motion

Four easing curves, and each has one job:

| Token | Curve | Use |
| ----- | ----- | --- |
| `--kit-ease-glide` | `cubic-bezier(0.32, 0.72, 0, 1)` | Default UI transitions. Leaves fast, lands soft. |
| `--kit-ease-expo` | `cubic-bezier(0.16, 1, 0.3, 1)` | Entrances and hero reveals. Long deceleration. |
| `--kit-ease-snap` | `cubic-bezier(0.2, 0, 0, 1)` | State changes that should feel mechanical. |
| `--kit-ease-spring` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | Direct manipulation only. Overshoot on an entrance looks cheap. |

Five durations, from `--kit-dur-instant` (80ms) to `--kit-dur-cinematic` (900ms).
Anything above `--kit-dur-slow` is reserved for a once-per-session moment.

Three rules the tooling enforces:

1. **Every duration comes from a token.** A literal duration in a component is
   an ESLint warning. This is what makes rules 2 and 3 mechanical rather than
   aspirational.
2. **Reduced motion collapses every duration to 0ms.** Under
   `prefers-reduced-motion: reduce`, the tokens are redefined to zero, and
   `tools/e2e/tests/motion.spec.ts` asserts it in both directions: nothing
   animates when motion is reduced, and something *does* animate when it is not
   — so an over-eager "disable everything" fix cannot quietly kill the design.
3. **Animation may never be the mechanism that reveals content.** `Reveal`
   animates `opacity` and `transform` on an element that is already in the
   server HTML. Mounting content on scroll would hide it from crawlers that do
   not run JavaScript, and from anyone whose animation never fires.

## The WebGL layer

`@paper-design/shaders-react` (Apache-2.0, zero-dependency canvas shaders)
provides mesh gradients, grain, god rays, liquid metal and similar effects. The
kit uses one, in `components/shader-field.tsx`, under three constraints:

- **Decorative.** `aria-hidden`, no text, `pointer-events: none`. Removing it
  changes nothing observable to a crawler or a screen reader.
- **Deferred.** It mounts after the first animation frame. A WebGL context on
  the critical path competes with the first paint and shows up directly in LCP.
- **Still, not gone, under reduced motion.** `speed={0}` holds one frame: the
  composition survives, the movement stops.

It is pinned at `0.0.81` — pre-1.0, so the API can move. Keeping it inside one
component means an upgrade touches one file.

`data-visual-volatile` marks it for masking in visual regression, because GPU
output is not reproducible pixel for pixel across machines.

### Measured cost, and why the perf budget is split

Same page, same pinned headless Chromium, measured 2026-09-25:

| Condition | Longest task |
| --------- | ------------ |
| WebGL available (headless, software rasteriser) | 379ms (3/3 runs) |
| WebGL disabled | 0ms (3/3 runs) |
| System Chrome with a real GPU | 0ms (3/3 runs) |

Headless CI has no GPU, so shader compilation goes through software rendering
and costs ~380ms that a viewer with a GPU never pays. A single long-task budget
would therefore measure the runner rather than the product.

`tools/e2e/tests/vitals.spec.ts` splits it: the strict budget runs with WebGL
neutralised (deterministic across environments, and the thing that actually
guards hydration cost), and a separate ceiling keeps WebGL on to catch a
pathological shader. LCP and CLS are asserted in both, because a deferred
backdrop must never become the largest paint or shift the layout.

One earlier finding, kept because it is the same class of trap: mounting the
shader on `requestAnimationFrame` produced a 225ms long task even with a GPU,
since context creation landed while the main thread was still hydrating. Moving
it to `requestIdleCallback` took it to 0ms.

## Visual regression determinism

A baseline only holds when four things hold. All four are configured in
`tools/e2e/playwright.config.ts`:

1. Motion frozen (`animations: "disabled"` plus `data-motion="frozen"`).
2. Fonts loaded (`document.fonts.ready`) before capture.
3. Volatile content masked.
4. Viewport, device scale factor, colour scheme, timezone and locale pinned.

Generate baselines in CI or in the Playwright Docker image. Baselines generated
on a laptop and compared in CI will produce false diffs from font rasterisation
alone.

## Sources

- [Playwright Visual Regression Testing: The Complete 2026 Guide — QASkills](https://qaskills.sh/blog/playwright-visual-regression-testing-guide)
- [Visual Testing Animation Freeze Strategies That Eliminate False Diffs — QASkills](https://qaskills.sh/blog/visual-testing-animation-freeze-strategies)
- [Paper Shaders](https://shaders.paper.design/) · [paper-design/shaders on GitHub](https://github.com/paper-design/shaders)
- [Motion (prev. Framer Motion)](https://motion.dev/)
