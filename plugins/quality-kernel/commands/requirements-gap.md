---
description: Analyze whether existing code (one or several integrated repos) meets a set of requirements — a cumple/parcial/falta coverage map with evidence, verified by execution where possible. Read-only.
argument-hint: "<requirements: inline text, doc paths, an issue, or an image showing where the docs are> + the repo path(s)"
---

Run the **requirements-coverage** skill on `$ARGUMENTS`.

This is the friendly entry point for "does what we already built meet these requirements, or what's
missing?". Invoke the `requirements-coverage` skill and follow it exactly:

1. **Ingest the requirements** from whatever the user gave — inline text, document paths, an issue,
   and/or **an image** (read the screenshot to find the document names/locations, then load them).
   Also collect the **repo path(s)** to analyze (ask only if none were provided).
2. **Stage A** — extract requirements with parallel analyst agents, then normalize/dedupe with
   `req-normalize.mjs` into a canonical set.
3. **Stage B** — map the repos (`code-explorer`), assess each requirement in parallel
   (cumple/parcial/falta + evidence + a runnable read-only `check` where one exists), then
   `coverage-assemble.mjs` (verifies by execution, enforces read-only) and `coverage-report.mjs`.
4. **Deliver** `coverage-report.md` + `coverage.json`, clearly separating verified-by-execution from
   analytical verdicts. Never modify the analyzed repos; never claim a green a check didn't produce.
