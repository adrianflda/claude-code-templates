---
name: skill-audit-3r
description: Audit and prune Claude configuration (skills, agents, CLAUDE.md, hooks, commands) using the 3R rule, detect "hobbling" (over-prescriptive instructions that slow a capable model), and rewrite prompts to the Task + Guardrails + Done-criterion pattern. Use when the user wants to clean up / simplify / declutter their skills or CLAUDE.md, reduce token cost, or asks "which skills should I delete". Triggers on "audita mis skills", "3R", "borra skills", "hobbling", "simplify my setup".
---

# Skill Audit — the 3R rule

Premise (validated by Anthropic engineering + Boris Cherny): capable models need the
**smallest set of high-signal tokens**. Every extra instruction spends the model's finite
attention budget ("context rot") and can *hobble* it. Prune aggressively; keep only what the
model genuinely cannot infer.

## Step 1 — Inventory (deterministic, cheap)

Run the inventory script to list every config artifact with its word count, biggest first:

```bash
bash "$(dirname "$0")/scripts/inventory.sh" [project_dir]
```

- No arg → audits `~/.claude` global config only.
- `project_dir` → also scans that project's `.claude/` and `CLAUDE.md` files.

Do NOT read all files up front. Read a file only when you're about to judge it (just-in-time).
Start with the largest — they carry the most potential noise.

## Step 2 — Classify each artifact with the 3R rule

An artifact **stays only if it satisfies at least one R**:

- **Repeatable** — a task done over and over, identically (a real procedure worth capturing).
- **Requirement** — a hard rule the model CANNOT guess (business/infra facts, non-obvious
  constraints, project-specific gotchas).
- **Repartible / Shareable** — the team needs it to standardize.

Default verdicts:
- Business/infra context the model can't know → **KEEP** (Requirement).
- "How to reason", "be careful", "write clean code", generic best practices → **DELETE** (noise).
- Step-by-step recipes a current model already solves alone → **DELETE** (hobbling risk).
- Unsure → mark **ABLATE** and test (Step 3).

## Step 3 — Ablation for the unsure ones

Don't guess. For an ABLATE item: run one real task WITH and WITHOUT it, compare result quality
and cost (tokens/time). Keep the cheaper version that yields an equivalent-or-better result.
If removing it changes nothing → it was noise. Delete.

## Step 4 — Hobbling check

Flag an artifact as hobbling if it: prescribes *how to think* rather than *what to achieve*;
contradicts another artifact; enumerates micro-steps ("paso 1, paso 2"); or restates things a
capable model already does. These are the top rewrite/delete candidates.

## Step 5 — Rewrite survivors to the new pattern

Replace step lists with:

```
TASK:      the outcome you want (not the path)
GUARDRAILS: hard limits it must not cross
DONE:      a verifiable stop condition ("done when …")
```

The DONE criterion is the highest-value part: it's what makes autonomous/long-running agents safe.

## Step 6 — Report

Produce a table: artifact · words · verdict (KEEP/DELETE/ABLATE) · which R (if kept) · one-line reason.
Then propose concrete actions. **Never delete files directly** — recommend, and only remove with
explicit confirmation, always keeping a backup (git or the `backups/` dir) so it's reversible.

## Safety
- Recommend, don't auto-delete. Confirm before any removal.
- Keep a restore path for everything removed.
- Re-run this audit ~every 6 months (models keep improving).
