---
description: "Generate technical plan from an approved spec — produces plan.md, research.md, data-model.md, and API contracts"
argument-hint: "<tech stack: language, framework, database, infrastructure>"
allowed-tools: Bash(git:*), Bash(mkdir:*), Bash(date:*), Read, Write, WebSearch
---

# SDD Plan

Generate technical plan for current feature: $ARGUMENTS

## Instructions

Translate the approved spec into a concrete technical design. Focus exclusively on HOW — tech stack, architecture, data model, contracts.

### Step 1: Detect Active Feature

```bash
BRANCH=$(git branch --show-current)
```

Verify `$BRANCH` matches `NNN-feature-name`. Load from `specs/$BRANCH/`:

- **Required**: `spec.md`
- **Required**: `CONSTITUTION.md` (project root)
- **Load if exists**: `specs/$BRANCH/clarifications.md`

If `spec.md` is missing, STOP: "Run `/sdd-specify` first to create the feature spec."

Confirm spec has no remaining `[NEEDS CLARIFICATION]` markers. If any remain, suggest running `/sdd-clarify` first.

### Step 2: Parse Tech Stack from $ARGUMENTS

Extract from `$ARGUMENTS`:
- **Language** (TypeScript, Python, Go, etc.)
- **Framework** (NestJS, FastAPI, Gin, etc.)
- **Database** (PostgreSQL, MongoDB, DynamoDB, etc.)
- **Infrastructure** (AWS Lambda, Docker, Vercel, etc.)

If `$ARGUMENTS` is empty or incomplete, ask: "What's your tech stack? (e.g., TypeScript, Express, PostgreSQL, Docker)"

### Step 3: Research Phase (if needed)

Use WebSearch for:
- Current stable versions of specified libraries
- Best practices for chosen tech stack + the problem domain
- Known pitfalls or compatibility issues

Document findings in `research.md`.

### Step 4: Generate plan.md

Write `specs/$BRANCH/plan.md`:

```markdown
# Technical Plan: [FEATURE NAME]

**Branch**: NNN-feature-name
**Created**: YYYY-MM-DD
**Status**: Draft

## Tech Stack

| Layer | Technology | Version | Rationale |
|-------|-----------|---------|-----------|
| Language | [e.g., TypeScript] | [5.x] | [Why chosen] |
| Framework | [e.g., NestJS] | [10.x] | [Why chosen] |
| Database | [e.g., PostgreSQL] | [16.x] | [Why chosen] |
| Testing | [e.g., Jest] | [29.x] | [Why chosen] |
| Infrastructure | [e.g., Docker] | [24.x] | [Why chosen] |

## Architecture Overview

[Brief description of the chosen architecture pattern and why it fits this feature]

## Project Structure

```
[Project root]
├── src/
│   ├── [domain/]        ← [description]
│   ├── [services/]      ← [description]
│   ├── [handlers/]      ← [description]
│   └── [shared/]        ← [description]
├── tests/
│   ├── unit/
│   ├── integration/
│   └── contract/
├── [config files]
└── [infra files]
```

## Architecture Decisions

### AD-001: [Decision Title]
**Decision**: [What was decided]
**Rationale**: [Why — reference Constitution if applicable]
**Alternatives rejected**: [What else was considered and why not]
**Trade-offs**: [What we're accepting]

### AD-002: [Decision Title]
...

## Constitution Compliance

- **Principle I**: ✅/❌ [How this plan complies with each principle]
- **Technical Constraints**: ✅/❌ [Compliance check]
- **Quality Gates**: Defined above

## Dependency Map

External services or APIs required:
- [Service]: [Why needed, how integrated, fallback if unavailable]

Internal dependencies:
- [Module/Package]: [Version, purpose]
```

### Step 5: Generate data-model.md (if feature involves data)

Write `specs/$BRANCH/data-model.md`:

```markdown
# Data Model: [FEATURE NAME]

## Entities

### [EntityName]

| Field | Type | Required | Description | Constraints |
|-------|------|----------|-------------|-------------|
| id | UUID | Yes | Primary key | Auto-generated |
| [field] | [type] | [Y/N] | [description] | [constraints] |

**Relationships**: [EntityName] has-many [OtherEntity] via [field]

### [EntityName2]
...

## State Machines *(if applicable)*

### [EntityName].status

```
[pending] → [active] → [completed]
              ↓
           [cancelled]
```

Transitions:
- pending → active: when [condition]
- active → completed: when [condition]

## Migration Strategy

[How to handle database schema changes in this feature]
```

### Step 6: Generate contracts/ (if feature involves APIs)

Create `specs/$BRANCH/contracts/` directory. Write API contract files for each endpoint:

```markdown
# API Contract: [Endpoint Group]

## POST /[resource]

**Purpose**: [What this endpoint does]

**Request**:
```json
{
  "field": "type — description"
}
```

**Response 200**:
```json
{
  "id": "uuid",
  "field": "value"
}
```

**Error Responses**:
- `400`: [When this occurs]
- `401`: [When this occurs]
- `404`: [When this occurs]
- `422`: [Validation failure format]
```

### Step 7: Generate research.md

Write `specs/$BRANCH/research.md` with findings from Step 3:

```markdown
# Research: [FEATURE NAME]

## Library Versions (verified: YYYY-MM-DD)

| Package | Latest Stable | Notes |
|---------|--------------|-------|
| [package] | [version] | [notes] |

## Architecture Research

[Key findings, best practices, patterns considered]

## Known Risks

- [Risk]: [Mitigation strategy]
```

### Step 8: Update SDD Context

Update `.claude/sdd-context.md`:
- Set Plan to ✅
- List artifacts generated

### Step 9: Report

```
✅ Technical plan generated!

Artifacts created:
  specs/NNN-feature-name/plan.md         ← architecture decisions, file structure
  specs/NNN-feature-name/research.md     ← library versions, best practices
  specs/NNN-feature-name/data-model.md   ← entities, relationships, state machines
  specs/NNN-feature-name/contracts/      ← API specifications

Tech stack: [summary]
Architecture: [one-line description]

Next steps:
  1. Review plan.md — especially Architecture Decisions
  2. Run /sdd-analyze to verify spec ↔ plan consistency
  3. Run /sdd-tasks to generate the implementation task breakdown
```

## Key Rules

- Architecture decisions MUST reference Constitution compliance
- Every entity in data-model must trace back to a requirement in spec.md
- API contracts must cover success + all error cases
- Use exact version numbers (research actual current stable versions)
