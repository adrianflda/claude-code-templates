# Generating client sites

The kit is a factory. What ships to a client is the site in its own directory;
the toolchain stays here and never becomes a dependency of the generated
project. A generated site's `package.json` holds `next`, `react`, `motion` and
little else, so it deploys anywhere without a trace of this repository.

## Generate

```bash
node bin/spa-kit.mjs new ~/Projects/clients/acme \
  --name="Acme Robotics" \
  --url=https://acmerobotics.com \
  --headline="Industrial automation that pays for itself in eighteen months."
```

Options: `--slug`, `--port`, `--description`, `--locale`, `--install=false`,
`--force`, `--json`.

The port is assigned automatically by scanning sibling projects for their
`spa-kit.json`, so several client sites can run at once without colliding.

## The guided path

`/spa-kit` in Claude Code runs the whole thing as an interview: it asks what only
you can know, drafts the brief itself, generates the site and verifies it. The
skill is `skills/spa-kit/SKILL.md`; `npm run skill:install` copies it to
`~/.claude/skills/`.

It is instructed never to invent facts about a real business — prices, response
times, certifications and similar are asked for or left out.

## The brief

The brief is the single declarative input that decides what a site looks like
and says. The same brief always produces the same site, which is what makes
generation repeatable for an agent instead of a creative act each time.

```bash
node bin/spa-kit.mjs brief > brief.json    # template to fill in
node bin/spa-kit.mjs new ~/Projects/clients/acme --brief=brief.json
```

```jsonc
{
  "business": { "name", "tagline", "description", "sector", "locale", "url" },
  "brand":    { "color": "#0A5FFF", "mode": "dark" | "light" },
  "nav":      [{ "label": "Capabilities", "href": "#capabilities" }],
  "hero":     { "headline", "subhead", "primary": {…}, "secondary": {…} },
  "sections": [{ "id", "label", "title", "body" }],
  "footer":   { "note", "links": [] },
  "routes":   ["/"]
}
```

Required: `business.name`, `business.description`, `business.url`,
`brand.color`, `hero.headline`. Everything else has a default.

Editing a brief afterwards and re-applying it is the normal way to iterate:

```bash
node bin/spa-kit.mjs apply ~/Projects/clients/acme
```

`apply` rewrites `design/tokens.css`, `content.ts` and `lib/site.ts`. It does not
touch anything you hand-wrote elsewhere.

### The palette is derived, not chosen

One hex in, the whole ramp out. Everything is computed in OKLCH, which is
perceptually uniform, so one formula serves any brand colour:

- **Surfaces** carry a trace of the brand hue at very low chroma. A neutral grey
  reads as unfinished; a saturated background reads as a toy.
- **Only accents carry chroma.** Saturation is a signal.
- **Status colours keep their semantic hues.** A "healthy" green derived from a
  red brand would be unreadable as healthy.
- **Text and accent lightness is pushed until it clears a contrast target** —
  AAA (7:1) for body text, AA (4.5:1) for secondary text and accents — and the
  achieved ratios are reported. If a target cannot be reached, the CLI says so
  and exits non-zero rather than shipping unreadable text.

```
$ node bin/spa-kit.mjs apply ~/Projects/clients/acme
applied brief · brand #0A5FFF (dark) · contrast targets met
    text-primary on void       18.08:1
    text-secondary on abyss     9.7:1
    signal on abyss             6.68:1
```

Interface strings that are not content — the skip link, the navigation's
accessible names — follow `business.locale` automatically (en, es, fr, de, pt),
and `<html lang>` is derived from it. The SEO probe asserts that the declared
language matches.

### What the brief does not decide

Layout structure and any page beyond the home page. The brief fills a hero, a
navigation, a section grid and a footer. Anything else is ordinary work in
`app/`, done by you or by an agent, under the rules in the project's `CLAUDE.md`.

## Verify

```bash
node bin/spa-kit.mjs verify ~/Projects/clients/acme
node bin/spa-kit.mjs verify ~/Projects/clients/acme --json
```

It installs if needed, typechecks, builds, starts the built app, then runs the
three oracles against it and stops the server. Flags: `--base`, `--skip-build`,
`--skip-e2e`.

```
verify Acme Robotics · http://localhost:4400
  [  ok  ] typecheck
  [  ok  ] build
  [  ok  ] seo · 29 passed · 0 failed · 0 advisory
  [  ok  ] breaker · BREAKER_PASS — 16/16 vectors failed to falsify the contract
  [  ok  ] e2e · 12 passed · visual baselines created

PASSED
```

## List

```bash
node bin/spa-kit.mjs list ~/Projects/clients
```

## What each generated project contains

| Path | Role |
| ---- | ---- |
| `app/` | Routes, plus `robots.ts`, `sitemap.ts`, `llms.txt/route.ts`, `icon.svg` |
| `lib/site.ts` | Name, URL, locale, indexable routes — the SEO source of truth |
| `lib/seo/` | Metadata and JSON-LD builders |
| `design/` | Copied tokens and motion primitives. The client's brand lives here |
| `components/` | `Reveal` and the deferred WebGL backdrop |
| `spa-kit.json` | Machine-readable project config the toolchain reads |
| `contract.json` | The breaker's invariants for this site |
| `CLAUDE.md` | Working rules for an agent editing this project |

The design system is **copied, not linked**. It is product source, like a
component pulled from a registry: each client's brand diverges from day one, and
a shared package would make every colour change a cross-client event.

## For an agent driving this

- Nothing is interactive. Every command takes flags and returns.
- `--json` on `new`, `verify` and `list`.
- Exit codes: `0` success · `1` verification failed · `2` usage or environment
  error. **`2` means inconclusive — never treat it as a pass.**
- `verify --json` returns a `steps` array, each with `name`, `passed`,
  `exitCode` and a `detail` string carrying the oracle's own summary line.

## Two behaviours worth knowing

**Canonical URLs.** A generated site advertises its production origin
(`https://acmerobotics.com`) even while served on `localhost:4400`. That is
correct — and it means the SEO probe is given `--canonical-base` separately from
`--base`, so it checks the canonical the client will actually ship. `verify`
wires this from `spa-kit.json` automatically.

**Template changes do not reach generated projects.** A site is a copy, so
improving the template only affects sites generated afterwards. This is the same
trade-off as the component registries, and it is deliberate: a shared package
would make every change a cross-client event. Re-generate, or port the change by
hand.

**Visual baselines.** The first `verify` of a project has no reference images,
which would otherwise fail for the wrong reason. The CLI detects the absence and
seeds the baselines into `<project>/tests/__screenshots__`, reporting `visual
baselines created`. They belong to the project and should be committed with it.
Baselines are per-platform, so the ones generated on macOS do not satisfy Linux
CI (see `toolchain.md`).
