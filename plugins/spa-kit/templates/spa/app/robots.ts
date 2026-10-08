import type { MetadataRoute } from "next";
import { site, absoluteUrl } from "@/lib/site.ts";

/**
 * robots.txt.
 *
 * AI crawlers are allowed explicitly rather than by omission: being listed and
 * allowed is the documented precondition for appearing in answer engines, and
 * an explicit entry makes an accidental block visible in review.
 * Adjust per project — allowing training crawlers is a business decision.
 */
const aiCrawlers = [
  "GPTBot",          // OpenAI — training and retrieval
  "OAI-SearchBot",   // OpenAI — search index
  "ChatGPT-User",    // OpenAI — user-initiated fetch
  "ClaudeBot",       // Anthropic — index
  "Claude-User",     // Anthropic — user-initiated fetch
  "PerplexityBot",   // Perplexity — index
  "Perplexity-User", // Perplexity — user-initiated fetch
  "Google-Extended", // Google — Gemini / AI Overviews grounding
  "Applebot-Extended",
  "CCBot",           // Common Crawl
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", allow: "/", disallow: ["/api/"] },
      ...aiCrawlers.map((userAgent) => ({ userAgent, allow: "/" })),
    ],
    sitemap: absoluteUrl("/sitemap.xml"),
    host: site.url,
  };
}
