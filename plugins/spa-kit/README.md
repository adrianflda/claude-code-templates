# spa-kit

A factory for client SPAs that classic search crawlers **and** AI answer engines
can both read.

This plugin is the tooling, not the product: it generates a standalone site per
client and verifies it from the outside. `apps/fixture` exists so every tool has
something real to run against.

## Install

```bash
/plugin marketplace add adrianflda/claude-code-templates
/plugin install spa-kit@adrianflda-claude-code-templates
```

Then, once per machine:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/spa-kit.mjs" doctor --fix
```

That installs the kit's dependencies and Playwright's browsers. `doctor` alone
reports what is missing without changing anything.

Optional, for a bare `spa-kit` command: `npm link` inside the plugin directory.

## The one constraint everything else follows from

As of 2026, GPTBot, OAI-SearchBot, ClaudeBot, PerplexityBot and CCBot fetch raw
HTML and **do not execute JavaScript**. A client-rendered SPA reaches them as an
empty shell. So "modern SPA" here means SPA-like navigation over routes that each
answer with complete server-rendered HTML — and there is an executable probe
that fails the build when that stops being true.

Details and sources: [`docs/seo-aeo.md`](docs/seo-aeo.md).

## Guided generation: `/spa-kit`

The fastest path. In Claude Code, type `/spa-kit`: it asks who the client is,
proposes the brand colour, sections and copy, then generates and verifies the
site. Installing the plugin installs the skill.

It is instructed never to invent facts about a real business — prices, response
times, certifications and the like are asked for or left out.

## Generating client sites

This repository is a factory, not a home for one site. Each client gets its own
directory, generated from the template and verified from here:

```bash
node bin/spa-kit.mjs new ~/Projects/clients/acme --name="Acme" --url=https://acme.com
node bin/spa-kit.mjs verify ~/Projects/clients/acme
```

A generated site has **no dependency on this kit** — it builds and deploys on
its own. See [`docs/generating-sites.md`](docs/generating-sites.md).

## Quick start

```bash
npm install
npm run e2e:install   # Playwright's chromium, first time only
npm run dev                                 # http://localhost:4321
```

Verify everything:

```bash
npm run verify        # typecheck → lint → test → build → seo → e2e
```

## What is in here

| Layer | Tool | Command |
| ----- | ---- | ------- |
| Design | Tokens + motion primitives (`packages/design-system`) | — |
| Design | Animated components from 5 verified registries | `npm run kit:add -- --list` |
| Implementation | Next.js 16 App Router, React 19, Tailwind 4 | `npm run dev` |
| E2E | Playwright: smoke, visual, a11y, motion, vitals | `npm run e2e` |
| SEO / AEO | Indexability, structured data, no-JS crawler probe | `npm run seo` |
| Verification | Blind breaker (contract + live URL only) | `npm run breaker -- --contract=…` |
| Budgets | Lighthouse CI | `npm run lh` |

## Documentation

- [`docs/toolchain.md`](docs/toolchain.md) — every command, every pinned version and why
- [`docs/seo-aeo.md`](docs/seo-aeo.md) — what the SEO/AEO oracles assert, and the evidence behind them
- [`docs/visual-and-motion.md`](docs/visual-and-motion.md) — the serious-sci-fi visual language and the motion contract
- [`docs/ui-registries.md`](docs/ui-registries.md) — the animated-component registry landscape, September 2026
- [`tools/breaker/README.md`](tools/breaker/README.md) — how the blind breaker is starved of context on purpose

## Design of the verification layer

Three independent oracles, deliberately not sharing assumptions:

1. **Playwright** drives a real browser against a production build. It knows the
   implementation.
2. **`tools/seo`** requests the same routes with no JavaScript engine at all,
   as each AI crawler. It sees only what a crawler sees.
3. **`tools/breaker`** receives the contract and a URL — never the diff, never
   the reasoning, never another reviewer's output. It derives hostile request
   variants and reports what actually broke.

An unreachable target is `BREAKER_INCONCLUSIVE`, never a pass.

## Known duplication

`packages/design-system/src/` and `templates/spa/design/` hold the same tokens
and motion primitives: the first is what the fixture compiles against, the
second is what gets copied into a generated site. They must be kept in step by
hand until the fixture is itself generated from the template.
