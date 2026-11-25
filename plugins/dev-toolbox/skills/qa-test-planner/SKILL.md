---
name: qa-test-planner
description: Generate comprehensive test plans, manual test cases, regression test suites, and bug reports for QA engineers. Includes Figma MCP integration for design validation.
disable-model-invocation: true
---

# QA Test Planner

A comprehensive skill for QA engineers to create test plans, generate manual test cases, build regression test suites, validate designs against Figma, and document bugs effectively.

> **Activation:** Manual only (`disable-model-invocation: true`) — run `/dev-toolbox:qa-test-planner`.

---

## Quick Start

**Create a test plan:**
```
"Create a test plan for the user authentication feature"
```

**Generate test cases:**
```
"Generate manual test cases for the checkout flow"
```

**Build regression suite:**
```
"Build a regression test suite for the payment module"
```

**Validate against Figma:**
```
"Compare the login page against the Figma design at [URL]"
```

**Create bug report:**
```
"Create a bug report for the form validation issue"
```

---

## Quick Reference

| Task | What You Get | Time |
|------|--------------|------|
| Test Plan | Strategy, scope, schedule, risks | 10-15 min |
| Test Cases | Step-by-step instructions, expected results | 5-10 min each |
| Regression Suite | Smoke tests, critical paths, execution order | 15-20 min |
| Figma Validation | Design-implementation comparison, discrepancy list | 10-15 min |
| Bug Report | Reproducible steps, environment, evidence | 5 min |

---

## How It Works

```
Your Request
    │
    ▼
┌─────────────────────────────────────────────────────┐
│ 1. ANALYZE                                          │
│    • Parse feature/requirement                      │
│    • Identify test types needed                     │
│    • Determine scope and priorities                 │
├─────────────────────────────────────────────────────┤
│ 2. GENERATE                                         │
│    • Create structured deliverables                 │
│    • Apply templates and best practices             │
│    • Include edge cases and variations              │
├─────────────────────────────────────────────────────┤
│ 3. VALIDATE                                         │
│    • Check completeness                             │
│    • Verify traceability                            │
│    • Ensure actionable steps                        │
└─────────────────────────────────────────────────────┘
    │
    ▼
QA Deliverable Ready
```

---

## Commands

### Natural Language

| Request | Output |
|---------|--------|
| "Create test plan for {feature}" | Complete test plan document |
| "Generate {N} test cases for {feature}" | Numbered test cases with steps |
| "Build smoke test suite" | Critical path tests |
| "Compare with Figma at {URL}" | Visual validation checklist |
| "Document bug: {description}" | Structured bug report |

---

## Core Deliverables

### 1. Test Plans
- Test scope and objectives
- Testing approach and strategy
- Environment requirements
- Entry/exit criteria
- Risk assessment
- Timeline and milestones

### 2. Manual Test Cases
- Step-by-step instructions
- Expected vs actual results
- Preconditions and setup
- Test data requirements
- Priority and severity

### 3. Regression Suites
- Smoke tests (15-30 min)
- Full regression (2-4 hours)
- Targeted regression (30-60 min)
- Execution order and dependencies

### 4. Figma Validation
- Component-by-component comparison
- Spacing and typography checks
- Color and visual consistency
- Interactive state validation

### 5. Bug Reports
- Clear reproduction steps
- Environment details
- Evidence (screenshots, logs)
- Severity and priority

---

## Anti-Patterns

| Avoid | Why | Instead |
|-------|-----|---------|
| Vague test steps | Can't reproduce | Specific actions + expected results |
| Missing preconditions | Tests fail unexpectedly | Document all setup requirements |
| No test data | Tester blocked | Provide sample data or generation |
| Generic bug titles | Hard to track | Specific: "[Feature] issue when [action]" |
| Skip edge cases | Miss critical bugs | Include boundary values, nulls |

---

## Verification Checklist

**Test Plan:**
- [ ] Scope clearly defined (in/out)
- [ ] Entry/exit criteria specified
- [ ] Risks identified with mitigations
- [ ] Timeline realistic

**Test Cases:**
- [ ] Each step has expected result
- [ ] Preconditions documented
- [ ] Test data available
- [ ] Priority assigned

**Bug Reports:**
- [ ] Reproducible steps
- [ ] Environment documented
- [ ] Screenshots/evidence attached
- [ ] Severity/priority set

---

## References

Read [references/deep-dives.md](references/deep-dives.md) when you need a full template: test case structure, test plan template, bug report, Figma MCP validation, regression suites, execution tracking, QA workflow, best practices, and worked examples.
