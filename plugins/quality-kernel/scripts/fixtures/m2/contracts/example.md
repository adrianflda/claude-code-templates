# Contract — example (add)

> The human-approved, machine-checkable statement of "what correct means". The acceptance suite
> (`acceptance/example.test.mjs`) asserts each invariant's EXACT value; `contract-lint.mjs` proves the
> two stay in lockstep.

## Acceptance criteria (EARS)
- The system SHALL return the integer sum of two integer inputs.
- IF either input is not an integer THEN the system SHALL return `{ code: 400 }`.

## Gherkin
Scenario: add two integers
  Given a = 2 and b = 3
  When add(a, b) is called
  Then the result is 5

## Invariants
| id | description | expected |
| INV-ADD-1 | add(2, 3) | 5 |
| INV-ADD-2 | add('x', 3).code | 400 |

## QA procedure
1. Call add(2, 3) and expect exactly 5.
2. Call add('x', 3) and expect a result whose `code` is exactly 400.
