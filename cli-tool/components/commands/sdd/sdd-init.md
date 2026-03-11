---
description: "Initialize Spec-Driven Development structure in any project — creates specs/, CONSTITUTION.md, and .claude/sdd-context.md"
argument-hint: "[optional: project name or description]"
allowed-tools: Bash(git:*), Bash(mkdir:*), Bash(ls:*), Bash(date:*), Read, Write
---

# SDD Init

Initialize Spec-Driven Development for this project: $ARGUMENTS

## Instructions

Bootstrap the SDD folder structure and governance files. Run once per project before any feature work begins.

### Step 1: Check Existing Structure

```bash
ls -la specs/ 2>/dev/null && echo "EXISTS" || echo "NOT_FOUND"
ls CONSTITUTION.md 2>/dev/null && echo "EXISTS" || echo "NOT_FOUND"
ls .claude/sdd-context.md 2>/dev/null && echo "EXISTS" || echo "NOT_FOUND"
```

If `specs/` already exists, ask user to confirm before proceeding (avoid overwriting work).

### Step 2: Detect Project Name

```bash
# Try package.json first
PROJECT_NAME=$(node -e "console.log(require('./package.json').name)" 2>/dev/null || basename $(git rev-parse --show-toplevel) 2>/dev/null || echo "my-project")
TODAY=$(date +%Y-%m-%d)
```

If `$ARGUMENTS` is provided, use it as the project name/description instead.

### Step 3: Create Directory Structure

```bash
mkdir -p specs
mkdir -p .claude
```

### Step 4: Create CONSTITUTION.md

Write `CONSTITUTION.md` at the project root with a starter template:

```markdown
# [PROJECT_NAME] Constitution

> [One-line project mission — replace this]

## Core Principles

### I. Quality First
All code MUST be reviewed and tested before merge. No shortcuts that create technical debt without explicit tracking.

### II. Spec Before Code
No implementation begins without an approved spec. The spec defines WHAT and WHY; the plan defines HOW.

### III. Testability by Default
Every functional requirement MUST be testable. If you cannot write a test for it, it is not a valid requirement.

## Technical Constraints

[Replace with your project's actual constraints, e.g.:]
- Language: [TypeScript / Python / etc.]
- Framework: [React / FastAPI / etc.]
- Testing: [Jest / pytest / etc.]
- No direct database access from handlers (use service layer)

## Quality Gates

- **Before /sdd-plan**: Spec must have ≤ 3 [NEEDS CLARIFICATION] markers
- **Before /sdd-implement**: /sdd-analyze must report no CRITICAL issues
- **Definition of Done**: All tasks marked [x], acceptance scenarios pass, code reviewed

## Governance

Amendment process: Any change to Core Principles requires team discussion and a version bump.

**Version**: 0.1.0 | **Ratified**: [TODAY] | **Last Amended**: [TODAY]
```

Replace `[PROJECT_NAME]` with the actual project name and `[TODAY]` with today's date.

### Step 5: Create .claude/sdd-context.md

Write `.claude/sdd-context.md`:

```markdown
# SDD Context

**Project**: [PROJECT_NAME]
**Initialized**: [TODAY]

## Active Feature

None — run `/sdd-specify [description]` to start a feature.

## Feature History

| Branch | Spec | Plan | Tasks | Status |
|--------|------|------|-------|--------|
| — | — | — | — | — |

## Pipeline Reminder

    /sdd-init           → (once per project)
    /sdd-constitution   → (once, update as needed)
    /sdd-specify        → creates branch + spec.md
    /sdd-clarify        → resolves ambiguities (max 5 questions)
    /sdd-plan           → generates plan + artifacts
    /sdd-analyze        → cross-artifact consistency check
    /sdd-tasks          → generates tasks.md
    /sdd-implement      → executes tasks phase by phase
```

### Step 6: Report

```
✅ SDD initialized!

Created:
  specs/                     ← feature specs directory
  CONSTITUTION.md            ← project governing principles
  .claude/sdd-context.md     ← context file (auto-updated by commands)

Next steps:
  1. Edit CONSTITUTION.md to reflect your actual project principles
  2. Run /sdd-constitution [principles] to flesh out the constitution
  3. Run /sdd-specify [feature description] to start your first feature

Quick reference:
  Workflow: specify → clarify → plan → analyze → tasks → implement
```
