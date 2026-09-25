# Blind breaker

This tool exists to answer one question: **does the live system actually hold the
invariants the contract claims?**

It is deliberately starved of context. It receives:

- the contract (`--contract=path.json`) — acceptance criteria and declared invariants;
- a live base URL (`--base=https://…`).

It never receives the diff, the implementation notes, or any reviewer's opinion.
Everything it reports was produced by executing a request against the running
system, and every verdict quotes the response it saw.

For each declared invariant it derives **falsifying vectors** — the hostile
variants a happy-path test does not try: trailing-slash and case variants,
`HEAD` instead of `GET`, an AI-crawler user agent, a cache-busting query string,
and a request with no `Accept: text/html`. An invariant that only survives the
happy path is reported as broken.

Exit codes:

| code | meaning |
| ---- | ------- |
| `0`  | `BREAKER_PASS` — every vector failed to falsify the contract |
| `1`  | `BREAKER_FAIL` — at least one vector falsified an invariant |
| `2`  | `BREAKER_INCONCLUSIVE` — the target could not be reached or the contract is unusable |

`BREAKER_INCONCLUSIVE` is never treated as a pass.
