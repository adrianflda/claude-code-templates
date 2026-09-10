---
name: requirements-coverage
description: >-
  Analyze whether an existing codebase (one repo or several integrated repos) already satisfies a set
  of requirements, or whether things must still be built/adjusted. Extracts requirements from flexible
  sources (a prompt, document paths, issues, OR an image showing where the docs are), maps the repos,
  and produces a coverage map — cumple / parcial / falta with evidence — verified BY EXECUTION where a
  runnable check exists (not by opinion). Read-only. Use when asked "does what we built meet these
  requirements / what's missing across our apps?".
---

# Requirements coverage — deep, cross-repo, hybrid-rigor, READ-ONLY

Two stages, orchestrated by you as the PM: **A) extract & normalize the requirements** (a team of
parallel analysts), then **B) assess coverage per requirement** (parallel analysts) and aggregate.
Nothing is presented as "met" unless a runnable check re-executed and passed; where none exists, the
verdict is labeled **analytical (unverified)** — never opinion dressed as fact (constitution P2/P3).
**Never modify the analyzed repos.** Deterministic glue lives in the scripts; judgment lives in the
agents; the scripts are the trustworthy part.

Scripts (this plugin): `${CLAUDE_PLUGIN_ROOT}/scripts/{req-normalize,coverage-assemble,coverage-report}.mjs`.

## Inputs (maximally flexible)
Accept any mix in the invocation:
- free-text requirements in the prompt;
- **paths** to requirement documents (any format — .md/.txt/.pdf/.docx text);
- **issue** references (URL/id) — best-effort via `gh` if available;
- **an image** the user pasted (a screenshot of a folder/file list): READ it to identify the document
  names and locations, then load those documents yourself. Do not ask the user to retype them.
Also collect the **repo path(s)** to analyze (one or several).

## Stage A — extract & normalize (PM + parallel analyst agents)
1. Gather the source documents (from paths / image / issues / inline text).
2. As PM, **dispatch one extractor agent per document (or small batch), in PARALLEL** (Agent tool;
   send them in one message so they run concurrently). Each returns a JSON array of candidate
   requirements: `[{ text, source:{doc,location}, category?, priority? }]` — atomic, one testable
   statement each; verbatim intent, no paraphrase drift.
3. Concatenate all candidates and run the deterministic normalizer:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/req-normalize.mjs" --in candidates.json > requirements.json`
   → the canonical, **deduplicated** set (`REQ-001…`, sources merged). Show the user the count and a
   glance of the set before the heavy Stage B if the set is large.

## Stage B — assess coverage (map repos, then parallel per requirement)
1. **Map each repo** (reuse the `code-explorer` agent): languages, entry points, modules, tests, public
   API surface; and **infer cross-repo integration** (imports, HTTP/RPC calls between services, shared
   packages/contracts, env pointing at another service).
2. As PM, **dispatch coverage-analyst agents in PARALLEL** over the requirements (fan out; bounded —
   batch if there are many). Each requirement gets one result:
   `{ id, verdict:"cumple"|"parcial"|"falta", confidence, evidence:[{repo,path,symbol}],
     check?:{command,cwd}, actions:[] }`
   - `evidence` = the concrete files/functions/flows (cross-repo requirements cite BOTH repos).
   - `check` (HYBRID rigor) = a **read-only** runnable command that would confirm the requirement
     against the real code (an existing test, a CLI, a curl against a local endpoint). Include it
     whenever one exists; omit it when the requirement can only be judged analytically.
   - `actions` = concrete, prioritized steps for `parcial`/`falta` (what to build / adjust).
3. Assemble + verify by execution + validate (read-only enforced by a before/after repo hash):
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/coverage-assemble.mjs" --requirements requirements.json --results results.json > coverage.json`
   (exit non-zero ⇒ a structural/consistency problem or a read-only violation — fix and re-run).
4. Render the report:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/coverage-report.mjs" --coverage coverage.json > coverage-report.md`

## Deliver
Hand back **`coverage-report.md`** (summary %cumple + the table + a priority-ordered backlog) and the
structured **`coverage.json`** (one entry per requirement). State plainly which verdicts are
**verified-by-execution** vs **analytical**; never claim a green that a check didn't produce.

## Guardrails
- **Read-only**: never write to the analyzed repos (the assembler enforces this via a hash; a check
  that writes ⇒ flagged). Reversible-first; no deploys/outward calls.
- **Verify by execution** where possible; label the rest analytical. Independence: don't let one agent
  both assert and confirm the same requirement.
- **Bounded fan-out**: batch large requirement sets; don't spawn an unbounded swarm. Cost is real —
  record it with `${CLAUDE_PLUGIN_ROOT}/scripts/run-ledger.mjs` if driven under `/develop`.
- Anchor every verdict to evidence (file:symbol) — no verdict without a locus.
