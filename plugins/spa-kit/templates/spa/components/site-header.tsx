import { content } from "@/content.ts";

/**
 * Site header.
 *
 * Server-rendered: the navigation is part of the document a crawler reads, and
 * it is what tells an answer engine how the site is structured. The skip link
 * is first in the tab order, which the accessibility suite checks.
 */
export function SiteHeader({ name }: { name: string }) {
  return (
    <header className="sticky top-0 z-50 border-b border-rim/60 bg-void/80 backdrop-blur-md">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-3 focus:z-50 focus:rounded-md focus:bg-abyss focus:px-4 focus:py-2 focus:text-sm focus:text-fg"
      >
        {content.ui.skipToContent}
      </a>

      <div className="mx-auto flex max-w-5xl items-center justify-between gap-6 px-6 py-4">
        <a href="/" className="text-sm font-medium tracking-[-0.01em] text-fg">
          {name}
        </a>

        {content.nav.length > 0 && (
          <nav aria-label={content.ui.primaryNav}>
            <ul className="flex items-center gap-6">
              {content.nav.map((item) => (
                <li key={item.href}>
                  <a
                    href={item.href}
                    className="text-sm text-fg-muted transition-colors duration-[var(--kit-dur-fast)] ease-[var(--kit-ease-glide)] hover:text-fg"
                  >
                    {item.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        )}
      </div>
    </header>
  );
}
