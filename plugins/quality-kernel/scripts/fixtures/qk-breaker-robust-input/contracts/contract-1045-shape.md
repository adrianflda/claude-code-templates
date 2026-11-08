# Contract — sanitized fixture reproducing the real 1045-static-files contract's shape

> Committed fixture for specs/qk-breaker-robust-input/spec.md. Reproduces, with no real hosts/IPs
> (everything below uses example.com), exactly the three shape features the real failing contract
> has that today's breaker-invoke.mjs/contract-lint.mjs cannot parse: numbered/parenthetical
> headings, the literal `## External Observable Invariants` heading, and bold ids with a trailing
> parenthetical (`**EO-6 (re-run)**`) plus a probe-command cell containing a literal pipe.

## 1. Context / problem

Static assets must resolve under `/static2/` on the login page.

## 2. Non-goals (explicitly out of scope)

Styling correctness beyond asset resolution.

## 3. EARS acceptance criteria

- THE SYSTEM SHALL serve every static asset referenced by the login page under a `/static2/` path.

## 4. Gherkin scenarios

```gherkin
Scenario: login page assets resolve
  Given the login page at http://example.com/admin/login/
  Then every static href is a bare /static2/ path
```

## 5. End-to-end QA procedure (UI-only — browser, no internal API)

1. Navigate to http://example.com/admin/login/ and confirm it is styled (no broken-image icons).
2. View source and confirm every `<link>`/`<script>` static href starts with `/static2/`.

### 5.1 Steps runnable today

Step 1 and 2 above.

### 5.2 Steps that need a staff account

None for this fixture.

## 6. External Observable Invariants

| ID | Predicate | Probe command | Status today |
|---|---|---|---|
| **EO-0** | every static href on the login page is a bare `/static2/` path | `curl -s http://example.com/admin/login/ \| grep -c 'href="/static2/'` | RED |
| **EO-6 (re-run)** | running collectstatic twice yields byte-identical output | `diff <(curl -s http://example.com/static2/manifest.json) <(curl -s http://example.com/static2/manifest.json \| jq .)` | not yet probeable |

## 7. Rollback

Revert the static-files change; no data migration involved.
