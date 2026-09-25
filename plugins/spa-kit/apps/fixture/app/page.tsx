import { Reveal } from "../components/reveal.tsx";
import { ShaderField } from "../components/shader-field.tsx";

/**
 * Fixture page.
 *
 * Its job is to be a verification target, so it deliberately exercises every
 * pattern the tools assert on: server-rendered prose, one <h1>, JSON-LD from
 * the layout, a client-side reveal over content that is already in the HTML,
 * and a deferred WebGL backdrop.
 */

const PILLARS = [
  {
    label: "Design",
    title: "Tokens before components",
    body: "Colour lives in OKLCH, depth comes from emitted light rather than drop shadows, and every duration and easing curve is a token. A component that reaches for a literal duration is a lint error, because freezing motion for a screenshot has to be one switch rather than a search.",
  },
  {
    label: "Implementation",
    title: "Server-rendered by default",
    body: "Navigation feels like a single-page application while every route still answers with complete HTML. Interactivity is layered on top of content that already exists in the document, never used as the mechanism that puts it there.",
  },
  {
    label: "Verification",
    title: "Oracles, not opinions",
    body: "Each guarantee has an executable check behind it: a crawler probe that runs with no JavaScript engine, a blind breaker that only sees the contract and a live URL, deterministic visual baselines, and performance budgets that fail the build.",
  },
] as const;

export default function HomePage() {
  return (
    <main className="relative isolate min-h-dvh overflow-hidden">
      <ShaderField className="absolute inset-0 -z-20 opacity-60" />
      <div className="kit-grid-field pointer-events-none absolute inset-0 -z-10" />

      <div className="mx-auto max-w-5xl px-6 py-24 sm:py-32">
        <Reveal>
          <p className="kit-label">SPA Kit · Toolchain fixture</p>
          <h1 className="mt-6 max-w-3xl text-balance text-5xl font-medium tracking-[-0.02em] text-fg sm:text-6xl">
            A single-page application that answer engines can still read.
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-relaxed text-fg-secondary">
            This page is the fixture the toolchain verifies itself against. Every claim the kit
            makes about design, implementation and end-to-end testing is asserted here by a check
            that executes against this running server rather than by a note in a document.
          </p>

          <div className="mt-10 flex flex-wrap items-center gap-4">
            <a
              href="/llms.txt"
              className="rounded-md border border-signal/40 bg-signal/10 px-5 py-2.5 text-sm font-medium text-fg transition-colors duration-[var(--kit-dur-fast)] ease-[var(--kit-ease-glide)] hover:bg-signal/20"
            >
              Read the agent map
            </a>
            <a
              href="/sitemap.xml"
              className="rounded-md border border-rim px-5 py-2.5 text-sm text-fg-secondary transition-colors duration-[var(--kit-dur-fast)] ease-[var(--kit-ease-glide)] hover:text-fg"
            >
              Inspect the sitemap
            </a>
          </div>
        </Reveal>

        <div className="mt-20 grid gap-px overflow-hidden rounded-lg border border-rim bg-rim sm:grid-cols-3">
          {PILLARS.map((pillar, i) => (
            <Reveal key={pillar.label} delay={0.06 * i} className="bg-abyss">
              <article className="h-full p-6">
                <p className="kit-label">{pillar.label}</p>
                <h2 className="mt-4 text-lg font-medium text-fg">{pillar.title}</h2>
                <p className="mt-3 text-sm leading-relaxed text-fg-muted">{pillar.body}</p>
              </article>
            </Reveal>
          ))}
        </div>

        <Reveal delay={0.12}>
          <section className="mt-20 rounded-lg border border-rim bg-hull/60 p-8">
            <h2 className="text-xl font-medium text-fg">Why the render strategy is not negotiable</h2>
            <p className="mt-4 max-w-3xl text-sm leading-relaxed text-fg-secondary">
              As of 2026, GPTBot, OAI-SearchBot, ClaudeBot, PerplexityBot and CCBot fetch raw HTML
              and do not execute JavaScript. They do not wait for hydration and they do not retry.
              A client-rendered page therefore reaches them as an empty shell, no matter how good
              its content is. Google AI Overviews and Microsoft Copilot are the two documented
              exceptions, because they inherit the rendering pipelines of Googlebot and Bing.
            </p>
            <p className="mt-4 max-w-3xl text-sm leading-relaxed text-fg-secondary">
              That asymmetry is the reason this kit treats server-rendered HTML as a hard
              requirement and keeps an executable probe for it, instead of trusting that a
              framework default will hold as the application grows.
            </p>
          </section>
        </Reveal>
      </div>
    </main>
  );
}
