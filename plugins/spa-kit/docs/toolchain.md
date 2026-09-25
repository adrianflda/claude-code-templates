# Toolchain

Everything here is a command you can run. If a guarantee in this repository has
no command behind it, treat the guarantee as unverified.

## Layout

| Path | What it is |
| ---- | ---------- |
| `apps/fixture` | Next.js App Router app used as the verification target. A harness fixture, not the product. |
| `packages/design-system` | Design tokens (`tokens.css`) and motion primitives (`motion.ts`). |
| `tools/e2e` | Playwright: smoke, visual regression, accessibility, motion contract, web vitals. |
| `tools/seo` | Executable SEO/AEO oracles. Exits non-zero on violation. |
| `tools/breaker` | Blind breaker: contract + live URL in, typed verdict out. |
| `tools/lighthouse` | Lighthouse CI budgets. |
| `scripts/kit-add.mjs` | Pulls animated components from verified shadcn-compatible registries. |

## Commands

```bash
npm run dev            # fixture on http://localhost:4321
npm run build          # production build
npm run typecheck      # tsc across every workspace
npm run lint           # eslint, repo-wide
npm run verify         # typecheck → lint → test → build → seo → e2e
```

### End-to-end

```bash
npm run e2e                     # every project
npm run e2e:visual              # deterministic screenshots
npm run e2e:a11y                # axe-core, WCAG 2.2 AA tags
npm run e2e:motion              # the reduced-motion contract, both directions
npm run e2e:perf                # LCP / CLS / long-task budgets
npm run e2e:update-snapshots    # accept new visual baselines
```

Playwright starts the **production build**, not the dev server: dev overlays and
unminified bundles distort both visual baselines and vitals numbers.

**Visual baselines are per-platform.** Playwright suffixes them with the OS
(`home-visual-darwin.png` locally, `home-visual-linux.png` in CI), so a macOS
baseline does not satisfy Linux CI and the first CI run would fail with "a
snapshot doesn't exist". Generate the Linux set once by running the `verify`
workflow from the Actions tab with `update_snapshots` enabled, then download the
`visual-baselines-linux` artifact and commit it.

First run needs the browser binary:

```bash
npm run e2e:install
```

### SEO / AEO

```bash
npm run seo                                  # all suites against localhost:4321
npm run seo:agentic                          # only the no-JavaScript crawler probe
npm run seo -- --base=https://example.com --routes=/,/pricing
npm run seo -- --json                        # machine-readable output
```

### Blind breaker

```bash
npm run breaker -- --contract=tools/breaker/contract.example.json
npm run breaker -- --contract=… --base=https://staging.example.com --json
```

Exit codes: `0` `BREAKER_PASS`, `1` `BREAKER_FAIL`, `2` `BREAKER_INCONCLUSIVE`.
Inconclusive is never a pass — see `tools/breaker/README.md`.

### Lighthouse

```bash
npm run lh             # 3 runs, desktop preset, budgets in tools/lighthouse/lighthouserc.json
```

Three runs, and assertions are checked against the **median**, not each run.
This matters: the first run on a freshly started server is cold and measures
noticeably worse (observed here: performance 81 and TBT 440ms on run 1, then 100
and 0ms on runs 2 and 3). Reading a single `.lighthouseci/lhr-*.json` will
therefore contradict the pass/fail result. Read `assertion-results.json`.

### Running without the pinned browsers

```bash
KIT_BROWSER_CHANNEL=chrome npm run e2e -- --project=smoke
```

Runs the Chromium projects against an installed Chrome when Playwright's managed
download is unavailable. It does not apply to the `mobile` project, which is
WebKit. **Never generate visual baselines this way** — baselines are only
comparable against the pinned browser.

## Pinned versions and why

| Choice | Version | Reason |
| ------ | ------- | ------ |
| Node | 24 (`.nvmrc`) | Matches the installed runtime; native `fetch` is used by the probes. |
| Next.js | 16.x | App Router with SSR/SSG. The render strategy is the SEO ceiling — see `seo-aeo.md`. |
| React | 19.x | Peer of Next 16. |
| TypeScript | ~5.9.3 | **Not 7.x.** `typescript-eslint@8` declares `typescript <6.1.0`, so TypeScript 7 would break linting. Revisit when typescript-eslint supports it. |
| Tailwind CSS | 4.x | CSS-first config; tokens are consumed via `@theme inline`. |
| motion | 13.x | Framer Motion's successor. Used through the design-system wrappers, not directly. |
| `@paper-design/shaders-react` | 0.0.81, Apache-2.0 | WebGL backdrops. Pre-1.0: the API can move, so it is isolated in one component. |
| Playwright | 1.63 | Runner plus `@axe-core/playwright` for accessibility. |

## What is deliberately absent

- **No component library is installed.** Animated components are pulled per use
  through `kit:add`, because these registries distribute source rather than
  packages. See `ui-registries.md`.
- **No GSAP, no Lenis, no three.js.** All three are reasonable additions, none
  is needed until a specific interaction calls for it. Adding them by default
  would spend the performance budget before there is anything to show.
- **No unit tests for the fixture.** The fixture exists to be probed; its
  behaviour is asserted end to end.
