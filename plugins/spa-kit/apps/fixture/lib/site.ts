/** Single source of truth for anything the SEO/AEO tools need to assert against. */
export const site = {
  name: "SPA Kit",
  /** Absolute origin. Every canonical, sitemap entry and JSON-LD @id derives from it. */
  url: process.env["NEXT_PUBLIC_SITE_URL"] ?? "http://localhost:4321",
  description:
    "A toolchain for building a modern single-page application that stays readable by classic search crawlers and by AI answer engines.",
  locale: "en_US",
  /**
   * Routes that must be indexable. The SEO probe walks this list and fails if a
   * route loses its canonical, its metadata, its JSON-LD or its server-rendered
   * body text.
   */
  indexableRoutes: ["/"] as const,
} as const;

export function absoluteUrl(path: string): string {
  return new URL(path, site.url).toString();
}
