import { parse, type HTMLElement } from "node-html-parser";

/** Parsed view of a raw HTML response — exactly what a non-JS crawler sees. */
export interface RawPage {
  url: string;
  status: number;
  contentType: string;
  html: string;
  doc: HTMLElement;
}

export async function fetchRaw(url: string, userAgent: string): Promise<RawPage> {
  const res = await fetch(url, {
    headers: { "user-agent": userAgent, accept: "text/html,application/xhtml+xml" },
    redirect: "follow",
  });
  const html = await res.text();
  return {
    url,
    status: res.status,
    contentType: res.headers.get("content-type") ?? "",
    html,
    doc: parse(html),
  };
}

/** Visible text, with script/style/noscript removed — the crawler's extraction. */
export function visibleText(doc: HTMLElement): string {
  const clone = parse(doc.toString());
  for (const el of clone.querySelectorAll("script, style, noscript, template")) {
    el.remove();
  }
  return clone.structuredText.replace(/\s+/g, " ").trim();
}

export function metaContent(doc: HTMLElement, name: string): string | null {
  const el =
    doc.querySelector(`meta[name="${name}"]`) ?? doc.querySelector(`meta[property="${name}"]`);
  return el?.getAttribute("content") ?? null;
}

export function canonical(doc: HTMLElement): string | null {
  return doc.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? null;
}

/** Every JSON-LD block in the document, with parse errors surfaced not swallowed. */
export function jsonLdBlocks(doc: HTMLElement): Array<{ raw: string; parsed: unknown; error?: string }> {
  return doc.querySelectorAll('script[type="application/ld+json"]').map((el) => {
    const raw = (el.text || el.innerHTML).trim();
    try {
      return { raw, parsed: JSON.parse(raw) as unknown };
    } catch (err) {
      return { raw, parsed: null, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
