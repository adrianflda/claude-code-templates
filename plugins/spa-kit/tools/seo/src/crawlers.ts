/**
 * Agentic crawler identities used by the visibility probe.
 *
 * Evidence base (verified Sep 2026): GPTBot, OAI-SearchBot, ChatGPT-User,
 * ClaudeBot, Claude-User, PerplexityBot, Perplexity-User, Bytespider and CCBot
 * fetch raw HTML and do NOT execute JavaScript. They do not wait for hydration
 * and do not retry. Whatever is not in the initial HTML response does not exist
 * for them.
 *
 * Two documented exceptions, which is why they are not in this list:
 *  - Google AI Overviews / AI Mode inherit Googlebot's rendering pipeline.
 *  - Microsoft Copilot inherits Bing's.
 * A client-rendered page can therefore be visible to those two and invisible to
 * everyone else. `Google-Extended` and `Applebot-Extended` are robots.txt
 * control tokens, not crawlers with their own user agent, so they are only
 * meaningful in robots.txt — never as a request header.
 */
export interface CrawlerIdentity {
  /** Token as it appears in robots.txt. */
  token: string;
  /** User-Agent header to send, when the crawler has one. */
  userAgent: string;
  operator: string;
}

export const agenticCrawlers: readonly CrawlerIdentity[] = [
  {
    token: "GPTBot",
    userAgent:
      "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot",
    operator: "OpenAI",
  },
  {
    token: "OAI-SearchBot",
    userAgent:
      "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot",
    operator: "OpenAI",
  },
  {
    token: "ClaudeBot",
    userAgent: "Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
    operator: "Anthropic",
  },
  {
    token: "PerplexityBot",
    userAgent:
      "Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)",
    operator: "Perplexity",
  },
  {
    token: "CCBot",
    userAgent: "CCBot/2.0 (https://commoncrawl.org/faq/)",
    operator: "Common Crawl",
  },
] as const;

/** robots.txt tokens that must be allowed but are never sent as a User-Agent. */
export const controlTokens: readonly string[] = ["Google-Extended", "Applebot-Extended"];
