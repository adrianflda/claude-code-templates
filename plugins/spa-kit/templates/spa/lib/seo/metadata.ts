import type { Metadata } from "next";
import { site, absoluteUrl } from "@/lib/site.ts";

interface PageMetaInput {
  title: string;
  description: string;
  path: string;
  /** Set false for routes that must never be indexed (dashboards, previews). */
  indexable?: boolean;
}

/**
 * Builds the metadata block every indexable route is required to have.
 * Centralised so the SEO probe can assert one shape instead of many.
 */
export function pageMetadata({
  title,
  description,
  path,
  indexable = true,
}: PageMetaInput): Metadata {
  const url = absoluteUrl(path);
  return {
    metadataBase: new URL(site.url),
    title,
    description,
    alternates: { canonical: url },
    robots: indexable
      ? { index: true, follow: true, "max-snippet": -1, "max-image-preview": "large" }
      : { index: false, follow: false },
    openGraph: {
      type: "website",
      siteName: site.name,
      locale: site.locale,
      title,
      description,
      url,
    },
    twitter: { card: "summary_large_image", title, description },
  };
}
