# Changelog

All notable changes to the **quality-kernel** plugin are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.12.0] - 2026-10-28

### Added
- **`designer` agent** (opus), between the specifier and the human intention gate in `/forge`
  for T1 and T2 (T0 skips it). Given the ticket text (fetched with `gh` when an issue is
  referenced) and the contract, it writes `design.md` beside the contract: where the contract
  contradicts or goes beyond the ticket's "Done when" and business reason, or carries a rule
  from elsewhere; 2–3 implementation options, always including the simplest one that meets the
  ticket, each with effort, risk and what it leaves out; and one recommendation. No code. The
  intention gate now shows contract + review + `design.md` together, and the human approves the
  contract and picks the option in that single stop. The chosen option is a constraint for the
  coder and the reference design for the architect. Motivated by a real run where the contract
  kept a rule from an older design that contradicted the ticket's business need, and the coder
  picked a complex design on its own because nobody chose the "how" before coding.
  Live-checked blind (isolated tool-less `claude -p`, opus, ticket title + body only, no comments)
  on that case: the first prompt listed the "never switchable" rule only as an unstated but
  plausible criterion and kept it in the simplest option; with the added rule (test every
  exemption against the ticket's business reason) it flagged it as a contradiction to resolve
  before approval and named emergency detection and the alarm as the blocked items.
- `/develop` keeps one approval: in Phase 1 it runs the designer for the system (architecture,
  stack, subproject split) and for every feature whose design the system one leaves open, and the
  Phase 2 gate shows all options together for the human to pick. After approval every feature is
  settled and develop calls `/forge --design-settled <design file>`. Forge stops for a design
  choice only on a new decision the plan could not have foreseen (rare); develop tells the human
  which decision and why.

## [0.11.1] - 2026-10-27

### Fixed — commit proof
- `proof.mjs` no longer fails in every repo the gate has run in: the referee's verdict rows
  (`source: "referee"`, no `command`) were counted as unreadable ledger lines, which fail closed.
  They are now skipped. A row with a command is still read as a command row, whatever its source.
- `hooks/evidence-gate.py` writes the ledger at the git top level of where the command ran (its
  leading `cd <dir> &&` target, else the session cwd), not in the session cwd. Runs made from an org
  folder above the repo landed in the org folder, where `proof.mjs --repo <repo>` never looked.
- `python -m unittest` and `tofu test` / `terraform test` are recorded as verification runs.

### Added
- `"runOnPush": true` in an org `tools.json` makes `pre-push-review` (1.4.0) run `qk-gate.mjs` on
  every pushed range before the panel, and block the push when the gate fails or cannot run.
  On push the memory guard's threshold defaults to pressure level 3 (`QK_MEM_MAX_PRESSURE_LEVEL`
  overrides it); a refusal still blocks.

## [0.11.0] - 2026-10-26

Merges the `main` line into the workspace line. Both lines had released a "0.6.0" since they
diverged on 2026-10-08; this entry carries `main`'s 0.6.0 (2026-10-26) notes. The workspace line's
0.6.0-0.10.0 entries below are unchanged.

### Changed — timeout ceiling
- `timeoutSeconds` accepts integers 1-14400 (was 1-3600); contract PT-B2/PT-B3, INV-PT-9 and the
  QA probe amended. A Django suite of about 70 minutes, run twice per gate (trusted + head), did not
  fit in one hour, so long suites could not be gated at all. Invalid values are still indeterminate,
  never clamped.

### Changed — merge reconciliation
- The referee keeps the workspace line's committed-bytes materialization (raw blobs, re-hashed) and
  org-mode contract loading, and adopts `main`'s process-tree session: temp trees come from
  `session.tempTree()` and every command runs through `session.run` (own process group, per-command
  `timeoutSeconds` from `tools.json`, streamed output with no buffer cap). The 300 s hard-coded
  verify timeout and the 1 MB `spawnSync` output cap of the workspace line are gone.
- `--canary` now awaits the asynchronous runner (the merge would otherwise have compared a Promise
  with 0 and reported every canary as proven).
- `scripts/entrypoint.mjs` is removed: `route.mjs` and `qk-org-gate.mjs` use `main`'s
  `scripts/is-main.mjs`, which fixed the same symlinked-entrypoint bug and has its own tests.

### Changed — org guide schema version (contract: docs/contracts/org-guide-v1.md, OG-8/OG-9)
- `readOrgManifest` now grandfathers a `guide.json` with no `"version"` field in as version 1 (the
  real, pre-existing Matchbox `guide.json` has none, so the org gate keeps working with zero manual
  migration), printing a one-line warning to stderr that names the command (`/org-learn --apply` or
  `org-guide.mjs --apply`) that stamps the version in. An explicit, unsupported `version` (anything
  other than `1`) now fails closed with a named error instead of a silent partial read; `findOrg`
  surfaces that error in place of the generic "no usable org guide" message.
- `orgPin` needed no change: it was already a pure content hash of `guide.json`'s bytes (plus
  `.quality-kernel/repos/`), so it changes correctly the moment a version/hash stamp changes those
  bytes — a regression test now locks this in.


### Changed
- **The blind breaker no longer has a shell.** `scripts/breaker-claude.mjs` now runs in two stages:
  a tool-less, context-free `claude -p --tools ""` session writes falsifying vectors (bundled prompt
  `breaker/vector-author.md`, which replaces the bundled `breaker/pipeline-breaker.md`), and the new
  `scripts/vector-breaker.mjs` executes them through deterministic instruments and computes the
  verdict in code; the model's prose verdict is ignored. Closes the residual of the previous launcher,
  whose Bash could read the disk and the environment. Live-checked: asked to `cat` a file, the author
  has no tool to do it.

### Added
- `scripts/contract-review.mjs` + `reviewers/comprehension.md`, `reviewers/critic.md`: blind review
  of a specifier contract before the intention gate (Elephant-Goldfish Model's zero-context
  reviewers). Each reviewer is a separate isolated, tool-less session that sees only the contract;
  replies must be strict JSON findings (`blocker`/`major`/`nit`), and an off-format reply is
  indeterminate (exit 2), never "no findings". `/forge` runs it before the intention gate (T1+).
  Live-checked on sonnet: on a contract with four planted flaws (a vague criterion, an invariant
  without a probe, no payment-failure `IF … THEN`, no re-run invariant for a charge) all four came
  back as blockers; on `docs/specs/gate-process-tree/contract.md` its single blocker was a real
  contradiction, fixed below.
- `scripts/http-probe.mjs`: declarative HTTP instrument for breaker vectors — allowlisted methods,
  paths resolved and required to stay on the system's origin (`//host` and `/\host` are refused),
  redirects never followed, per-request timeout, `expect` on the last response (`status`, RFC 6901
  JSON-pointer `equals`). Non-local systems are refused.
- `scripts/vector-breaker.mjs`: validates a vector set (anchored to contract invariants, no unknown
  keys, at most 30; UI steps limited to same-origin `goto` and `click`, asserts to `text`/`is`/`attrs`),
  runs HTTP vectors through `http-probe.mjs` and UI vectors through the gstack probe, then the
  contract's `probeCmd` (exit 0 holds, 126/127/timeout/signal is instrument-broken), and applies
  `decideVerdict`.
- `scripts/dry-gate.mjs`: pass/fail gate over a jscpd JSON report — differential (`--files`) or
  whole-report, optional `--max-percent`; an unrecognized report is exit 2, never a pass. The
  cleaner, hardener and qa now gate duplication with it.
- `scripts/proof.mjs`: turns the evidence-ledger events since a ref (default `HEAD`) into
  `Proof:` / `Unverified:` / `Unproven:` commit trailers; exit 1 when nothing was proved or any
  command's latest run failed or has no exit code. Only an allowlisted command (plain words, quoted
  strings, simple redirects, `&&` chains) can be `Proof`; any other exit 0 — behind `|`, `;`, `||`
  or `&`, with `$`, backticks, subshells or heredocs, or truncated by the hook — is `Unverified`.
  Commands print escaped on one line so ledger text cannot forge a trailer, and a test pins
  `LEDGER_COMMAND_MAX` to the hook's `_MAX_COMMAND`. qa and `/forge` put its trailers in every commit.
- Principles adopted from Uncle Bob's `ub-mode` (2026-10-25), each placed in the stage that owns it:
  coder — *attack the premise* after two failed fixes on one premise, plus design rules (smallest
  edit, data shape first, redesign instead of bolt-on, parse at the boundary, never silence the
  compiler, fix the cause); architect — a domain-model phase (illegal states unrepresentable,
  boundary discipline, idempotency, single writer for shared state, glossary); cleaner —
  *subtract before you add* and pin → change → prove; hardener — idempotency tests and delete
  unreachable survivors instead of testing them; specifier — re-run invariants and a glossary;
  `/forge` — a Practice section (action log, context-window guard, verifiable units, small
  commits with proof, worktree cleanup).
- `.githooks/pre-push` (source repository): local pre-push gate. When a push touches
  `plugins/quality-kernel/` or `.githooks/`, it runs the Node and hook suites and the gate's own tests
  (`.githooks/quality-kernel-tests.test.mjs`) on the pushed commit in a temporary
  worktree and blocks the push on any failure; there is deliberately no CI job for these suites.
  Enable once per clone with `git config core.hooksPath .githooks`. The suites run without
  `NODE_TEST_CONTEXT`: inherited from a parent `node --test`, it makes the child runner exit 0 on
  failing tests.
- `scripts/breaker-claude.mjs`: isolated launcher for the blind breaker, the production `--breaker`
  command for `breaker-invoke.mjs`: `claude -p --safe-mode --restricted` in a fresh empty temp dir
  with an allowlisted env (cloud credentials only for the active provider), no MCP and no session
  persistence; prepends the epistemic-guard preamble (hooks do not run in safe mode; a test keeps
  the text equal); refuses blind input with extra keys. Opt-in live probe (`QK_CLAUDE_LIVE=1`) with a
  positive control: a CLAUDE.md marker that a plain `claude -p` returns is not visible to it. Idea from
  Google's Elephant-Goldfish Model (tool-restricted, context-free reviewers with a marker leak probe).
- `scripts/manifest-consistency.test.mjs`: static check that plugin.json, marketplace.json, the
  README status lines and the newest CHANGELOG entry share one version, and that each agent
  declares its expected model alias (never a literal ID).
- `scripts/hermetic-git.test.mjs`: proves the hermetic env defeats a hostile global excludesfile
  and XDG ignore (with a control that shows the hostile config does ignore the file).

## [0.10.0] - 2026-10-01

### Removed — `/init-workspace` moved out
- Org orientation (discover, profile, integration signals, the map, SYSTEM-MAP.md) moved to the new
  **org-workspace** plugin, which writes a short guide block into the org-root `CLAUDE.md` instead
  of a workspace repo. Removed here: `commands/init-workspace.md`, skill `init-workspace`,
  `scripts/ws-{discover,profile,integrations,map,propose,verify,command}.mjs` and their tests.
- The automatic gate-config generator (M1: ws-propose / ws-verify / ws-command) is retired — it
  failed its adversarial gate five times and is not worth its risk for a handful of repos; write
  `tools.json` by hand. Its history stays in git (commits de74879a, 671ac559, 5d39245e).
- Kept: the referee's opt-in RED canary (`--canary`, `scripts/canary.mjs`).

### Changed — workspace mode becomes org mode (no workspace repo)
- `--workspace <repo> [--workspace-ref]` is replaced by `--org <dir>`: the repos of the system come
  from the org guide that org-workspace writes (`<org>/.claude/org-workspace/guide.json`), and each
  app's gate config lives in `<org>/.quality-kernel/repos/<name>/{tools,critical-surface}.json`,
  outside every product repo (`scripts/org.mjs` replaces `workspace.mjs`).
- The config is pinned by content (`orgPin`, sha256 of the guide and every config file): qk-gate
  pins once and passes `--org-pin` to route and referee (each refuses a mismatch; a caller-supplied
  pin is ignored), and re-checks after the run. `qk-org-gate --org <dir> --branch <name>` plans,
  runs and re-checks every listed app; harness entries are not gated.
- Symlinks anywhere in the org config are refused; a listed repo must be a plain repo directly
  under the org folder with its own `.git` (`orgRepoDir`).
- "Working as one system": `/forge` and `/develop` read the org guide and the `SYSTEM-MAP.md`
  sections of the repos they touch; cross-repo consumers become acceptance criteria (specifier) and
  QA closes with `qk-org-gate`.
- Not yet reviewed adversarially (committed at Adrian's request to move on): the org-mode trust
  change (git-pinned config -> content-pinned files outside the repos). Real run: mbvs-client-v2
  gate pass in org mode with the RED canary red (26 test files sabotaged), 2026-10-01.

## [0.9.0] - 2026-10-01

### Added — `/init-workspace` M2: the integration map (report only)

- **`scripts/ws-integrations.mjs`** — integration signals of one repo from its committed base
  (`git grep` / `ls-tree` on the base commit; never the worktree, `.env*` or key files; vendored,
  build and test paths skipped): inbound routes (Django `path()`/`re_path()`/`include()`, serverless
  `path:` — only in a Serverless Framework repo —, Next.js `pages/api` / `app/api`, Express), outbound
  HTTP calls with a literal/template path (a Python `.get(` must be an HTTP client, not a dict) and
  URLs composed from a service base before the call, service env NAMES, contract docs; commented-out
  lines skipped; `git grep -z` so a path containing `:<n>:` cannot shift the parse. Each signal has
  `at: "path:line"`; cited lines are cut to 240 characters and redacted best effort (quoted values
  next to key/token/secret/auth names, Bearer tokens, high-entropy literals).
- **`scripts/ws-map.mjs`** — validates the integration-mapper agent's `{ edges, unmatched }`: repos
  must be selected and different, fixed `kind` / `confidence` / `guardable` lists, single-line
  secret-free strings (also quoted secrets the source redaction would hide), no `file:line` text in
  free text, no duplicate edges, and **every `path:line` must be a non-blank line of a committed,
  non-sensitive file of the repo it belongs to** (caller side in `from`, provider side in `to`) —
  otherwise the whole map is rejected. Each side is labelled `matches` (✓, the line contains an
  endpoint token) or `exists` (~): existence is not relevance, and the report says so. Renders
  `SYSTEM-MAP.md` from the data (code-point order, agent text as plain text, collision-free mermaid
  ids).
- Known limits (review round 1, recorded, not fixed): `guardable` is the agent's claim (not checked
  against its rule — matters at M3); ASCII-only citation paths; the extractor misses calls made
  through a base-class helper (`this.get(url)`) — the mapper finds them by reading.
- `ws-propose --integrations <file>` writes `integrations.json` + `SYSTEM-MAP.md` to the proposal
  branch; without it nothing changes. Skill step 3.5 (the integration-mapper prompt).
- Still WIP as a whole: the M1 open gaps below (G1–G5) are unchanged.

## [0.8.0] - 2026-09-29

### Added — `/init-workspace` (M1: discover → profile → propose → verify)

> **Status: WORK IN PROGRESS — not ready to use or install.** M1 failed its adversarial review gate
> five times (last: 2026-10-01, round 5, score 62). Paused by decision: committed as WIP, work moves
> on to M2. What round 4–5 changed (each RED-first, 407 tests green):
> - **RED canary** (`scripts/canary.mjs`, referee `--canary`, always on in ws-verify): after a green
>   run the command is re-run on head with every JS/TS/Python test file raising on load; it must exit
>   non-zero, else `not-proven` (also: no test file to sabotage, or the chain rewrote the sabotaged
>   files). Structured `canary.proven`. Opt-in in the referee: `/gate` and `qk-org-gate` unchanged.
> - Agent-chosen `env` fixed to `CI=true|1`, `NODE_ENV=test`, `TZ=UTC`; anything else a suite needs is
>   added by a human (profile fact `envRefs` only informs that note).
> - npx `bin` must be the command position of a declared test script (wrappers/builtins refused);
>   emitted as `npx --no -- <bin> ...`.
> - Entries must be plain repos under the org folder with their own `.git` (`orgRepoDir`: no
>   symlink, gitfile, symlinked `.git`, linked worktree, alternates).
> - Real org (2026-09-30): client-v2 and admin-tools `verified` (27 / 112 test files sabotaged,
>   canary exit 1); aws-services `runs-but-fails` (a real 2000 ms mocha timeout in associate.test.ts).
>
> **Open gaps (why it is not ready):**
> - **G1 (blocking):** the canary only checks exit != 0. A lint/typecheck command that a declared
>   test script runs (`npx --no -- eslint`, `npm run pretest` = `tsc --noEmit`, `test:lint`) parses the
>   sabotaged files, fails, and is labelled `verified` with zero tests run (reproduced by the critic).
>   Planned fix: a runtime nonce — the sabotage throws a string built at run time and the canary is
>   proven only if that string appears in the output; also refuse lint/typecheck heads and pre/post
>   hook scripts in ws-command.
> - **G2:** `CI=true` (agent-allowed) can select skips (`skip: !!process.env.CI`) invisible to the canary.
> - **G3:** a real `.git` whose `objects/` / `refs/` are symlinks into another repo is accepted by
>   `orgRepoDir`; a byte copy of a forbidden repo under a new name cannot be detected by any path check.
> - **G4:** ws-verify labels `verified` when the canary is absent (should require `canary.proven === true`);
>   INIT-REPORT.md does not show the verify command and its script body for gated repos (the human
>   sees them only if the agent shows them at approval); a flaky exit != 0 counts as "proven".
> - **G5 (test gaps, QA round 5):** the `--git-common-dir` pin in `orgRepoDir` (a `.git/commondir`
>   redirect) works but has no test — deleting it leaves the suite green; no test makes
>   `canary.proven` disagree with the reason text; restore detection is tested with one file only.
> - Older, still open: npx cache fallback without node_modules, compose service vs file, quadratic
>   `redact()`, DB_PWD-style redaction misses, `validate()` keeps unknown keys, `commandHeads` quoting.
- **`commands/init-workspace.md` + skill `init-workspace`** — the init step for multi-repo work: the
  workspace it proposes is what `/gate --workspace`, `qk-org-gate`, `/forge` and `/develop` use.
- **`scripts/ws-discover.mjs`** — lists and classifies the org folder's repos (repo / worktree /
  copy / not-git / workspace, harness hints, base-branch candidates, forbidden from an existing
  workspace or `--forbid`) from git metadata only. Plain files and hidden dirs are not listed; remote
  URLs have credentials stripped; with `--repos`, other dirs are reported by name and never opened.
- **`scripts/ws-profile.mjs`** — deterministic facts for one repo from its committed base branch
  (hash-verified reads): stack, manifests, test scripts, test conventions, CI, Docker files, and a
  local-env hint (native / docker-existing / needs-local-env / no-tests). `.env*` and key files are
  reported by name (`sensitiveFilesCommitted`) and never read.
- **`scripts/ws-propose.mjs`** — validates the profiler agents' JSON (roles, branch names,
  degenerate / absolute / `..` globs, glob syntax the gate does not support such as `{a,b}`, local-env
  file names, secret-looking values) and writes the proposal to a new `init/<date>[-n]` branch of the
  workspace repo through a temporary worktree: `workspace.json` (merged with main's), per-repo
  `tools.json` / `critical-surface.json`, `local-env/` dockerization proposals, `INIT-REPORT.md`.
  main and the workspace worktree are never touched; the workspace repo is created if absent.
- **`scripts/ws-verify.mjs`** — re-executes every proposed gate config through `qk-gate` (base..base,
  pinned to the proposal commit) and commits the labels to the branch.
- Hardening from the review of the first draft (each fix RED-first):
  - discovery builds the deny list (option + an existing workspace's main) BEFORE opening anything:
    forbidden / excluded dirs are listed by name and never opened (checked with an instrumented git);
    an existing workspace whose manifest is unusable stops the run; listed names must match the dir
    entry exactly and symlinks are refused; remote credentials are stripped by URL parsing (userinfo,
    query, fragment, scp `user:pw@host:`);
  - profile: must be the top level of its repo; broader sensitive-name list; secret-looking values in
    npm test scripts are redacted;
  - propose: refuses a workspace dir that is not a repo of its own (it would have written into a
    parent repo), an unusable existing manifest, forbidden repos, multi-line / control-char evidence,
    secret-looking values in any string (AWS secret / ASIA / JWT / URL userinfo / github_pat_ /
    sk_live_ / password literals), `./` globs, and any gated `verify` not backed by the profile facts
    or chaining commands; writes are contained in the worktree; the branch is cut from main; main's
    extra `tools.json` keys and `$comment` are kept; the report is rendered from `init-report.json`;
  - verify: requires `--approved <proposal sha>` (the skill's human confirmation step) and an
    unchanged config; runs with the new referee flag `--no-ledger`; Docker unavailable →
    `cannot-run-here`; re-runs re-render the report; labels carry the config tree id.
- Final review round (the free-text `verify` could still be steered with env / CLI options):
  `verify` is now a STRUCTURED spec (`npm-script` / `npx` / `make` / `compose`) that
  **`scripts/ws-command.mjs`** builds into the command from the repo's declared facts only — env names
  with a deny list and plain values, `npx --no` (never installs), args from a fixed flag list, compose
  limited to `-f <committed file> run --rm <service>`; `ws-propose` re-profiles every repo itself and
  takes the committed sensitive files from that; every string reaching the report is sanitized;
  password literals are benign only as an exact whole value; SendGrid / Stripe rk/pk / Slack webhook /
  Google / npm / PEM-body patterns; discover refuses a workspace that is not its own repo or has no
  main; forbidden names are dropped from `repos` and labelled `forbidden` by verify; profiles redact
  URL userinfo and `--password` values. `--approved` is documented as PROSE-ONLY-ACCEPTED.
- `referee.mjs --no-ledger`: skip the audit ledger (used by /init-workspace verification).
- Tests: `ws-command` (10), `ws-discover` (20), `ws-profile` (17), `ws-propose` (21), `ws-verify` (18), RED first.
- First real run (Matchbox, 4 apps + 4 harnesses): client-v2 and admin-tools verified; aws-services
  `runs-but-fails` — reproduced as a flaky test (mocha's 2 s default timeout on an `associate.sh`
  spawn; 2 of 3 runs fail on the same commit); server-v2 `needs-local-env` with a hermetic
  `docker-compose.gate.yml` proposal (its committed Docker paths need a gitignored `.env.local`).

## [0.7.0] - 2026-09-29

### Added — workspace mode (several repos, one org folder), explicit and opt-in
- **`--workspace <dir>` on `route.mjs`, `referee.mjs` and `qk-gate.mjs`.** An org folder holds its
  repos side by side plus a control repo (by convention `workspace`) whose committed
  `workspace.json` (version 1) lists them. With the flag, a listed repo's `tools.json` /
  `critical-surface.json` come from `<workspace>/repos/<name>/` and **win over the repo's own**;
  the repo's own base file is used only when the workspace has none. Without the flag nothing
  changes: there is no sibling auto-discovery, so a repo without a contract stays indeterminate.
- **An explicit workspace fails closed.** Not a repo of its own, the product repo itself, a
  manifest missing / only in the worktree / an unsupported version, a repo that is not listed, is
  `forbidden`, or is not `role: "app"` → indeterminate (exit 2) with the reason, never a silent
  fallback to the repo's own config — including a `--workspace` given with an empty or missing
  value (e.g. `--workspace "$UNSET"`). The fallback to the repo's own file is per file.
- **The workspace commit is pinned.** `--workspace-ref` (default `main`) is resolved once to a
  commit SHA — a branch as `origin/<ref>` and/or `refs/heads/<ref>` (when both exist they must be
  the same commit, else refused), or a full commit SHA; tags cannot shadow it, and revision syntax,
  abbreviated SHAs, `HEAD`, tree/blob ids and option-like values are refused. `qk-gate` resolves it
  once, hands the SHA to both route and referee (run them through qk-gate), reports
  `workspace: { dir, ref, sha }`, and re-checks after the run that the ref did not move (moved →
  indeterminate). Files are read at that SHA (never from the worktree) and hash-verified. The source
  (`{ source, workspace, ref, sha }` or `{ source: 'repo', ref }`) is reported in
  `route.configSource`, `referee.evidence.toolsSource` and the evidence ledger (`tools_source`).
- **Config blobs are hash-verified.** git does not verify objects on read, so a loose object
  rewritten in place keeps its id. Every gate config read — the workspace manifest,
  `repos/<name>/*.json`, and a repo's own `.quality-kernel/{tools,critical-surface}.json` — is now
  re-hashed against its id (`readVerifiedBlob` in `safe-git.mjs`). Altered blob bytes, a corrupt
  tree on the path, or a non-regular-file entry (symlink, directory, submodule) fail closed
  (indeterminate), never read as "absent" — "absent" requires the trees to read cleanly with no
  such entry, so there is no silent fallback. The referee already did this for the product trees.
  Commit and tree objects themselves are still trusted (see Trust model).
- **`scripts/qk-org-gate.mjs --workspace <dir> --branch <name> [--workspace-ref <ref>]`** gates one
  feature across the workspace: every listed app repo that has the branch runs `qk-gate` against
  `merge-base(<declared base>, <branch>)` (`origin/<base>` preferred over the local branch) and the
  pinned workspace commit. It works in three phases — every repo's head, base, merge-base and skip
  decision is resolved BEFORE any gate runs, each repo is gated at those pinned commits, and every
  pinned ref plus the workspace ref is re-checked after (moved → indeterminate) — so code executed
  while gating one repo cannot drop another repo from the feature. Exit precedence 1 > 2 > 3 > 0.
  Fail-closed (exit 2, never skipped): a listed repo that is not cloned or not a git repo, a repo
  symlinked from outside the org folder, a forbidden / invalid-name / non-app entry, a missing or
  malformed base, a feature branch only on origin or different from origin, no merge-base, a
  qk-gate crash; nothing gated at all = 2. `--branch` and manifest bases must be plain branch names;
  a present-but-malformed `forbidden` makes the manifest unusable. An app gated without its harness
  on the same branch gets a non-blocking note. Each repo reports `configRef` / `configSha`, and a
  workspace-sourced result whose `configSha` is not the pinned commit is not trusted (exit 2).
- Tests: `scripts/workspace.test.mjs` (33), `scripts/workspace-gate.test.mjs` (31),
  `scripts/org-gate.test.mjs` (49). Written RED-first; the attack tests (sibling workspace without
  the flag, tag shadowing, `--workspace-ref` injection, a repo dropping another from the feature,
  code moving the workspace ref, empty `--workspace`, a forged config blob) were also run against
  earlier drafts of this release and fail there. Four independent review rounds (adversarial critic
  + mutation testing) drove the hardening. Proven on a real repo
  (mbvs-client-v2, 537 Jest tests): a benign change passes (exit 0), a change that breaks covered
  code fails (exit 1), and the same broken change without `--workspace` is indeterminate (exit 2).

### Trust model (honest limit)
- Workspace mode protects against a repo's **own change under review**: its feature branch cannot
  supply or loosen the rules it is checked against, and a change to the pinned refs, or to config
  blob bytes, during the run is detected.
- It does **not** protect against whoever can commit to the workspace ref or chooses
  `--workspace-ref` (the caller picks the ref; any branch or full SHA is accepted) — that party owns
  the contract of every listed repo. Code the gate executes runs with the user's rights: it can
  rewrite a local workspace for a LATER run, which no in-run check can see (the same execution-trust
  limit the referee already documents). That limit also covers what no ref or blob check sees,
  including WITHIN one `qk-org-gate` run for repos gated later: commit and tree objects are trusted
  (a tree rewritten in place with valid content can point a later repo's config path at another
  real blob, undetected), directories shared with the real repo through `linkPaths` (e.g.
  `node_modules`) can be altered, the plugin's own scripts can be rewritten, and `breaker-gate.mjs`
  still reads its contract/attack files without the blob check. The real fix for this class is isolation — each repo's verify in
  its own sandbox — not more in-run checks. A local-only workspace is anchored only locally. Branch
  protection on a reviewed remote only helps if callers also pin the ref to that remote branch;
  signed workspace commits are the other option — neither is in this release.

### Fixed
- `route.mjs` (and the new `qk-org-gate.mjs`) ran nothing and exited 0 when invoked through a
  symlinked path (on macOS `/tmp` and `/var` are symlinks): the "is this the main module" check
  compared a resolved URL with an unresolved `argv[1]`. Now real paths are compared
  (`scripts/entrypoint.mjs`). `crap.mjs` has the same check and is not changed in this release.

### Known limit
- Colocated tests: with `productionGlobs: ["src/**"]` and tests under `src/`, a change that edits a
  test is indeterminate (a production glob that also matches a test pattern is refused as
  ambiguous). Unchanged from 0.6.0; now visible because workspace mode makes such repos gateable.

## [0.6.0] - 2026-09-25

### Changed — the gate verifies committed bytes (behaviour change)
- **Base and head trees are written from raw blobs** (`git ls-tree` + `git cat-file --batch`), not
  `git archive`. `git archive` applied checkout conversions driven by uncommitted state, which
  flipped verdicts both ways: a smudge filter declared in `$GIT_DIR/info/attributes` plus local
  config neutered the base harness and turned a real FAIL into PASS; a global `core.autocrlf` turned
  a clean change into FAIL. Now no conversion runs at all — including those the *committed*
  `.gitattributes` asks for: `export-ignore`/`export-subst`, `eol`, `ident`, `working-tree-encoding`
  are not applied, and exec bits come from the tree mode.
- **A path with a `filter` attribute (e.g. Git LFS) is refused as indeterminate** (committed, or
  set in `$GIT_DIR/info/attributes`): its committed bytes are a placeholder, so verifying them would
  not test the file the project uses.
- **Every blob is re-hashed against its committed id**, and every git call runs with
  `GIT_NO_REPLACE_OBJECTS=1` and `core.fsmonitor=false` (new `scripts/safe-git.mjs`, also used by
  the router). A local `git replace`, or a rewritten loose object, turned a real FAIL into PASS.
- **Tree entries git would not check out are refused**: `..`, `.`, empty or `\` components, `.git`
  (and its case/8.3 variants), duplicates. A crafted tree (`hash-object --literally`) with an entry
  named `..` aliased `src/../lib/helper.mjs` onto a base harness helper and forged a PASS.
- **Requires git >= 2.40** (`check-attr --source`), checked up front.
- ATTACK N7/Q7 (`export-ignore` on the tests) now ends in a definitive FAIL (exit 1): the stripped
  harness can no longer be stripped, so it runs and blocks. It was indeterminate (exit 2) before.

### Fixed — gate
- **A contract kept out of the base by an ignore rule is diagnosed.** When `tools.json` is missing
  at base but present in the worktree and ignored, the indeterminate reason names where the rule
  lives (file and line — never its text, which the change controls) and the fix (`git add -f`).
  Negation rules are not reported as ignores; the probe runs with fsmonitor disabled.
- **Temp trees no longer leak on indeterminate exits.** `process.exit` skipped the `finally`
  cleanup; trees are now also removed from an exit handler (each removal isolated).
- **Overlay fidelity**: a production file whose mode changes at head gets the head mode (was a false
  FAIL); a file that becomes a directory, or the reverse, is verified instead of crashing with exit 1.
  Write errors, and blobs above a size cap (`QK_MAX_BLOB_BYTES`, default 256 MiB), are indeterminate.
  The cat-file staging file is created exclusively with mode 0600.
- Known limit, documented: killing the gate with a signal mid-verify still leaks its tree and
  orphans the verify command (blocking `spawnSync`); tracked as a follow-up.

### Fixed — test suite
- The Node suite no longer depends on the developer's git setup. A global `core.excludesfile`
  (or the XDG `git/ignore`) listing `.quality-kernel/` failed 59 of 126 tests; a global
  `core.hooksPath`, `commit.gpgsign` or an outer `git -c` (`GIT_CONFIG_PARAMETERS`) failed
  fixture commits; an inherited `GIT_DIR` (suite run from a git hook) committed fixtures into the
  outer repo. Git-using tests import `scripts/hermetic-git.mjs` first: it pins a temporary global
  config (repo-local config still wins, so attack tests can plant it), sets `GIT_CONFIG_NOSYSTEM`
  and `GIT_ATTR_NOSYSTEM`, and drops every inherited `GIT_*` variable.

### Added
- `scripts/hermetic-git.test.mjs`: eight hostile git environments, each with a control that shows the
  hostile setup takes effect; repo-local config still wins; a child process proves the env rewrite
  and the temp-config cleanup.
- `scripts/test-hygiene.test.mjs`: every test that reaches git (directly, in a shell string, or via
  referee, route, qk-gate, breaker-gate or `hooks/pre-push.sample`) imports the hermetic module
  first; no non-test file imports it.
- `scripts/manifest-consistency.test.mjs`: plugin.json, marketplace.json, the README status lines
  and the newest CHANGELOG entry share one version; every agent file declares a model alias and
  each stage its expected one.

### Fixed
- Every gate script run through a symlinked path (a symlinked plugin install, macOS `/tmp` ->
  `/private/tmp`) skipped its main() and exited 0: a silent PASS. The entrypoint guard compared the
  realpath-resolved `import.meta.url` with the as-typed `argv[1]`. All 14 scripts and the pre-push gate
  now use `scripts/is-main.mjs`, which compares real paths. Observed: `contract-review.mjs` and
  `crap.mjs` via a symlink exited 0 on a missing input; they now exit 2.
- `docs/specs/gate-process-tree/contract.md` said the Linux MemAvailable threshold was "fixed, no
  override", contradicting Decision 16 and `mem-config.mjs`, which apply `QK_MEM_MIN_LEVEL_PCT`
  (default 15). Found by the new contract review.
- The default local-target pattern is anchored. `isLocalTarget` accepted `localhost.attacker.com`,
  `my-localhost-proxy.example.com` and `127.0.0.1.nip.io`, bypassing the consent gate that limits
  the autonomous breaker to local systems.
- The Node suite no longer depends on the developer's git config. A global `core.excludesfile`
  (or the XDG `git/ignore`) listing `.quality-kernel/` kept fixtures' `tools.json` out of the base
  commit, failing 59 of 126 tests; a global `core.hooksPath` ran personal hooks on fixture commits.
  Git-spawning tests now import `scripts/hermetic-git.mjs`.
- `hooks/test_hooks.py` no longer depends on the developer's git config. A global or XDG excludes
  file listing `.quality-kernel/` made a fixture repo look gitignored, failing 2 evidence-gate tests;
  the suite now pins git's config as `scripts/hermetic-git.mjs` does for the Node suite.

## [0.5.0] - 2026-09-25

### Changed
- **hardener** and **qa** move from the `sonnet` alias to the `opus` alias. Mutation triage and the
  QA script (which becomes the blind breaker's probe) run on the stronger tier. This raises per-run
  cost for stages 5–6.
- All six agents keep declaring model **aliases**, never literal IDs, so the model is chosen by each
  user's `ANTHROPIC_DEFAULT_*_MODEL` (and works on Bedrock, Vertex and gateways). The README
  documents how to pin a tier.
- Removed the model name from the architect's description; the `model:` field is the only source.
- `marketplace.json` entry aligned with `plugin.json` (it had drifted at 0.1.0).

## [0.4.0] - 2026-09-09

### Changed — the gate was reworked after an independent red-team panel broke v1
An independent 4-expert panel re-validated the plan and the built gate **by execution** and refuted
the v0.3.0 claim that "a change cannot pass by weakening, neutering, or deleting its own tests." The
v1 trusted-harness only restored a whitelist of `**/*.sh` among verify runners and read state from the
worktree, so a change could still go green on broken code (non-`.sh` runner swap, helper/golden
neuter, symlink, non-ASCII path, worktree/HEAD divergence, forged base). Full record and every
reproduced attack: `docs/agentic-harness/validation-panel.v1.md` (+ `.v2.md`). The referee and router
were rebuilt:
- **Commit-anchored, base-authoritative.** The gate verifies a committed `base..head` (never the
  worktree). The verify contract (`tools.json`) and the critical surface are read from the **base ref**;
  an absent/invalid contract or an unverifiable ref is **indeterminate**, never a worktree fallback.
- **Inverted trusted tree + a mandatory second run.** Run 1 = the full BASE tree with only the head's
  `productionGlobs` overlaid (an immutable harness denylist — tests, runners, manifests, configs —
  always stays at base). Run 2 = the full head as-is. Both must be green. This closes the whole
  file-tampering class and also executes code outside `productionGlobs` and the head's own new tests.
- **Acceptance oracle (Constitution P3).** Optional `acceptance` command, distinct from the coder's
  tests, run against the immutable tree — an independent, human-approved check.
- **Fail-closed hardening.** Committed symlinks, degenerate `productionGlobs`/`outputGlobs`, tests
  stripped by `.gitattributes export-ignore`, harness mutation (ctime + path-set + created-symlink
  detection), case/normalization-colliding paths, and any changed path that is neither production nor
  a declared test nor a benign manifest change are all **indeterminate**. `linkPaths` is opt-in
  (default `[]`); prefer `verifySetup` (e.g. `npm ci --ignore-scripts`) from the base lockfile. The
  pre-push hook gates the exact pushed sha against a **remote-anchored** base (`git ls-remote`).
- **No path-name allow-list.** Every changed/removed path gets an explicit disposition —
  production (overlaid+verified), declared test (`testGlobs`), manifest (production-field-checked),
  else indeterminate. Docs/prompts/assets/config are declared in `productionGlobs` so anything read
  at runtime is verified (overlaying prose is harmless). "Overlay" and "allowed-unverified" use
  separate sets so a nested test under `productionGlobs` is never overlaid.
- **Option B — test evolution with human review.** The tests a PR modifies are taken from head (so a
  legitimate behavior change verifies green), and any test change is routed **critical → exit 3
  (human review)**. This replaces the earlier "immutable base tests" model, which — as the panel's
  usability probe showed — rejected every legitimate behavior change and would have been disabled in
  practice. The honest guarantee is now: **breaking covered code without touching its test is
  mechanically blocked; a test change is forced to human review** (the human owns the contract);
  neutering is visible-and-gated, not mechanically impossible.

### Known limit (declared, not fixed — this is the M2 breaker's job)
The referee is an in-process test oracle, so production code can still self-declare green by
subverting the oracle in-process (monkeypatching `node:assert`, `process.exit(0)`, or fingerprinting
the gate environment), and a baseline with no real tests cannot be rescued. These are **not** covered
by M0+M1 and are not claimed to be; only the M2 live breaker (a black-box probe in a
prod-indistinguishable environment) closes them.

## [0.3.0] - 2026-09-08

### Added
- **The deterministic quality gate** — the reusable core, red-team-hardened:
  - `scripts/referee.mjs` — re-executes the project's `verify` command in its own subprocess and
    reads the real exit status (never trusts a "done" claim); fail-closed. Loads the verify command
    from the **committed base ref**, and re-runs the **base test-harness against the head code**
    (trusted-harness), so a change cannot pass by weakening/neutering/deleting its own tests.
  - `scripts/route.mjs` — deterministic blast-radius/tier classifier from `critical-surface.json`
    globs. Deleted tests and `.quality-kernel/**` changes are always critical; requires `--base`
    (else fail-closed); fail-safe: no config => critical.
  - `scripts/qk-gate.mjs` — composed gate (route + referee); exit `0`/`1`/`2`/`3`.
  - `commands/gate.md` — the **`/gate`** slash command.
  - `hooks/pre-push.sample` — a git pre-push invoker that blocks a push on a non-zero gate.
- A specialist panel red-teamed the gate and broke it; every attack (lie about the result, weaken
  `tools.json`, delete or neuter a test, invoke without a base) is now a permanent regression test
  (`scripts/{referee,route,qk-gate,attacks,pre-push}.test.mjs`). Design + review chain frozen under
  `docs/agentic-harness/`.

### Changed
- **evidence-gate**: stop fabricating exit codes — Claude Code's Bash `tool_response` has no exit
  code (verified); the referee is now the authoritative exit-code source in the ledger. Verify
  detection is anchored at the command start and quote-aware, so prose in a quoted body (e.g. a PR
  comment) is no longer a false verification event.

## [0.2.0] - 2026-09-03

### Fixed
- **evidence-gate**: recognize Node's built-in test runner `node --test` (with any
  trailing flags, e.g. `--experimental-test-coverage`) in `VERIFY_RE`. Previously,
  runs of the native runner — used by zero-dependency JS projects — were silently
  ignored, leaving no entry in `.quality-kernel/evidence-ledger.jsonl` for an
  otherwise-real verification. Surfaced while exercising the six-agent `/forge`
  pipeline end-to-end on a plain `node --test` repo. ([#21])

### Added
- **evidence-gate**: regression test (`test_node_test_runner_is_recorded`) that
  guards the `node --test` rule in isolation — it uses a bare `node --test` command
  (no `coverage`/`nyc`/other already-matched token), so it fails if the rule is
  removed. Hook test suite: 15 tests.

## [0.1.0] - 2026-09-02

### Added
- Initial release. ([#20])
- Six-agent SwarmForge-style engine: `specifier → coder → cleaner → architect →
  hardener → qa`, each with a self-audit before handoff.
- `/forge` orchestrator with automatic tier routing (T0/T1/T2) and a blast-radius
  override that forces T1+ on the critical surface.
- Two hooks (ship in log-mode by design):
  - `epistemic-guard.py` (PreToolUse / `Task|Agent`) — requires the
    `[EPISTEMIC-DISCIPLINE v1]` marker on every agent spawn; `log` (default) or
    `block` via `QK_EPISTEMIC_MODE`.
  - `evidence-gate.py` (PostToolUse / Bash) — records test/build/verify exit codes
    to a per-project ledger.
- Deterministic tools: `crap.mjs` (CRAP = c²·(1−cov)³ + c, threshold 6) with tests.
- Per-project config examples: `tools.example.json`, `critical-surface.example.json`.

[0.2.0]: https://github.com/adrianflda/claude-code-templates/releases/tag/quality-kernel-v0.2.0
[0.1.0]: https://github.com/adrianflda/claude-code-templates/releases/tag/quality-kernel-v0.1.0
[#21]: https://github.com/adrianflda/claude-code-templates/pull/21
[#20]: https://github.com/adrianflda/claude-code-templates/pull/20
