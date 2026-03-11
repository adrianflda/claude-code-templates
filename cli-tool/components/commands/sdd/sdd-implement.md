---
description: "Execute implementation from tasks.md — phase by phase, marking tasks complete as they finish"
argument-hint: "[optional: 'phase 1' to run specific phase, or 'resume' to continue from last checkpoint]"
allowed-tools: Bash(git:*), Bash(mkdir:*), Bash(npm:*), Bash(pip:*), Bash(python:*), Bash(node:*), Bash(dotnet:*), Bash(go:*), Bash(cargo:*), Bash(mvn:*), Read, Write, Edit
---

# SDD Implement

Execute implementation plan: $ARGUMENTS

## Instructions

Execute the task plan defined in `tasks.md`. Process phases in order, respect dependencies, mark tasks complete as they finish.

### Step 1: Detect Active Feature and Load Context

```bash
BRANCH=$(git branch --show-current)
```

Verify `$BRANCH` matches `NNN-feature-name`. Load from `specs/$BRANCH/`:

- **Required**: `tasks.md`, `plan.md`, `spec.md`
- **Load if exists**: `data-model.md`, `contracts/`, `research.md`

If `tasks.md` is missing, STOP: "Run `/sdd-tasks` first to generate the task breakdown."

If `plan.md` is missing, STOP: "Run `/sdd-plan` first to generate the technical plan."

If `spec.md` is missing, STOP: "Run `/sdd-specify` first — spec.md is required as the source of truth."

Load `CONSTITUTION.md` from project root. All implementation decisions must comply.

### Step 2: Pre-Implementation Checks

1. **Count incomplete items in tasks.md:**
   - `- [ ]` = incomplete
   - `- [x]` or `- [X]` = complete

2. **Check for previous progress:**
   If any tasks already marked complete, inform user:
   "Found N completed tasks. Resuming from last checkpoint."

3. **Parse `$ARGUMENTS`:**
   - `phase N` → run only Phase N
   - `resume` → skip to first incomplete task
   - `story N` → run only Phase for User Story N
   - Empty → run all phases sequentially

4. **Verify project setup** (from plan.md tech stack):
   - Ensure required ignore files exist (`.gitignore`, `.dockerignore` if Docker detected)
   - Create missing ignore files with appropriate patterns for the tech stack

### Step 3: Parse Task Structure

From `tasks.md`, extract:
- Phase list in order
- For each phase: tasks with IDs, [P] markers, [USN] labels, file paths
- Dependency relationships (sequential vs parallel)

### Step 4: Execute Phase by Phase

For each phase (in order):

1. **Announce phase start:**
   ```
   ## Phase N: [Phase Name]
   Goal: [Phase purpose]
   Tasks: [count] ([count P] parallelizable)
   ```

2. **Execute tasks:**
   - For `[P]`-marked tasks in same phase: execute conceptually in parallel
     (in practice: complete each, but note they have no inter-dependencies)
   - For sequential tasks: complete one before starting the next
   - Use spec.md acceptance criteria as the definition of correct behavior
   - Use plan.md architecture decisions for HOW to implement
   - Use data-model.md for exact entity shapes
   - Use contracts/ for exact API shapes

3. **After each task completes:**
   - Mark it as `[x]` in `tasks.md`
   - Note any deviations from plan (document in plan.md if significant)

4. **Phase checkpoint:**
   After all tasks in phase complete, run the phase's independent test:
   - Verify the user story or foundation works as described in spec.md
   - If test fails: stop, report the issue, wait for user guidance

### Step 5: Handle Implementation Deviations

If a task cannot be completed as written:
1. Stop and report: "Task T[NNN] cannot be executed as specified: [reason]"
2. Propose alternatives: "Options: A) [alternative] B) [skip and continue] C) [modify task]"
3. Wait for user decision before continuing

If a security or constitution violation is detected during implementation:
1. Stop immediately
2. Report: "Constitution violation detected: [principle] violated by [implementation choice]"
3. Propose a compliant alternative

### Step 6: Completion Report

After all requested phases complete:

```
## Implementation Complete

Phase(s) executed: [list]
Tasks completed: N/N
Tasks skipped: N (if any — list why)

### Files Created/Modified
- [file path] — [created/modified, what it does]

### Acceptance Validation
- User Story 1: [Pass/Fail — brief note]
- User Story 2: [Pass/Fail — brief note]

### Deviations from Plan
- [List any] (or: "None — implementation matches plan exactly")

Next steps:
  - Run tests: [test command from plan.md]
  - Review changed files
  - Commit: git add [list changed files explicitly] && git commit -m "feat: [feature description]"
```

### Step 7: Update SDD Context

Update `.claude/sdd-context.md`:
- Mark implementation status
- Log completed phases

## Rules

- NEVER skip tasks without user approval
- ALWAYS consult spec.md for acceptance criteria, plan.md for architecture
- ALWAYS mark tasks [x] immediately after completion
- If constitution is violated, STOP and report before proceeding
- Prefer smaller, reversible changes over large monolithic implementations
