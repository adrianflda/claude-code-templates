import { Reveal } from "@/components/reveal.tsx";
import { ShaderField } from "@/components/shader-field.tsx";
import { content } from "@/content.ts";

/**
 * Home page, rendered from `content.ts`.
 *
 * What must hold regardless of what the content says:
 *  - the hero headline is the only <h1>;
 *  - every section renders unconditionally, so it is in the server HTML;
 *  - Reveal only animates what is already there.
 */
export default function HomePage() {
  const { hero, sections } = content;

  return (
    <main id="main" className="relative isolate min-h-dvh overflow-hidden">
      <ShaderField className="absolute inset-0 -z-20 opacity-60" />
      <div className="kit-grid-field pointer-events-none absolute inset-0 -z-10" />

      <div className="mx-auto max-w-5xl px-6 py-24 sm:py-32">
        <Reveal>
          <h1 className="max-w-3xl text-balance text-5xl font-medium tracking-[-0.02em] text-fg sm:text-6xl">
            {hero.headline}
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-relaxed text-fg-secondary">{hero.subhead}</p>

          {(hero.primary || hero.secondary) && (
            <div className="mt-10 flex flex-wrap items-center gap-4">
              {hero.primary && (
                <a
                  href={hero.primary.href}
                  className="rounded-md border border-signal/40 bg-signal/10 px-5 py-2.5 text-sm font-medium text-fg transition-colors duration-[var(--kit-dur-fast)] ease-[var(--kit-ease-glide)] hover:bg-signal/20"
                >
                  {hero.primary.label}
                </a>
              )}
              {hero.secondary && (
                <a
                  href={hero.secondary.href}
                  className="rounded-md border border-rim px-5 py-2.5 text-sm text-fg-secondary transition-colors duration-[var(--kit-dur-fast)] ease-[var(--kit-ease-glide)] hover:text-fg"
                >
                  {hero.secondary.label}
                </a>
              )}
            </div>
          )}
        </Reveal>

        {sections.length > 0 && (
          <div className="mt-20 grid gap-px overflow-hidden rounded-lg border border-rim bg-rim sm:grid-cols-2 lg:grid-cols-3">
            {sections.map((section, i) => (
              <Reveal key={section.id} delay={0.06 * i} className="bg-abyss">
                <article id={section.id} className="h-full p-6">
                  {section.label && <p className="kit-label">{section.label}</p>}
                  <h2 className="mt-4 text-lg font-medium text-fg">{section.title}</h2>
                  <p className="mt-3 text-sm leading-relaxed text-fg-muted">{section.body}</p>
                </article>
              </Reveal>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
