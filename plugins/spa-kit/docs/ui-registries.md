# Animated UI registries — research, September 2026

## How this ecosystem works now

The libraries worth using in 2026 are **shadcn-compatible source registries**,
not npm packages. The CLI copies component source into the repository, so:

- there is no version to pin and no dependency conflict to resolve;
- the component becomes ours to modify — which is the point, for presentation
  code we will restyle anyway;
- updates are manual. That is the cost.

All of them assume Tailwind CSS and, for animation, `motion`.

## The registries, and when each one is the right answer

| Registry | Character | Use it when |
| -------- | --------- | ----------- |
| **shadcn/ui** | Unstyled behaviour, no motion. | Always, as the base layer. Everything else assumes it. |
| **Motion Primitives** | Composable blocks with restrained, product-grade motion — the Linear/Vercel register. | The default for application UI. Polish without theatrics. |
| **Magic UI** | Polished micro-interactions and marketing motion (animated beams, retro grids, neon gradients). ~21k GitHub stars, the most-used animation layer in the shadcn ecosystem. | Landing and marketing surfaces. |
| **Aceternity UI** | Dramatic set pieces: spotlights, background beams, 3D cards, particle fields. | One hero moment per page, at most. Audit reduced-motion yourself — it is not handled by default. |
| **React Bits** | Broadest coverage, strongest customisation ergonomics, low bundle overhead. **The only one of these that ships `prefers-reduced-motion` handling by default.** | Interactive components where accessibility matters and you do not want to retrofit it. |

Others seen in current round-ups, not adopted here: SmoothUI, Animate UI,
Kokonut UI, Spectrum UI, Shadcn Space, Animata, Skiper UI. Several are good; none
covered a gap the five above leave open, and each additional registry is another
source of inconsistent motion language.

## Verified URL formats

Each of these returned HTTP 200 on 2026-09-24 and is encoded in
`scripts/kit-add.mjs`, which re-checks before delegating to the shadcn CLI:

```
shadcn            https://ui.shadcn.com/r/styles/new-york/<component>.json
magic             https://magicui.design/r/<component>.json
aceternity        https://ui.aceternity.com/registry/<component>.json
motionprimitives  https://motion-primitives.com/c/<component>.json
reactbits         https://reactbits.dev/r/<Component>-TS-CSS.json
```

Note the React Bits shape: the variant (language and styling) is part of the
component name.

## Usage

```bash
npm run kit:add -- --list
npm run kit:add -- shadcn:button motionprimitives:text-effect
npm run kit:add -- reactbits:SplitText-TS-CSS
```

## What actually happens when you pull one in

Verified on 2026-09-25 by installing `shadcn:button` and
`motionprimitives:text-effect` into the fixture. Both landed in
`components/ui/`, and **both failed `npm run typecheck` as delivered**:

- `button.tsx` imports `class-variance-authority`, which the CLI did **not**
  install — it added `@radix-ui/react-slot` and nothing else. It also had two
  type errors of its own (`variant` and `size` missing from `ButtonProps`).
- `text-effect.tsx` hit two errors from this repo's `exactOptionalPropertyTypes:
  true`, where an optional prop is passed as possibly-`undefined`.

The CLI also appends `@custom-variant dark (&:is(.dark *));` to `globals.css`,
which is shadcn's class-based dark mode. This kit is dark by default through
tokens, so that line is redundant — delete it unless you are adding a light
theme.

None of this is a defect in those registries; it is the cost of the copy-in
model against a strict TypeScript config. Budget a few minutes per component.

## The house rule for anything pulled in

A copied component enters the repo as a draft, not as a finished part. Before it
ships:

1. Replace hard-coded colours with tokens from `@kit/design-system`.
2. Replace hard-coded durations and easings with `transition()` / `duration`
   tokens, so the reduced-motion and visual-freeze contracts keep holding. The
   ESLint rule flags literals, but it cannot see everything.
3. Run `npm run e2e:motion` and `npm run e2e:a11y`. A dramatic component that
   ignores `prefers-reduced-motion` fails the motion contract — by design.
4. Re-check the vitals budget if it renders on first paint. `npm run e2e:perf`.

## Sources

- [Best Animated React Component Libraries (2026) — Spectrum UI](https://ui.spectrumhq.in/best-animated-react-component-libraries)
- [react-bits vs Aceternity UI vs Magic UI 2026 — PkgPulse](https://www.pkgpulse.com/guides/react-bits-vs-aceternity-magic-ui-2026)
- [Best Motion Primitives Alternatives — 21st.dev](https://21st.dev/blog/motion-primitives-alternatives)
- [Aceternity UI vs Magic UI vs shadcn/ui 2026 — PkgPulse](https://www.pkgpulse.com/guides/aceternity-ui-vs-magic-ui-vs-shadcn-animated-react-2026)
- [20+ Shadcn React Component Libraries — shadcn studio](https://shadcnstudio.com/blog/shadcn-react-component-libraries/)
