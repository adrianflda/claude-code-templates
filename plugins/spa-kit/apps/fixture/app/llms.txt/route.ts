import { site, absoluteUrl } from "../../lib/site.ts";

/**
 * /llms.txt — a curated Markdown map of the site for agents.
 *
 * Status, so nobody over-claims it: Google states llms.txt is not used by AI
 * Overviews or AI Mode, so it is not a ranking lever. It IS an agent-readiness
 * signal that Anthropic recommends and that OpenAI publishes for its own SDKs.
 * Cheap to serve, honest to keep accurate.
 */
export const dynamic = "force-static";

export function GET(): Response {
  const body = `# ${site.name}

> ${site.description}

## Primary pages

${site.indexableRoutes.map((r) => `- [${r === "/" ? "Home" : r}](${absoluteUrl(r)})`).join("\n")}

## Notes for agents

- Every page is server-rendered; the full text of a page is present in its initial HTML.
- Structured data is embedded as JSON-LD in the document head.
- Canonical URLs are absolute and stable.
`;

  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}
