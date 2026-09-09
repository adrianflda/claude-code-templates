---
description: Run the quality gate (deterministic risk routing + re-executing referee) on the current change and report the verdict.
---
Run the composed quality gate on the current change and report the result in plain language.
Never trust a prior "it's done" claim — the gate RE-EXECUTES the tests itself and reads the real
result. Report only what the gate returned.

Steps:
1. Resolve the repo root: `git rev-parse --show-toplevel`.
2. Resolve the base ref: use `$1` if the user passed one; else the branch's merge-base with its
   upstream (`git merge-base @ @{u}` 2>/dev/null); else `HEAD~1`.
3. Run:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/qk-gate.mjs" --repo "<repo-root>" --base "<base>"`
4. Read the JSON verdict AND the process exit code, and tell the user plainly:
   - exit **0** → ✅ verified green — the change is safe.
   - exit **1** → ❌ blocked — the test suite FAILED when re-executed. Show `referee.reason`.
   - exit **2** → ⚠️ indeterminate (fail-closed) — the verify command could not run. Show why.
   - exit **3** → 🟠 green, but the change is **critical** and the live breaker (M2) is not yet
     enforced → do not merge without a human/breaker review. Show `route.criticalFiles`.
5. If the repo has no `.quality-kernel/tools.json`, tell the user to create it once:
   `{ "verify": "<your test command, e.g. npm test / pytest -q / node --test>" }`
   and a `.quality-kernel/critical-surface.json` (copy `${CLAUDE_PLUGIN_ROOT}/config/critical-surface.example.json`
   and author its globs from the repo's own past incidents).
