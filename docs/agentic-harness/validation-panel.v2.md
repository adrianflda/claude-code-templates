# Independent Validation Panel — v2 (closure record)

> **Status:** Closure record for the M0 gate rework. `validation-panel.v1.md` recorded the panel that
> broke the v1 gate; this file records the **adversarial hardening loop** that followed — one
> independent breaker (`gate-breaker`) re-attacking each version **by execution**, every reproduced
> attack becoming a permanent regression test — and the **final architecture, guarantee, and declared
> limits**. Verify-by-execution throughout; nothing here is claimed without a reproduced test.
> **Versioning rule:** never overwrite; the next record is `validation-panel.v3.md`.

## Outcome in one paragraph

The M0 gate was rebuilt from a design an independent panel broke (v1, score 25/100 — fooled 9 ways by
one-liners) into a commit-anchored, base-authoritative gate hardened across ~10 adversarial rounds.
Every reproduced attack is now a permanent regression test (**82 node + 17 python, all green**). The
**entire static file-tampering surface is closed** (or fail-closed to indeterminate). What remains is
(a) the **execution-trust / in-process class** — the change's own code executing and being trusted —
which by the plan's design is the **M2 live-breaker's** job, and (b) an accepted **trust model**: test
changes are surfaced for **human review**, not mechanically certified. The plan itself was validated as
sound and kept.

## The hardening loop (score by round, each finding reproduced then closed)

| Round | Score | Breaker finding (class) | Resolution |
|---|---|---|---|
| v1 | 25 | trivial forge / worktree / non-`.sh` runner / test-neuter | full rebuild |
| v2 | 45 | commit-anchoring + inverted trusted tree needed | referee/route rebuilt on `base..head` |
| v2.1 | 48 | head-as-is missing; linkPaths trusts worktree; export-ignore | 2nd mandatory run; linkPaths opt-in; strip detection |
| v2.2 | 52 | completeness (deletions), harness-integrity, TEST_GLOBS gaps | undeclared-change rule; ctime/hash; broad TEST_GLOBS |
| v2.3 | 60 | `IGNORE_DIR` write-through (build plants a module) | minimal ignore set + declared `outputGlobs` |
| v2.4 | 58 | transient create-use-delete; degenerate `outputGlobs`; symlink-in-run | ctime + path-set + symlink recording; validate outputGlobs |
| v2.5 | 60 | static: runtime inputs classified inert/harness by NAME | shrink inert; narrow harness; package.json field-check; case guard |
| v2.6 | 63 | same class re-manifests (`.md`/docs/`changelog-parser`/`spec/`) | **structural: eliminate the path-name allow-list** |
| v2.7 | 58 | ATTACK B regression (nested tests overlaid); test-named production | **two-set separation** (overlay-broad vs allow-narrow) |
| v2.8 | 64 | oracle helpers under productionGlobs (T); S4 bootstrap; **U2 usability** | never-overlay oracle components; S4 ref-scan; **Option B** |
| v2.9 | — | Option B verification (usable + neutering human-gated) | final |

The score plateaued at 58–64 because each late round found a one-degree variant of the same shrinking
static class, until the **structural** fixes (v2.6 no-allow-list, v2.7 two-set separation, v2.8 Option B)
addressed the root causes rather than the instances.

## Final architecture (what the gate does now)

- **Commit-anchored, base-authoritative.** Verifies a committed `base..head` (never the worktree). The
  verify contract and critical surface are read from the **base ref**; anything unverifiable is
  indeterminate, never a worktree fallback. The pre-push hook gates the exact pushed sha against a
  remote-anchored base.
- **Explicit disposition per changed/removed path** (no silent allow-list): production (matches
  `productionGlobs`) → **overlaid from head onto the full base tree and verified**; declared test
  (`testGlobs`) → executed; manifest → production-field-checked; **anything else → indeterminate**
  ("declare it in productionGlobs"). "What to overlay" (broad never-overlay set) and "what change is
  allowed unverified" (narrow anchored test roots) are **separate sets**.
- **Two mandatory runs** (both green) + optional **acceptance oracle** (human-approved, distinct from
  the coder's tests — Constitution P3): base-harness × head-production, and head-as-is.
- **Harness integrity**: symlinks in a committed tree rejected; oracle components (test frameworks by
  content, `__mocks__`/`fixtures`/`testing`/`testUtils`/`node_modules`/`vendor` by name) never overlaid;
  ctime + path-set + created-symlink checks catch a build mutating/creating harness files; declared
  `outputGlobs` are the only writable area; case/normalization collisions refused; export-ignore
  stripping refused.
- **Option B (test evolution + human review):** tests the PR modifies are overlaid from head so a
  legitimate behavior change verifies green; any test change is routed **critical → exit 3 (human
  review)**. Breaking covered code **without** touching its test stays **mechanically blocked** (exit 1).

## The honest guarantee (what a green means)

> **Breaking covered production code without editing its test is mechanically blocked. Any test change
> is forced to human review (the human owns the contract). The change is verified against the immutable
> base harness and an optional human-approved acceptance oracle, re-executed.**

It does **not** mean "the code cannot be malicious." Neutering a test is *visible and human-gated*, not
mechanically impossible.

## Declared limits (M2 live-breaker scope — reproduced, not closed)

Each requires the change's own code to **execute and be trusted**, which a file-level oracle cannot
defend by mechanism:
- **In-process oracle subversion** (production monkeypatches `node:assert` / calls `process.exit(0)`).
- **Gate-environment fingerprinting** (behaves correctly only when it detects the gate).
- **Execution-trust** (a build/`verifySetup`/codegen step fabricates or vendors what tests consume; and
  a fake dep vendored into `node_modules`). Mitigation: keep build/codegen as immutable harness and
  provision deps hermetically.
- **No baseline tests** (the gate cannot invent a suite).
- **`linkPaths` write-through** (opt-in; documented trust hole).

Closing these needs a black-box probe in a prod-indistinguishable environment: **M2**.

## Verdict

- **Plan:** sound; kept (amend via versioned docs, never overwrite).
- **M0 gate:** the static fakeability surface is closed; the tool is now **usable** (Option B) and
  **honest** about its boundary. Ready to use as a local pre-push / `/gate` quality gate. The remaining
  fakeability is the M2 breaker's domain and is declared, not hidden.
- **Regression suite:** every reproduced attack (v1 through v2.9) is a permanent test in
  `plugins/quality-kernel/scripts/{attacks,route,referee,qk-gate,pre-push}.test.mjs`.
