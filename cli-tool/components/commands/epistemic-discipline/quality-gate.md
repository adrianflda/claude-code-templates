---
description: "Mid-task adversarial quality gate — runs adversarial-critic + qa-expert on current changes. Use before committing, not just before pushing."
argument-hint: "[optional: scope description or specific concern to focus on]"
allowed-tools: Bash(git:*), Bash(cat:*), Bash(ls:*), Agent
---

# Quality Gate

Run an adversarial quality check on the current working changes.

Scope / concern: $ARGUMENTS

## When to use

Run this before committing whenever:
- You've finished implementing a feature or bug fix
- You're unsure if the implementation is complete
- A task has taken more than 2 iterations to get right
- You want a second opinion before the full pre-push pipeline

This is NOT a replacement for the mandatory 5-agent pre-push review — it's a mid-task check that catches problems early, before they accumulate.

## Instructions

### Step 1 — Gather context

```bash
git diff HEAD          # all uncommitted changes
git diff origin/HEAD   # everything since last push (if already committed)
git status             # untracked files
```

If there's nothing in the diff, check for untracked files. If there's truly nothing changed, report: "No changes detected — nothing to gate."

### Step 2 — Read changed files

For every file in the diff, read the complete file (not just the diff lines). Context matters — a change that looks fine in isolation may break surrounding logic.

### Step 3 — Spawn adversarial-critic

Spawn Agent with subagent_type `adversarial-critic` and this prompt:

```
Adversarial critique of current implementation.

Task/scope: [PASTE $ARGUMENTS OR TASK DESCRIPTION]

Diff vs HEAD:
[PASTE git diff output]

Changed files (full content):
[PASTE each changed file in full]

Attack the work across all 7 dimensions. Return a scored critique with VERDICT: LGTM or REWORK REQUIRED.
```

### Step 4 — Spawn qa-expert (parallel with Step 3)

Spawn Agent with subagent_type `qa-expert` and this prompt:

```
Test coverage review for current changes.

Changed files: [list]
Diff: [paste diff]

Assess:
1. Is there a test for every new behavior introduced?
2. Do the tests call through real handlers (not internal functions)?
3. Would any test pass on a reverted/broken implementation?
4. Are edge cases covered: empty, null, boundary values?

Report gaps by severity: BLOCKING / HIGH / MEDIUM.
Verdict: COVERAGE ADEQUATE or COVERAGE GAPS FOUND.
```

### Step 5 — Evaluate results

**If ADVERSARIAL CRITIC score >= 70 AND QA VERDICT is COVERAGE ADEQUATE:**
```
✅ QUALITY GATE PASSED (score: [N]/100)

[summarize any medium/low concerns worth tracking]

Safe to commit. Pre-push pipeline still required before gh pr create.
```

**If ADVERSARIAL CRITIC score < 70 OR QA VERDICT is COVERAGE GAPS FOUND:**
```
⛔ QUALITY GATE FAILED

Blocking gaps:
[list from adversarial-critic]

Coverage gaps:
[list from qa-expert]

Do NOT commit until these are resolved.
```

### Step 6 — Budget check (anti-loop rule)

Before returning, count the `⛔ QUALITY GATE FAILED` verdicts this conversation has already produced for this same
task scope (the execution log that used to hold this count was removed on 2026-10-28; it never recorded verdicts).

If this is the **3rd or more** quality gate run for the same task without a passing result, stop and tell the user:

```
⚠️ BUDGET EXCEEDED — this task has failed the quality gate 3 times.

This is a signal that the approach may be wrong, not just the implementation.
Recommended: pause, describe the problem to the user, and align on approach before continuing.
```

Do NOT attempt another iteration autonomously after 3 failures.
