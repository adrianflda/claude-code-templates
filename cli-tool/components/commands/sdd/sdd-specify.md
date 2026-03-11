---
description: "Create a feature spec and git branch — translates a feature description into a structured spec.md with user stories, FRs, and success criteria"
argument-hint: "<feature description — what you want to build and why>"
allowed-tools: Bash(git:*), Bash(mkdir:*), Bash(date:*), Bash(printf:*), Bash(ls:*), Read, Write, Edit
---

# SDD Specify

Create feature specification for: $ARGUMENTS

## Instructions

Translate the feature description into a structured specification. Focus exclusively on WHAT and WHY — no implementation details.

### Step 1: Validate Prerequisites

```bash
ls CONSTITUTION.md 2>/dev/null && echo "EXISTS" || echo "NOT_FOUND"
ls specs/ 2>/dev/null && echo "EXISTS" || echo "NOT_FOUND"
```

If `CONSTITUTION.md` is missing, warn: "No CONSTITUTION.md found. Run `/sdd-init` first." and stop.

If `$ARGUMENTS` is empty, ask: "Please describe the feature you want to build and why."

### Step 2: Determine Branch Number

```bash
# Count existing feature specs and increment (zero-padded with printf to avoid octal issues)
EXISTING=$(ls specs/ 2>/dev/null | grep -c "^[0-9]" || echo "0")
NEXT=$((EXISTING + 1))
PADDED=$(printf "%03d" $NEXT)
```

Extract a short slug from `$ARGUMENTS`:
- Take first 4–6 significant words (skip articles: a, an, the, with, for, of)
- Lowercase, hyphenate, strip special characters
- Example: "Build user authentication with OAuth2" → `user-authentication-oauth2`

```bash
# SHORT_NAME is derived from $ARGUMENTS — example transformation:
SHORT_NAME=$(echo "$ARGUMENTS" | tr '[:upper:]' '[:lower:]' | tr -s ' ' '-' | sed 's/[^a-z0-9-]//g' | sed 's/--*/-/g' | cut -c1-40 | sed 's/-*$//')
BRANCH="${PADDED}-${SHORT_NAME}"
```

### Step 3: Create Git Branch

```bash
git checkout -b "$BRANCH"
```

If branch already exists, use `git checkout "$BRANCH"` to switch to it.

### Step 4: Create Feature Directory

```bash
mkdir -p "specs/$BRANCH"
```

### Step 5: Generate Specification

Load `CONSTITUTION.md` to understand project constraints, then write `specs/$BRANCH/spec.md`:

```markdown
# Feature Specification: [FEATURE NAME]

**Branch**: `BRANCH_VALUE`
**Created**: YYYY-MM-DD
**Status**: Draft

## Overview

[2-3 sentence summary of what this feature does and the problem it solves]

## User Scenarios & Testing

<!-- Each user story must be independently testable and deliver standalone value -->

### User Story 1 — [Brief Title] (Priority: P1)

[Describe this user journey in plain language — who does what and why]

**Why P1**: [Business value and urgency]

**Independent Test**: [How to verify this story works without other stories]

**Acceptance Scenarios**:

1. **Given** [initial state], **When** [user action], **Then** [expected outcome]
2. **Given** [initial state], **When** [user action], **Then** [expected outcome]

---

### User Story 2 — [Brief Title] (Priority: P2)

[...]

**Acceptance Scenarios**:

1. **Given** [...], **When** [...], **Then** [...]

---

### Edge Cases

- What happens when [boundary condition]?
- How does the system handle [error scenario]?

## Functional Requirements

- **FR-001**: System MUST [specific, testable capability]
- **FR-002**: System MUST [specific, testable capability]
- **FR-003**: Users MUST be able to [key interaction]

## Key Entities *(include if feature involves data)*

- **[Entity]**: [What it represents, key attributes — no implementation details]

## Success Criteria

- **SC-001**: [Measurable user-facing metric, e.g., "Users complete checkout in under 3 minutes"]
- **SC-002**: [Measurable business metric]
- **SC-003**: [Quality metric, e.g., "95% task completion rate on first attempt"]

## Assumptions

- [Reasonable assumption made where the description was ambiguous]

## Out of Scope

- [Explicitly excluded features or behaviors]
```

**Rules for filling the template:**
- Focus on WHAT users need and WHY — never HOW to implement
- Write for non-technical stakeholders
- Every requirement must be testable
- Mark genuine ambiguities with `[NEEDS CLARIFICATION: specific question]` (max 3)
- Make reasonable defaults for minor gaps — document in Assumptions
- Success criteria must be technology-agnostic and measurable

### Step 6: Quality Validation

Review the written spec against this checklist:

- [ ] No implementation details (no languages, frameworks, APIs)
- [ ] All user stories have Given/When/Then acceptance scenarios
- [ ] All functional requirements are testable
- [ ] Success criteria are measurable and technology-agnostic
- [ ] Maximum 3 `[NEEDS CLARIFICATION]` markers
- [ ] Edge cases identified
- [ ] Out of scope explicitly declared

If `[NEEDS CLARIFICATION]` markers exist, present them to the user one at a time:

```
## Clarification Needed: [Topic]

**Context**: [Quote relevant part of spec]
**Question**: [Specific question]

Suggested options:
| Option | Answer | Implications |
|--------|--------|--------------|
| A | [First answer] | [What this means] |
| B | [Second answer] | [What this means] |
| Custom | Provide your own | — |
```

Wait for answer, update spec, then present next question.

### Step 7: Update SDD Context

Update `.claude/sdd-context.md`:
- Set Active Feature to the new branch
- Update the Feature History table
- Set Spec to ✅, Plan/Tasks to (pending)

### Step 8: Report Completion

```
✅ Feature specification created!

Branch:  BRANCH_VALUE
Spec:    specs/BRANCH_VALUE/spec.md
Stories: [N] user stories (P1–PN)
FRs:     [N] functional requirements

Next steps:
  1. Review spec.md and verify it captures your intent
  2. Run /sdd-clarify to resolve any ambiguities before planning
  3. Run /sdd-plan [tech stack] when ready
```

## Key Rules

- NEVER mention tech stack, frameworks, or implementation details in spec.md
- Write as if explaining to a non-technical product manager
- Every user story must be independently testable (MVP slice)
- Priorities: scope clarity > security/privacy > UX > technical details
