---
name: prompt-caching
description: "Caching strategies for LLM prompts including Anthropic prompt caching, response caching, and CAG (Cache Augmented Generation) Use when: prompt caching, cache prompt, response cache, cag, cache augmented."
source: vibeship-spawner-skills (Apache 2.0)
---

# Prompt Caching

Core principle: cache at the right level—prefix, response, or both.

## Capabilities

- prompt-cache
- response-cache
- kv-cache
- cag-patterns
- cache-invalidation

## Patterns

### Anthropic Prompt Caching

Use Claude's native prompt caching for repeated prefixes. For current API parameters, TTLs and pricing, use the `claude-api` skill rather than memory.

The rules that decide whether a cache is hit at all:

- The cache is a prefix match: one changed byte invalidates everything after it. The request is rendered as `tools`, then `system`, then `messages`.
- Stable content first (a frozen system prompt, a tool list in a fixed order); volatile content (timestamps, request ids, the question) after the last `cache_control` breakpoint.
- At most 4 breakpoints per request. A prefix shorter than the model's minimum is not cached and nothing says so.
- To give an instruction in the middle of a conversation, append a message instead of editing the top-level `system`, which would invalidate the cached history.
- Verify: `usage.cache_read_input_tokens` that stays at zero across repeated requests means something in the prefix changes each time (a `datetime.now()` in the system prompt, JSON keys in a varying order, a tool set that varies).

### Response Caching

Cache full LLM responses for identical or similar queries

### Cache Augmented Generation (CAG)

Pre-cache documents in prompt instead of RAG retrieval

## Anti-Patterns

- Caching full responses of a request sent with a high temperature: the caller asked for variety and gets one answer.
- A response cache with no invalidation: the answer outlives the data it was built from.
- Caching everything: a prefix that is rarely repeated costs the cache-write premium and is never read.

## ⚠️ Sharp Edges

| Issue | Severity | Solution |
|-------|----------|----------|
| Cache miss causes latency spike with additional overhead | high | Optimize for cache misses, not just hits |
| Cached responses become incorrect over time | high | Implement proper cache invalidation |
| Prompt caching doesn't work due to prefix changes | medium | Keep the static prefix byte-identical; put variable content last |

