/** Single source of truth for anything the SEO/AEO tools assert against. */
export const site = {
  name: "__SPA_NAME__",
  /** Absolute origin. Every canonical, sitemap entry and JSON-LD @id derives from it. */
  url: process.env["NEXT_PUBLIC_SITE_URL"] ?? "__SPA_URL__",
  description: "__SPA_DESCRIPTION__",
  locale: "__SPA_LOCALE__",
  /**
   * Routes that must be indexable. Keep this in sync with spa-kit.json: the SEO
   * probe walks that list and fails if a route loses its canonical, its
   * metadata, its JSON-LD or its server-rendered body text.
   */
  indexableRoutes: ["/"] as const,
} as const;

export function absoluteUrl(path: string): string {
  return new URL(path, site.url).toString();
}
