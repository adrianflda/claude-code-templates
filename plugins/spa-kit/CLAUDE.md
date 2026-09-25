# Working in this repository

## What this repo is

Tooling for building a modern SPA that classic crawlers and AI answer engines can
both read. `apps/fixture` is a verification target, not the product. Do not grow
it into an application — when the real SPA starts, it gets its own workspace and
reuses `packages/design-system` and everything under `tools/`.

## Non-negotiables

1. **Server-rendered HTML.** Answer-bearing content must be in the first HTML
   response. AI crawlers do not execute JavaScript (see `docs/seo-aeo.md`).
   Anything that only exists after hydration is invisible to them.
2. **Animation never reveals content.** Animate `opacity` and `transform` on
   nodes that are already in the server HTML. Never gate mounting on scroll,
   visibility or a timer.
3. **Motion values come from tokens.** No literal durations or easings in
   components. `packages/design-system/src/tokens.css` is the only source, which
   is what keeps reduced-motion and screenshot determinism working.
4. **Every guarantee has a command.** If you claim something holds, name the
   command that proves it and quote its output. An unverified claim is a defect.

## Order of work

1. State the externally observable behaviour first — what a user or a crawler
   could see change. Add it to the breaker contract
   (`tools/breaker/contract.example.json` is the template).
2. Implement.
3. Run the oracles in this order, because each one catches what the previous
   cannot:
   ```bash
   npm run typecheck && npm run lint
   npm run build
   npm run seo          # what a crawler with no JS engine sees
   npm run e2e          # what a real browser does
   npm run breaker -- --contract=<contract>   # hostile request variants
   npm run lh           # performance and SEO budgets
   ```
4. Report outcomes with evidence. `BREAKER_INCONCLUSIVE` is not a pass.

## Adding a component from a registry

`npm run kit:add -- <registry>:<component>` (see `docs/ui-registries.md`).
A copied component is a draft: retokenise its colours and durations, then run
`npm run e2e:motion` and `npm run e2e:a11y` before it ships.

## Things that will bite you

- **Visual baselines are environment-specific.** Generate them in CI or in the
  Playwright Docker image. Laptop baselines will false-diff on font rasterisation.
- **TypeScript stays on 5.9.** `typescript-eslint@8` declares `typescript
  <6.1.0`; moving to 7.x breaks linting. Revisit when that peer range opens.
- **`@paper-design/shaders-react` is pre-1.0** (0.0.81). It is confined to
  `components/shader-field.tsx` so an API change touches one file.
- **WebGL is not pixel-reproducible.** Anything GPU-rendered needs
  `data-visual-volatile` so the visual suite masks it.
- **Language.** Everything committed here is in English.
