import type { MetadataRoute } from "next";
import { site, absoluteUrl } from "../lib/site.ts";

/** Generated from the same route list the SEO probe asserts against. */
export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  return site.indexableRoutes.map((route) => ({
    url: absoluteUrl(route),
    lastModified,
    changeFrequency: "weekly",
    priority: route === "/" ? 1 : 0.7,
  }));
}
