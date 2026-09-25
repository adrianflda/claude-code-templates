# SEO and agentic search (AEO / GEO)

## The finding that drives every decision here

Verified September 2026: **GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot,
Claude-User, PerplexityBot, Perplexity-User, Bytespider and CCBot fetch raw HTML
and do not execute JavaScript.** They do not wait for hydration and they do not
retry. Whatever is not in the first HTML response does not exist for them.

Two documented exceptions, because they inherit an existing rendering pipeline:

- Google AI Overviews and AI Mode inherit Googlebot's rendering.
- Microsoft Copilot inherits Bing's.

So a client-rendered page can be visible to those two and invisible to everyone
else. One published analysis (Onely, February 2026) put the share of
JavaScript-rendered content that never gets indexed by AI systems at 42%.

Consequence for this kit: **server-rendered HTML is a hard requirement, not an
optimisation.** A "modern SPA" here means SPA-like navigation on top of routes
that each answer with complete HTML — never content that only exists after
hydration.

The single-line test, which is also what `tools/seo` automates: view source (not
the DevTools element inspector). If the answer-bearing text is not in view
source, answer engines cannot read it.

## What the tools assert

`npm run seo` runs three suites. Every check reports the evidence it observed,
not the rule it applied.

### 1. Indexability (`tools/seo/src/indexability.ts`)

- `robots.txt` is served.
- Each AI crawler token is allowed at `/`, resolved with longest-match
  precedence by a small robots.txt parser rather than by eyeballing the file.
  `Google-Extended` and `Applebot-Extended` are included: they are robots.txt
  **control tokens**, not crawlers with a user agent, so robots.txt is the only
  place they mean anything.
- `robots.txt` declares a `Sitemap:`.
- `sitemap.xml` is served, every indexable route appears in it, and every `<loc>`
  is an absolute URL.

### 2. Structured data (`tools/seo/src/structured-data.ts`)

- At least one `application/ld+json` block, parsed out of **raw HTML**.
- Every block parses as JSON and declares `@context: https://schema.org`.
- Every `@id` is absolute.
- Every `{"@id": …}` reference resolves to a typed node in the same graph —
  the check that catches an entity graph which only looks connected.
- Unrecognised `@type` values are advisory, not failures.

### 3. Agentic visibility (`tools/seo/src/agentic.ts`)

For each indexable route, requested as each crawler, with no JavaScript engine
in the path:

- HTTP 200.
- The body is not an empty shell (`<body><div id="…"></div><script…>`).
- At least 300 characters of visible text, script/style/noscript stripped.
- Exactly one `<h1>`.
- Non-empty `<title>` and `meta description`.
- A self-referential absolute canonical.
- Parseable JSON-LD.

Plus one advisory check: `/llms.txt` is served and starts with a Markdown
heading.

## llms.txt: what it is and is not

Stated plainly so nobody builds a strategy on it:

- **Not a ranking lever.** Google's May 2026 AI-optimisation guidance says
  llms.txt is not needed for AI Overviews, AI Mode, or any generative Search
  feature.
- **A real agent-readiness signal.** Anthropic recommends it in its guidance on
  writing for agents, and OpenAI publishes llms.txt for the Agents SDK and the
  Agentic Commerce Protocol.

It is cheap to serve and honest to keep accurate, so the kit serves it — as an
advisory check, never as a gate.

## Budget guidance, not a rule

Published GEO practice for a brand with an established SEO programme lands
around **70% classic SEO, 25% GEO-specific work** (measurement, content shaping,
off-page seeding), **5% experiments**. Useful as an anchor against the assumption
that AEO replaces SEO. It does not.

## Sources

- [Do AI Crawlers Render JavaScript? GPTBot, ClaudeBot, and Perplexity in 2026 — SearchOptimo](https://searchoptimo.com/blog/do-ai-crawlers-render-javascript)
- [Most AI Crawlers Still Don't Render JavaScript in 2026 — HybridRanking](https://hybridranking.com/blog/most-ai-crawlers-dont-render-javascript-2026)
- [JavaScript Rendering and AI Crawlers: Can LLMs Read Your SPA? — Passionfruit](https://www.getpassionfruit.com/blog/javascript-rendering-and-ai-crawlers-can-llms-read-your-spa)
- [Should I Create an llms.txt File? 2026 Guide — Passionfruit](https://www.getpassionfruit.com/blog/should-i-create-an-llms.txt-file-google-s-2026-guidance-explained)
- [What Is LLMs.txt? The Guide To AI Search & GEO — Yotpo](https://www.yotpo.com/blog/what-is-llms-txt/)
- [Generative Engine Optimization (GEO): The Complete Guide for 2026 — LLM Pulse](https://llmpulse.ai/blog/geo-guide/)
- [Optimizing Visibility in Generative Engines: A Critical Survey of GEO (2023–2026) — arXiv](https://arxiv.org/pdf/2607.14035)
