import type { Organization, WebSite, WithContext } from "schema-dts";
import { site, absoluteUrl } from "@/lib/site.ts";

/**
 * Structured data. Answer engines parse JSON-LD from raw HTML, so these blocks
 * are rendered server-side inside <script type="application/ld+json">, never
 * injected on the client.
 *
 * Stable @id values let separate nodes reference each other instead of
 * repeating themselves, which is what validators expect of a real entity graph.
 */
export const organizationId = absoluteUrl("/#organization");
export const websiteId = absoluteUrl("/#website");

export function organizationSchema(): WithContext<Organization> {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": organizationId,
    name: site.name,
    url: site.url,
    description: site.description,
  };
}

export function websiteSchema(): WithContext<WebSite> {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": websiteId,
    name: site.name,
    url: site.url,
    description: site.description,
    publisher: { "@id": organizationId },
    inLanguage: "en",
  };
}

/** Serialise for embedding. `<` is escaped so the payload cannot close the script tag. */
export function jsonLdScript(schema: object): string {
  return JSON.stringify(schema).replace(/</g, "\\u003c");
}
