# Spec — `/init-workspace` (v1, design only)

Status: M1 BUILT, WIP (quality-kernel 0.8.0: discover, profile, propose, verify with human approval;
open gaps G1–G4 in the plugin CHANGELOG — paused 2026-10-01 to move on to M2);
M2 (integration map) and M3 (seams) are design only. Author: Claude with Adrián, 2026-09-29.
Decisions (Adrián, 2026-09-29): lives in quality-kernel as the init step every other command builds
on; `SYSTEM-MAP.md` is committed; a repo that cannot be tested locally gets a proposal to dockerize
its local environment (§4.1a).
Depends on: quality-kernel 0.7.0 workspace mode (`workspace.json` v1, `repos/<name>/*.json`,
`qk-org-gate.mjs`). Seam checking itself is a separate piece of work (see §8).

## 1. Problem

Workspace mode needs a correct `workspace.json`, a gate config per repo, and the list of contracts
between repos ("seams"). Today these are written by hand after ad-hoc searching. That does not scale
past a few repos, misses integrations nobody remembers, and goes stale (the hand-written
`.claude/issue-flow-context.md` already points at `/Users/admin/...`).

## 2. Goal

One command that **analyses the repos of an org folder and their integrations, and proposes** the
workspace: which repos form the system, how each one is tested, what makes a change critical, who
calls whom, and which of those connections are worth guarding as seams. A human reviews and approves;
nothing becomes trusted automatically.

Non-goals: building seam checks (§8), changing any product repo, running anything against live
services, deciding product priorities.

**Place in quality-kernel.** `/init-workspace` is the init step of the plugin: the workspace it
produces is what the other commands consume when they work across repos — `/gate` and `qk-org-gate`
(gate config and seams), `/forge` and `/develop` (which repos a feature touches, their base branches,
test commands and harnesses, taken from the workspace instead of re-discovered), and
`requirements-gap` / `requirements-coverage` (the repo map and `SYSTEM-MAP.md` as the starting point
for Stage B). Commands keep working without a workspace (single-repo), as today.

## 3. Invocation and scope

```
/init-workspace [--org <dir>] [--repos a,b,c] [--exclude x,y] [--update]
```

- `--org` — the org folder (default: the parent of the current repo, or the cwd if it is not a repo).
- **Scope is explicit.** The tool first lists candidate repos (names only, see §4 phase 0) and the
  user confirms the selection. `--repos` skips that question: only the listed repos are opened; every
  other directory in the org folder is never read — not even its files' names beyond the top level.
- `--exclude` removes candidates from the proposed selection.
- A selected repo that calls something outside the selection (e.g. client-v2 calls aws-services
  while aws-services is not selected) is reported as an **out-of-scope target** by name and URL/env
  var only; the target is not opened.
- `--update` — re-run against an existing workspace and show what changed (§6).

Recommendation for Matchbox: pass an explicit `--repos`. The folder holds copies
(`mbvs-server-v2 (Copy)`), worktrees (`wt-v3-upgrade`), other projects, QA-team repos that must not be
touched, and loose credential files.

## 4. Phases

| # | Phase | Done by | Output |
|---|---|---|---|
| 0 | Discover | script | `inventory.json`: candidate repos + classification |
| 1 | Profile each repo | script + one agent per repo (parallel) | `profiles/<name>.json` |
| 2 | Map integrations | script extraction + one integrator agent | `integrations.json` |
| 3 | Verify proposals | script (re-execution) | each proposal marked verified / unverified |
| 4 | Propose | script | a branch in the workspace repo + a report |

### Phase 0 — Discover (deterministic, reads no file contents)
- Top-level dirs of `--org` that are git repos (the dir is the work-tree top level).
- Classification signals, all cheap: worktree (`.git` is a file, or listed by another repo's
  `git worktree list`); copy (same `origin` URL as another candidate, or `(Copy)` in the name);
  harness (name `*-qa`, `*-qa-local`, a Playwright/Cypress config, specs that point at another
  repo's URL); remote org; default branch and existence of `development` / `dev` / `staging` / `main`.
- Existing rules: if an org-level `CLAUDE.md` exists in `--org`, the agent may read that one file to
  learn forbidden repos (e.g. "never write to `*-qa`"). No other org-root file is read.
- Output: the candidate list with a suggested selection, shown to the user for confirmation.

### Phase 1 — Profile (per repo, parallel, read-only)
Deterministic first (`profile.mjs`): stack from manifests (`package.json`, `pyproject.toml`,
`manage.py`, `serverless.*`, `next.config.*`, `Dockerfile`, `docker-compose*.yml`), test scripts
declared in the manifest, test file conventions, the base branch, CI files.

Then one **repo-profiler** agent per repo (read-only tools) fills in what needs judgment, each item
with file:line evidence:
- `role` (`app` / `harness` / `library` / `docs`) and, for harnesses, which app they test;
- the **verify command** and the `productionGlobs` / `testGlobs` for `tools.json`;
- critical surface: auth/session, payments, tenancy, migrations, infra, cross-repo contracts;
- how tests really run (e.g. server-v2 only inside Docker) and whether that can run locally.

### Phase 1a — Local test environment
The gate needs each repo's tests to run on this machine. For each repo the profile records one of:

| State | Meaning | What the proposal does |
|---|---|---|
| `native` | tests run with the repo's own tooling (e.g. client-v2 Jest, admin-tools node scripts) | `tools.json` uses that command |
| `docker-existing` | the repo already ships a local Docker path (e.g. server-v2 `docker-compose.local.yml` / `docker-compose.test.yml` + `make test-all`) | `tools.json` uses it; phase 3 checks that Docker is available |
| `needs-local-env` | tests need services (DB, queue, cache, cloud emulators) and there is no local way to start them | **propose dockerizing the local environment** (below); the gate config is marked `unverified` and the gate stays indeterminate for that repo until it is adopted |
| `no-tests` | no runnable test suite found | reported as a gap; no gate config |

Dockerization proposal (for `needs-local-env`), written to the workspace proposal branch as
`repos/<name>/local-env/` — never into the product repo:
- a draft `docker-compose.test.yml` (+ `Dockerfile` if missing) that starts only what the tests need
  (e.g. Postgres with the schema the tests expect, LocalStack/DynamoDB-local for AWS services), with
  no secrets: config comes from a `.env.example`-style list of variable NAMES;
- the test command that uses it (for `tools.json`), and a `README.md` with why each service is needed
  (evidence: file:line of the test setup that requires it) and how to adopt it;
- adoption into the product repo is a normal reviewed PR by a human; once merged, `--update` switches
  the repo to `docker-existing` and phase 3 verifies it.
The proposal is checked in phase 3 by actually starting it and running the suite once (`verified`
only if that passes).

### Phase 2 — Integrations (deterministic extraction + one integrator agent)
`extract-integrations.mjs` collects signals per repo, each with file:line:
- **outbound**: env vars naming another service (`*_API_URL`, `*_HOST`, `REACT_APP_*`,
  `NEXT_PUBLIC_*`, `domain_url`…), HTTP client calls with literal paths, websocket URLs,
  queue/webhook targets;
- **inbound**: routes the repo serves (Django `urls.py`, serverless handlers, Next.js `pages/api`,
  Express routers);
- **shapes**: payload builders and consumers (DRF serializers and their field lists, TS types, object
  literals sent in requests, fields read from responses);
- **contract docs**: `CONTRACT*.md`, OpenAPI files, wiki references.

The **integration-mapper** agent matches outbound calls to inbound routes across the selected repos
and produces edges: `{ from, to, kind: http|ws|webhook|queue|shared-db|doc, endpoint, evidence
{from: file:line, to: file:line}, confidence }`. For each edge it says whether a **supported seam
type** (§8) can guard it; others are listed as "observed, not guarded". Unmatched outbound calls
(the target is not selected, or no route was found) are listed, never guessed.

### Phase 3 — Verify (deterministic, fail-closed labels)
- Each proposed `tools.json`: run once through `qk-gate` on the repo's current base (temp tree, as
  the referee does). Result: `verified` (the suite ran and passed), `runs-but-fails`,
  `cannot-run-here` (e.g. needs Docker), with the output.
- Each proposed seam: evaluated once on the current bases. It must PASS on today's code (if it fails,
  that is reported as an **existing break**, which is a finding, not a proposal), and its extractor
  must find a non-empty field or route set (an empty extraction is `unverified`).
- Nothing is labelled verified from reading alone.

### Phase 4 — Propose (never auto-trusted)
- Write the proposal to a new branch of the workspace repo, `init/<yyyy-mm-dd>`, never to `main`:
  `workspace.json`, `repos/<name>/{tools,critical-surface}.json`, `seams/<id>.json`,
  `SYSTEM-MAP.md` (a readable map: repos, roles, edges, contracts, gaps) + `system-map.json`.
- Print a short report: repos and roles, which gate configs are verified, integrations found, seams
  proposed, existing breaks, out-of-scope targets, open questions.
- The human reviews the branch and merges it into `main` locally. The workspace is the trust root of
  every gate, so the tool never merges.

## 5. Agents

| Agent | Count | Tools | Model | Job |
|---|---|---|---|---|
| repo-profiler | one per selected repo, in parallel | Read, Grep, Glob, read-only Bash | default (Sonnet) | phase 1 judgment, with evidence |
| integration-mapper | one | Read, Grep, Glob | high tier (pinned) | phase 2 cross-repo matching |

- Every spawn carries the epistemic preamble; claims are OBSERVED (file:line) or INFERRED.
- Time box per agent (45 min) and one retry; a profiler that times out leaves its repo `unverified`.
- The orchestration is the command itself (root session), following the `requirements-coverage`
  pattern: deterministic scripts for the glue, agents only for judgment.

## 6. `--update` (keeping it fresh)
Re-runs phases 0–3 for the selected repos against the workspace `main` and proposes a diff branch:
new or removed repos, changed test commands or base branches, new integrations, seams whose fields or
routes no longer exist, drift between `SYSTEM-MAP.md` and the code. Intended to run when a repo or an
integration is added, or on a schedule.

## 7. Safety

- Opens only the selected repos (plus the one org `CLAUDE.md`). Never reads `.env*` files, key
  material (`*.pem`, `*credentials*`, `*accessKeys*`, `*recovery-codes*`), or anything outside the
  selection; env var **names** come from source code, never values.
- Never writes to a product repo. Writes only the proposal branch of the workspace repo.
- Forbidden repos (from the org `CLAUDE.md` or `--exclude`) are listed by name and never opened.
- Phase 3 runs the repos' own test commands, so it inherits the execution-trust limit documented in
  0.7.0; it runs in the referee's temp trees and reports what it ran.

## 8. Seam types (what can be proposed)

`/init-workspace` only proposes seams of a type the gate can check. Seam checking is a separate
piece of work; v1 of it would support:

| Type | Provider side | Consumer side | Example (Matchbox) |
|---|---|---|---|
| `fields` | field list extracted from code (DRF serializer `Meta.fields`, declared serializer fields) | fields read (`obj.x` / `obj?.x`) or keys sent (object literal) | server-v2 `PublicEventSerializer` → client-v2 `event.landing_*`; admin-tools `buildPointerPayload` → server-v2 `LandingPointerSerializer` |
| `route-exists` | routes the provider serves | paths the consumer calls | aws-services handlers ← `/email-stats`, `/meeting` from admin-tools and server-v2 |

Payload schemas (JSON Schema / contract tests), e.g. the SendGrid webhook's `unique_args`, are a
later seam type.

## 9. Build order

1. **M1**: discover + profile + propose `workspace.json` and `repos/*/tools.json` (verified by
   re-execution). Directly replaces the hand work done for client-v2.
2. **M2**: integration map, report only (`SYSTEM-MAP.md`, `integrations.json`), with no seams yet.
   This is already valuable on its own and shows which seams matter.
3. **M3**: seam proposals, once the seam checker (§8) exists.

## 10. Decisions

1. **Lives inside quality-kernel** — it is the init step for all its commands and skills (§2).
2. **`SYSTEM-MAP.md` is committed** in the workspace repo; it is part of what the human approves, and
   its history shows how the system changed.
3. **A repo that cannot be tested locally gets a proposal to dockerize its local environment**
   (§4 phase 1a); until adopted, its gate config is `unverified` and the gate is indeterminate for it.

Observed starting point (2026-09-29, `git ls-tree` of each base branch): server-v2 ships
`docker-compose.local.yml`, `docker-compose.test.yml` and a `Makefile` with `test-all` /
`test-exec*` targets (`docker-existing`); client-v2 ships `Dockerfile`, `Dockerfile.dev`,
`docker-compose.yml` and runs Jest natively; admin-tools has no Docker files; aws-services has only
`docker-compose.stress.yml`. Docker 28.5.2 is available locally.
