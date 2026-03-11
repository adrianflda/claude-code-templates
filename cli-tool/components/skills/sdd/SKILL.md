---
name: spec-driven-development
description: Use this skill when the user wants to implement a feature using the Spec-Driven Development methodology, asks about SDD workflow, wants to create specs/plans/tasks, or says "let's use SDD", "start a spec", "create a feature spec", or "follow SDD process". Also use proactively for non-trivial features (more than a few hours of work).
version: 1.0.0
---

# Spec-Driven Development (SDD) — Methodology Guide

> **Philosophy**: "Specs become executable" — structured specifications drive AI-assisted implementation instead of vibe coding
> **Inspired by**: GitHub/spec-kit and ThoughtWorks research on SDD (Liu Shangqi, APAC Tech Director, 2025)

---

## What is Spec-Driven Development?

SDD is a development paradigm where **well-crafted specifications serve as the primary artifact** that drives code generation via AI coding agents. Instead of describing vague requirements and hoping the AI figures it out, SDD separates:

1. **What + Why** (`spec.md`) — functional requirements, user stories, acceptance criteria
2. **How** (`plan.md`) — tech stack, architecture, data model, contracts
3. **Execution** (`tasks.md`) — dependency-ordered tasks with parallel markers

This is NOT a return to waterfall. It provides **shorter, more effective feedback loops** than vibe coding by putting structured thinking before implementation — and the AI does the heavy lifting of translating specs into plans and plans into code.

---

## Why SDD with AI Agents?

| Vibe Coding | Spec-Driven Development |
|-------------|------------------------|
| One-shot prompt → messy code | Structured spec → validated plan → clean code |
| Agent hallucinates features | Spec defines exact behavior boundaries |
| Context gets lost in long sessions | Specs compress context — agent always has ground truth |
| Rework when requirements were wrong | Clarify phase catches gaps before a line is written |
| No traceability | Every task maps to a requirement |

---

## The 8-Step Workflow

```
/sdd-init          (once per project)
      ↓
/sdd-constitution  (once, update as needed)
      ↓
/sdd-specify  →  /sdd-clarify  →  /sdd-plan  →  /sdd-analyze  →  /sdd-tasks  →  /sdd-implement
```

### Step 0: Initialize (once per project)
```
/sdd-init
```
Creates `specs/` directory, `CONSTITUTION.md`, and `.claude/sdd-context.md`.

### Step 1: Constitution (once per project)
```
/sdd-constitution TypeScript-first, AWS serverless, TDD mandatory, clean architecture
```
Defines non-negotiable principles. Everything else must comply.

### Step 2: Specify (once per feature)
```
/sdd-specify Build a user authentication system with email/password and OAuth2 support
```
Creates git branch `NNN-feature-name` and `specs/NNN-feature-name/spec.md` with user stories, FRs, success criteria.
**Focus: WHAT and WHY only. No tech stack.**

### Step 3: Clarify (before planning)
```
/sdd-clarify
```
Up to 5 targeted questions that resolve the highest-impact ambiguities. Reduces planning rework significantly.
Answers are integrated back into spec.md.

### Step 4: Plan (with tech stack)
```
/sdd-plan TypeScript, NestJS, PostgreSQL, AWS Lambda via CDK
```
Generates `plan.md`, `research.md`, `data-model.md`, `contracts/`.
**Focus: HOW — tech stack, architecture, file structure, contracts.**

### Step 5: Analyze (recommended before tasks)
```
/sdd-analyze
```
Read-only cross-artifact check. Finds inconsistencies between spec ↔ plan.
CRITICAL issues must be fixed before generating tasks or implementing.
Can also be run after tasks.md is generated to check full artifact consistency.

### Step 6: Tasks
```
/sdd-tasks
```
Generates `tasks.md` with:
- Phases: Setup → Foundation → [User Story phases] → Polish
- Task IDs: T001, T002...
- Parallel markers: `[P]`
- Story labels: `[US1]`, `[US2]`...
- Exact file paths for each task

### Step 7: Implement
```
/sdd-implement
```
Executes tasks.md phase by phase. Marks tasks `[x]` as they complete. Stops at checkpoints for validation.

---

## Artifact Structure (per feature)

```
specs/
└── 001-user-auth/
    ├── spec.md          ← /sdd-specify output  (WHAT + WHY)
    ├── plan.md          ← /sdd-plan output     (HOW)
    ├── research.md      ← /sdd-plan output     (library versions, decisions)
    ├── data-model.md    ← /sdd-plan output     (entities, relationships)
    ├── tasks.md         ← /sdd-tasks output    (execution plan)
    └── contracts/
        └── api-spec.md  ← /sdd-plan output     (API contracts)

CONSTITUTION.md              ← /sdd-constitution output (project root)
.claude/sdd-context.md       ← auto-updated context file
```

---

## What Makes a Good Spec?

From ThoughtWorks research (Liu Shangqi, APAC Tech Director):

> "A specification should explicitly define the external behavior of the target software — input/output mappings, preconditions/postconditions, invariants, constraints, interface types, integration contracts, and sequential logic/state machines."

**Spec quality checklist:**
- [ ] Uses domain language (ubiquitous language), not tech jargon
- [ ] Given/When/Then acceptance scenarios for every story
- [ ] Every FR is testable — if you can't test it, it's not a requirement
- [ ] Success criteria are measurable and technology-agnostic
- [ ] No `[NEEDS CLARIFICATION]` markers remaining after /sdd-clarify
- [ ] Edge cases identified
- [ ] Out of scope explicitly declared

**Good success criteria:**
- ✅ "Users complete checkout in under 3 minutes"
- ✅ "System handles 10,000 concurrent users"
- ❌ "API response time under 200ms" (implementation detail)
- ❌ "React components render efficiently" (framework-specific)

---

## What Makes a Good Tasks.md?

- Every task has: checkbox + ID + optional `[P]` + optional `[USN]` + description + file path
- Tasks are grouped by user story (each story independently testable)
- Each user story phase has a checkpoint for validation
- `[P]` marks tasks that genuinely have no inter-dependencies
- TDD tasks (if included) come BEFORE implementation tasks
- Setup and Foundation phases complete BEFORE any user story work

---

## Integration with Existing Workflow

SDD commands complement the existing Claude Code workflow:

| Existing command | SDD equivalent | Relationship |
|-----------------|----------------|--------------|
| `/commit` | — | Use after each SDD phase completion |
| `/create-pr` | — | Use after `/sdd-implement` to submit work |
| `/pr-review` | — | SDD specs serve as review ground truth |
| CLAUDE.md global | `CONSTITUTION.md` per-project | Constitution captures project-specific rules |

Use SDD for any feature that is:
- Non-trivial (more than a few hours of work)
- Has unclear or complex requirements
- Involves multiple user stories or components
- Requires careful architecture decisions

---

## Key Principles

1. **Spec before code** — No implementation until spec is approved
2. **Intent over implementation** — Spec never mentions tech stack
3. **Iterative refinement** — Every step has a human review point
4. **Context engineering** — Specs compress context for the AI agent
5. **Testable by default** — If it's not testable, it's not a requirement
6. **Fail fast on specs** — Catch gaps in spec, not in code review

---

## Troubleshooting

**Agent generates code that doesn't match the spec**
→ Run `/sdd-analyze` — there's likely a spec-plan inconsistency

**Spec has too many `[NEEDS CLARIFICATION]` markers**
→ Max 3 allowed in spec.md. Run `/sdd-clarify` to resolve them before planning

**Tasks are too vague**
→ Each task must include an exact file path. Split vague tasks into specific ones

**Constitution violations in plan**
→ Either adjust plan to comply, or document the justified exception

**Feature scope keeps growing during planning**
→ Return to spec.md and add to Out of Scope section. Plan only what's in spec

**Clarification questions seem excessive**
→ Max 5 questions per `/sdd-clarify` run. For low-impact items, use defaults and document in Assumptions

---

## Quick Reference Card

```
# Start a new project
/sdd-init
/sdd-constitution [principles]

# Start a new feature (full pipeline)
/sdd-specify [what you want to build and why]
/sdd-clarify
/sdd-plan [tech stack]
/sdd-analyze
/sdd-tasks
/sdd-implement

# Update constitution
/sdd-constitution [what changed and why]

# Resume after context loss
/sdd-analyze          ← re-orient: find inconsistencies
/sdd-implement resume ← continue from last checkpoint
```
