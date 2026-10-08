import { agenticCrawlers } from "./crawlers.ts";
import { fetchRaw, visibleText, canonical, metaContent, jsonLdBlocks } from "./html.ts";
import { fail, pass, type Suite, advise } from "./types.ts";

/**
 * The agentic-visibility oracle.
 *
 * It requests every indexable route as each AI crawler, with no JavaScript
 * engine anywhere in the path, and asserts that the answer-bearing content is
 * present in the first HTML response. This is the check that catches a
 * client-rendered page shipping an empty shell to answer engines.
 */
export interface AgenticOptions {
  baseUrl: string;
  routes: readonly string[];
  /**
   * Origin the site declares as canonical. A staged or local build serves on
   * localhost but must still advertise its production origin, so the canonical
   * is checked against this rather than against the address we fetched from.
   */
  canonicalBase?: string;
  /** Minimum characters of visible text a real content page must carry. */
  minVisibleText?: number;
  /** Primary language the site declares, e.g. "es". Checked against <html lang>. */
  expectedLang?: string;
}

/**
 * `https://x.com` and `https://x.com/` address the same resource, and Next emits
 * the root canonical without the trailing slash. Compare normalised forms so the
 * probe reports a real canonical mismatch rather than a formatting difference.
 */
function sameUrl(a: string, b: string): boolean {
  const norm = (value: string): string => {
    try {
      const url = new URL(value);
      url.hash = "";
      if (url.pathname === "") url.pathname = "/";
      return url.toString();
    } catch {
      return value;
    }
  };
  return norm(a) === norm(b);
}

const SHELL_PATTERN = /<body[^>]*>\s*(<div[^>]*>\s*<\/div>\s*)*(<script[^>]*>.*?<\/script>\s*)*<\/body>/is;

export async function agenticSuite(opts: AgenticOptions): Promise<Suite> {
  const { baseUrl, routes, minVisibleText = 300 } = opts;
  const canonicalBase = opts.canonicalBase ?? baseUrl;
  const checks: Suite["checks"] = [];

  for (const route of routes) {
    const url = new URL(route, baseUrl).toString();

    for (const crawler of agenticCrawlers) {
      const id = `agentic.${crawler.token}`;
      let page;
      try {
        page = await fetchRaw(url, crawler.userAgent);
      } catch (err) {
        checks.push(fail(id, url, `request failed as ${crawler.token}: ${String(err)}`));
        continue;
      }

      if (page.status !== 200) {
        checks.push(fail(id, url, `${crawler.token} received HTTP ${page.status}`));
        continue;
      }

      const text = visibleText(page.doc);
      if (SHELL_PATTERN.test(page.html)) {
        checks.push(
          fail(id, url, `${crawler.token} received an empty shell: body holds no rendered content`),
        );
        continue;
      }
      if (text.length < minVisibleText) {
        checks.push(
          fail(
            id,
            url,
            `${crawler.token} sees only ${text.length} chars of text (minimum ${minVisibleText}); first 120: "${text.slice(0, 120)}"`,
          ),
        );
        continue;
      }

      checks.push(
        pass(id, url, `${crawler.token} sees ${text.length} chars of server-rendered text`),
      );
    }

    // Structure the answer engine needs to attribute and quote the page.
    const probe = await fetchRaw(url, agenticCrawlers[0]!.userAgent);
    const h1s = probe.doc.querySelectorAll("h1");
    checks.push(
      h1s.length === 1
        ? pass("agentic.h1", url, `exactly one <h1>: "${h1s[0]!.structuredText.trim()}"`)
        : fail("agentic.h1", url, `found ${h1s.length} <h1> elements; answer engines expect one`),
    );

    // A wrong or missing <html lang> misdirects screen readers and tells search
    // and answer engines the page is in a language it is not.
    const htmlLang = probe.doc.querySelector("html")?.getAttribute("lang")?.trim() ?? "";
    const expected = opts.expectedLang?.split(/[-_]/)[0]?.toLowerCase();
    checks.push(
      htmlLang.length === 0
        ? fail("agentic.html-lang", url, "<html> has no lang attribute")
        : expected && htmlLang.split(/[-_]/)[0]?.toLowerCase() !== expected
          ? fail("agentic.html-lang", url, `<html lang="${htmlLang}"> but the site declares "${expected}"`)
          : pass("agentic.html-lang", url, `<html lang="${htmlLang}">`),
    );

    const title = probe.doc.querySelector("title")?.structuredText.trim() ?? "";
    checks.push(
      title.length > 0
        ? pass("agentic.title", url, `<title> = "${title}"`)
        : fail("agentic.title", url, "<title> missing or empty in raw HTML"),
    );

    const description = metaContent(probe.doc, "description");
    checks.push(
      description && description.length > 0
        ? pass("agentic.description", url, `meta description = "${description.slice(0, 80)}…"`)
        : fail("agentic.description", url, "meta description missing in raw HTML"),
    );

    const expectedCanonical = new URL(route, canonicalBase).toString();
    const href = canonical(probe.doc);
    checks.push(
      href !== null && sameUrl(href, expectedCanonical)
        ? pass("agentic.canonical", url, `self-referential canonical = ${href}`)
        : fail(
            "agentic.canonical",
            url,
            `canonical is ${href ?? "missing"}, expected ${expectedCanonical}`,
          ),
    );

    const blocks = jsonLdBlocks(probe.doc);
    checks.push(
      blocks.length > 0 && blocks.every((b) => !b.error)
        ? pass("agentic.jsonld-present", url, `${blocks.length} JSON-LD block(s) parsed from raw HTML`)
        : fail(
            "agentic.jsonld-present",
            url,
            blocks.length === 0
              ? "no JSON-LD in raw HTML"
              : `JSON-LD parse error: ${blocks.find((b) => b.error)?.error}`,
          ),
    );
  }

  // llms.txt: an agent-readiness signal, not a ranking factor — advisory only.
  const llmsUrl = new URL("/llms.txt", baseUrl).toString();
  try {
    const res = await fetch(llmsUrl, { headers: { "user-agent": agenticCrawlers[0]!.userAgent } });
    const body = await res.text();
    checks.push(
      advise(
        "agentic.llms-txt",
        llmsUrl,
        res.status === 200 && body.trimStart().startsWith("#"),
        res.status === 200
          ? `served ${body.length} bytes, starts with "${body.trimStart().slice(0, 24)}"`
          : `HTTP ${res.status}`,
      ),
    );
  } catch (err) {
    checks.push(advise("agentic.llms-txt", llmsUrl, false, `request failed: ${String(err)}`));
  }

  return { name: "agentic visibility (no JavaScript)", checks };
}
