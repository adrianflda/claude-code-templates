# Tasks — M2 (reoriented): Plan-with-Teeth + Agentic QA (P2·P4·P5) — v1

> **Status:** SDD tasks. Implements `plan-m2-plan-qa.v1.md`. Each task carries a **done-criterion**
> anchored to a spec invariant, TDD (genuine RED first). `[P]` = parallelizable. **Versioning:** → `.v2`.

## Task list

- **T1 [P] — Contract format + example.** Define `.quality-kernel/contracts/<id>.md` (EARS · Gherkin ·
  an `## Invariants` table with `| id | description | expected |` rows · `## QA procedure`) and an
  example `contracts/example.md` + `acceptance/example.test.mjs` (one `test('INV-… : …')` per invariant,
  asserting the exact expected value). **Done:** the example parses; each invariant has one assertion.
  *(spec INV-M2-1, D1)*

- **T2 — `contract-lint.mjs` + tests.** Extract the invariant-id set from `<id>.md` (the table) and the
  id set referenced in `<id>.test.mjs` (test names/comments); exit 1 on any orphan (id without
  assertion, or assertion citing no id), 0 when they match. **Done (RED→green):** a fixture missing one
  assertion → exit 1; a complete pair → exit 0. *(INV-M2-1, D6)*

- **T3 — `breaker-invoke.mjs` + tests.** `buildBlindInput(contractPath, {probeCmd, systemUrl})` →
  `{ qaProcedure, invariants:[{id,expected}], probeCmd, systemUrl }` and NOTHING else. CLI shells to a
  `--breaker <cmd>` passing the JSON on stdin; reads `{verdict, vectors, evidence}`; exit 0 on
  `BREAKER_PASS`, 1 on `BREAKER_FAIL`, 2 if it can't run. **Done:** a test asserts the blind input has
  no `diff`/`changed`/`reasoning`/`tests` keys (P5 boundary); a stub breaker returning FAIL → exit 1,
  PASS → exit 0. *(INV-M2-3, D2, plan §5)*

- **T4 — `breaker-gate.mjs` + tests.** Compose `qk-gate` (route+referee) with the breaker: qk-gate exit
  0 → 0; exit 3 (requiresBreaker) → run `breaker-invoke` (PASS→0, FAIL→1, can't-run→2); exit 1/2 →
  passthrough. **Done:** critical change + green referee + stub-PASS breaker → exit 0; + stub-FAIL →
  exit 1. *(INV-M2-3, D3)*

- **T5 [P] — `run-ledger.mjs` + tests.** Append `{issue, tokens, usd, wallclockMs, humanInterventions,
  verdict, ts}` to `.quality-kernel/run-ledger.jsonl`; emit the record. **Done:** a run appends one
  valid JSONL row. *(INV-M2-6 partial, D7)*

- **T6 — P4-anchor regression.** Extend the acceptance-oracle test: a coder suite that passes but whose
  value contradicts a Contract invariant → the acceptance suite fails. **Done:** the test is green
  (proves the anchor catches paraphrase). *(INV-M2-2)*

- **T7 — genuine-RED harness.** A small script/proc that, for each invariant, reverts the implemented
  behavior and asserts its acceptance test goes red. **Done:** demonstrated on the example Contract.
  *(INV-M2-5)*

- **T8 [P] — `/gate` + docs.** A `/plan-qa` (or extend `/gate`) usage note + README section describing
  the Contract → referee(acceptance) → breaker-gate → ledger flow, and that the live breaker points to
  the host `pipeline-breaker`; stub breaker for tests. **Done:** docs updated; `config/tools.example.json`
  shows `acceptance`. *(spec §2)*

- **T9 — plan-gate wiring note.** Document invoking `adversarial-critic` on the plan + `/sdd-analyze`
  before tasks; a fixture plan with an injected CRÍTICO is used to show the block (procedure, not a unit
  test since it invokes an agent). **Done:** procedure documented + a lint hook stub. *(INV-M2-4, D4)*

- **T10 — dogfood (INV-M2-6, prove-or-kill).** Choose ONE real change in THIS repo (self-hosting),
  author its Contract, run contract-lint → referee(acceptance) → breaker-gate → run-ledger end to end,
  record cost. **Done:** a real green at a recorded, acceptable cost — OR the tripwire fires and we stop.
  *(This is the milestone's kill-condition; the live-LLM breaker step is greenlit by the human as it
  spends tokens / touches a live system.)*

## Order & parallelism
T1 → T2; T1 → T3 → T4; T5, T8 in parallel; T6, T7 after T1; T9 [P]; **T10 last** (needs T2–T7).

## Definition of done (M2)
T1–T9 green by `node --test` (the unit-provable invariants INV-M2-1…5); **T10** delivers one real
dogfooded green with recorded cost (INV-M2-6) or a documented tripwire stop. = the M2 spec's DoD.
