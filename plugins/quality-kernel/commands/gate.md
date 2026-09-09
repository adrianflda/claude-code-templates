---
description: Run the quality gate (deterministic risk routing + re-executing referee) on the current change and report the verdict.
---
Run the composed quality gate on the current change and report the result in plain language.
Never trust a prior "it's done" claim — the gate RE-EXECUTES the tests itself and reads the real
result. Report only what the gate returned.

The gate verifies COMMITTED history (a `base..head` range), never the working tree — so commit
your change first. If the worktree is dirty, warn the user that uncommitted changes are NOT gated.

Steps:
1. Resolve the repo root: `git rev-parse --show-toplevel`.
2. Resolve the range:
   - head = `$2` if passed, else `HEAD` (must be committed).
   - base = `$1` if passed; else the merge-base with the remote-tracking upstream
     (`git merge-base @ @{u}` 2>/dev/null). If neither resolves, ask the user for an explicit base
     rather than guessing (`HEAD~1` can silently trust prior commits).
3. Run:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/qk-gate.mjs" --repo "<repo-root>" --base "<base>" --head "<head>"`
4. Read the JSON verdict AND the process exit code, and tell the user plainly:
   - exit **0** → ✅ verified green — the immutable base harness (× head production) re-executed clean.
   - exit **1** → ❌ blocked — verify or the acceptance oracle FAILED when re-executed. Show `referee.reason`.
   - exit **2** → ⚠️ indeterminate (fail-closed) — e.g. no committed contract at base, missing
     `productionGlobs`, a committed symlink, or the command could not run. Show `referee.reason`.
   - exit **3** → 🟠 green, but the change is **critical** and the live breaker (M2) is not yet
     enforced → do not merge without a human/breaker review. Show `route.criticalFiles`.
5. If the repo has no committed `.quality-kernel/tools.json`, tell the user to create and COMMIT it once
   (copy `${CLAUDE_PLUGIN_ROOT}/config/tools.example.json`):
   `{ "verify": "<test cmd, e.g. npm test / pytest -q / node --test>", "productionGlobs": ["src/**"], "acceptance": null }`
   plus a committed `.quality-kernel/critical-surface.json` (copy the example and author its globs
   from the repo's own past incidents). Both are read from the base ref, so they must be committed.
