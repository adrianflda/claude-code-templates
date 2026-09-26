import { fetchRaw, jsonLdBlocks } from "./html.ts";
import { fail, pass, advise, type Suite } from "./types.ts";

const UA = "kit-seo-probe/0.1 (+structured-data)";

/** Types worth asserting on; extend per project rather than accepting anything. */
const KNOWN_TYPES = new Set([
  "Organization",
  "WebSite",
  "WebPage",
  "Article",
  "BlogPosting",
  "Product",
  "Offer",
  "FAQPage",
  "Question",
  "BreadcrumbList",
  "SoftwareApplication",
  "Person",
  "Event",
]);

interface Node {
  "@type"?: string | string[];
  "@id"?: string;
  [key: string]: unknown;
}

function flatten(value: unknown, out: Node[] = []): Node[] {
  if (Array.isArray(value)) {
    for (const item of value) flatten(item, out);
    return out;
  }
  if (value && typeof value === "object") {
    const node = value as Node;
    if (node["@type"]) out.push(node);
    for (const [key, child] of Object.entries(node)) {
      if (key.startsWith("@")) continue;
      flatten(child, out);
    }
  }
  return out;
}

/** Collects every `{"@id": ...}` reference that is not itself a typed node. */
function references(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) references(item, out);
    return out;
  }
  if (value && typeof value === "object") {
    const node = value as Node;
    const keys = Object.keys(node);
    if (keys.length === 1 && keys[0] === "@id" && typeof node["@id"] === "string") {
      out.push(node["@id"]);
      return out;
    }
    for (const [key, child] of Object.entries(node)) {
      if (key.startsWith("@")) continue;
      references(child, out);
    }
  }
  return out;
}

export async function structuredDataSuite(
  baseUrl: string,
  routes: readonly string[],
): Promise<Suite> {
  const checks: Suite["checks"] = [];

  for (const route of routes) {
    const url = new URL(route, baseUrl).toString();
    const page = await fetchRaw(url, UA);
    const blocks = jsonLdBlocks(page.doc);

    if (blocks.length === 0) {
      checks.push(fail("schema.present", url, "no <script type=\"application/ld+json\"> found"));
      continue;
    }

    const broken = blocks.filter((b) => b.error);
    checks.push(
      broken.length === 0
        ? pass("schema.parses", url, `${blocks.length} block(s) parse as JSON`)
        : fail("schema.parses", url, `${broken.length} block(s) failed: ${broken[0]!.error}`),
    );

    const parsed = blocks.filter((b) => !b.error).map((b) => b.parsed);
    const nodes = flatten(parsed);
    const ids = new Set(nodes.map((n) => n["@id"]).filter((v): v is string => typeof v === "string"));

    for (const block of blocks.filter((b) => !b.error)) {
      const root = block.parsed as Node;
      const context = (root as Record<string, unknown>)["@context"];
      const ok =
        typeof context === "string" && /^https?:\/\/schema\.org\/?$/.test(context.replace(/\/$/, "/"));
      checks.push(
        ok
          ? pass("schema.context", url, `@context = ${String(context)}`)
          : fail("schema.context", url, `@context = ${JSON.stringify(context)}, expected schema.org`),
      );
    }

    const typeNames = nodes.flatMap((n) =>
      Array.isArray(n["@type"]) ? n["@type"] : n["@type"] ? [n["@type"]] : [],
    );
    const unknown = typeNames.filter((t) => !KNOWN_TYPES.has(t));
    checks.push(
      unknown.length === 0
        ? pass("schema.types", url, `types: ${typeNames.join(", ")}`)
        : advise("schema.types", url, false, `unrecognised @type values: ${unknown.join(", ")}`),
    );

    const relativeIds = [...ids].filter((id) => !/^https?:\/\//.test(id));
    checks.push(
      relativeIds.length === 0
        ? pass("schema.absolute-ids", url, `@id values absolute: ${[...ids].join(", ") || "none"}`)
        : fail("schema.absolute-ids", url, `relative @id: ${relativeIds.join(", ")}`),
    );

    const dangling = references(parsed).filter((ref) => !ids.has(ref));
    checks.push(
      dangling.length === 0
        ? pass("schema.references-resolve", url, "every {@id} reference resolves inside the graph")
        : fail("schema.references-resolve", url, `dangling references: ${dangling.join(", ")}`),
    );
  }

  return { name: "structured data", checks };
}
