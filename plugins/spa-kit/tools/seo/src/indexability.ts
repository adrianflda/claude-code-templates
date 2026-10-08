import { agenticCrawlers, controlTokens } from "./crawlers.ts";
import { fetchRaw } from "./html.ts";
import { fail, pass, type Suite } from "./types.ts";

const UA = "kit-seo-probe/0.1 (+indexability)";

interface RobotsGroup {
  agents: string[];
  allow: string[];
  disallow: string[];
}

/** Minimal robots.txt parser: enough to answer "is this agent blocked from /?". */
export function parseRobots(body: string): { groups: RobotsGroup[]; sitemaps: string[] } {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | null = null;
  let lastLineWasAgent = false;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === "user-agent") {
      if (!current || !lastLineWasAgent) {
        current = { agents: [], allow: [], disallow: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastLineWasAgent = true;
      continue;
    }
    lastLineWasAgent = false;
    if (field === "sitemap") sitemaps.push(value);
    if (!current) continue;
    if (field === "allow") current.allow.push(value);
    if (field === "disallow") current.disallow.push(value);
  }
  return { groups, sitemaps };
}

/** Resolves whether `token` may fetch `path`, using longest-match precedence. */
export function isAllowed(
  groups: RobotsGroup[],
  token: string,
  path: string,
): { allowed: boolean; rule: string } {
  const lower = token.toLowerCase();
  const specific = groups.filter((g) => g.agents.includes(lower));
  const applicable = specific.length > 0 ? specific : groups.filter((g) => g.agents.includes("*"));
  if (applicable.length === 0) return { allowed: true, rule: "no matching group (default allow)" };

  let best: { allowed: boolean; rule: string; length: number } = {
    allowed: true,
    rule: "no matching rule (default allow)",
    length: -1,
  };
  for (const group of applicable) {
    for (const rule of group.disallow) {
      if (rule !== "" && path.startsWith(rule) && rule.length > best.length) {
        best = { allowed: false, rule: `Disallow: ${rule}`, length: rule.length };
      }
    }
    for (const rule of group.allow) {
      if (path.startsWith(rule) && rule.length >= best.length) {
        best = { allowed: true, rule: `Allow: ${rule}`, length: rule.length };
      }
    }
  }
  return { allowed: best.allowed, rule: best.rule };
}

export async function indexabilitySuite(
  baseUrl: string,
  routes: readonly string[],
  /** Origin the site advertises publicly; sitemap entries are checked against it. */
  canonicalBase: string = baseUrl,
): Promise<Suite> {
  const checks: Suite["checks"] = [];
  const robotsUrl = new URL("/robots.txt", baseUrl).toString();

  let robotsBody = "";
  try {
    const res = await fetch(robotsUrl, { headers: { "user-agent": UA } });
    robotsBody = await res.text();
    checks.push(
      res.status === 200
        ? pass("index.robots-served", robotsUrl, `HTTP 200, ${robotsBody.length} bytes`)
        : fail("index.robots-served", robotsUrl, `HTTP ${res.status}`),
    );
  } catch (err) {
    checks.push(fail("index.robots-served", robotsUrl, `request failed: ${String(err)}`));
    return { name: "indexability", checks };
  }

  const { groups, sitemaps } = parseRobots(robotsBody);

  for (const token of [...agenticCrawlers.map((c) => c.token), ...controlTokens]) {
    const verdict = isAllowed(groups, token, "/");
    checks.push(
      verdict.allowed
        ? pass("index.ai-crawler-allowed", token, `allowed at / by "${verdict.rule}"`)
        : fail("index.ai-crawler-allowed", token, `BLOCKED at / by "${verdict.rule}"`),
    );
  }

  const sitemapUrl = new URL("/sitemap.xml", baseUrl).toString();
  checks.push(
    sitemaps.length > 0
      ? pass("index.sitemap-declared", robotsUrl, `robots.txt declares ${sitemaps.join(", ")}`)
      : fail("index.sitemap-declared", robotsUrl, "robots.txt declares no Sitemap:"),
  );

  try {
    const page = await fetchRaw(sitemapUrl, UA);
    const locs = [...page.html.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].map((m) => m[1]!);
    checks.push(
      page.status === 200 && locs.length > 0
        ? pass("index.sitemap-served", sitemapUrl, `HTTP 200 with ${locs.length} <loc> entries`)
        : fail("index.sitemap-served", sitemapUrl, `HTTP ${page.status}, ${locs.length} entries`),
    );

    for (const route of routes) {
      const expected = new URL(route, canonicalBase).toString();
      const found = locs.some((loc) => loc === expected || loc === expected.replace(/\/$/, ""));
      checks.push(
        found
          ? pass("index.route-in-sitemap", expected, "present in sitemap.xml")
          : fail("index.route-in-sitemap", expected, `absent; sitemap holds: ${locs.join(", ")}`),
      );
    }

    const relative = locs.filter((loc) => !/^https?:\/\//.test(loc));
    checks.push(
      relative.length === 0
        ? pass("index.sitemap-absolute", sitemapUrl, "all <loc> values are absolute URLs")
        : fail("index.sitemap-absolute", sitemapUrl, `relative <loc>: ${relative.join(", ")}`),
    );
  } catch (err) {
    checks.push(fail("index.sitemap-served", sitemapUrl, `request failed: ${String(err)}`));
  }

  return { name: "indexability", checks };
}
