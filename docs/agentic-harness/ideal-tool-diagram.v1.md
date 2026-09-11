# The Ideal Tool — architecture, trust model & honest state (v1)

> A conceptual companion to `process-diagram.v1.md` (which shows the end-to-end *flow*). This shows
> **what the tool IS** (one spine, three layers, three oracles), **what the gate actually does** to a
> change, and **the honest state** after the M0 rebuild + hardening. Versioning: never overwrite → `.v2`.

## 1. One spine, three layers, three oracles

```mermaid
flowchart TB
  IN([Any input]) --> D{Two doors}
  D -->|feature| A[elicit / analyze]
  D -->|issue| B[detect / reproduce / RCA]
  A --> SPINE
  B --> SPINE

  subgraph SPINE ["ONE spine: understand → specify → design → implement → verify → integrate → release → operate → learn"]
    direction LR
    S1[specify] --> S2[design] --> S3[implement] --> S4[verify] --> S5[release] --> S6[learn]
  end

  SPINE --> OUT([verified, shipped])
  S6 -. every fixed bug becomes a permanent fixture .-> S4

  %% the three layers act ON the spine
  METHOD["SDD — the METHOD<br/>constitution → spec → plan → tasks<br/>(governs WHAT + how much rigor)"] -. governs .-> SPINE
  ENGINE["forge — the ENGINE<br/>specifier→coder→cleaner→architect→hardener→qa<br/>(does the WORK)"] -. executes .-> SPINE
  TEETH["gates — the TEETH<br/>route · referee · breaker · fixtures<br/>(make DONE mean something)"] -. verify .-> SPINE

  %% trust rests on three oracles only
  subgraph ORACLES [The only trusted oracles]
    H([HUMAN<br/>owns intent + the contract]):::o
    P([LIVE PROBE<br/>a fact from the real system — M2 breaker]):::o
    R([RE-EXECUTION<br/>re-run verification, read the real result — referee]):::o
  end
  H -. approves contract / test changes .-> TEETH
  P -. independent fact on critical surface .-> TEETH
  R -. mechanical done .-> TEETH
  classDef o fill:#eef,stroke:#66a;
```

**Read it:** any input enters by one of two doors, then travels a single lifecycle spine. Three layers
act on that spine — **SDD** decides *what* and *how much rigor*, **forge** does the work, **gates** make
"done" real. Trust never rests on an LLM's self-report: only the **human** (intent/contract), a **live
probe** (fact), and **re-execution** (mechanical done) are believed. "Independence ≠ another LLM."

## 2. What a change actually goes through (the gate we built)

```mermaid
flowchart TD
  C([committed change: base..head]) --> RT["route.mjs — deterministic tier<br/>diff base..head · config from base ref"]
  RT --> RF

  subgraph RF ["referee.mjs — verify by re-execution"]
    PRE{"preconditions:<br/>every changed path is<br/>production / declared-test / manifest?"}
    PRE -->|no| IND2>"exit 2 — indeterminate<br/>(declare it / ambiguous / symlink / collision)"]
    PRE -->|yes| OV["build trusted tree:<br/>FULL BASE + overlay head PRODUCTION<br/>(+ the PR's modified tests — Option B)"]
    OV --> R1["run 1: base harness × head production"]
    OV --> R2["run 2: head as-is"]
    OV --> R3["acceptance oracle (optional, independent)"]
    R1 --> INTEG{"both green + harness unmutated?"}
    R2 --> INTEG
    R3 --> INTEG
  end

  INTEG -->|no, broke covered code| F>"exit 1 — blocked (mechanical)"]
  INTEG -->|yes| Q{"critical surface<br/>OR a test was changed?"}
  Q -->|no| PASS>"exit 0 — verified green"]
  Q -->|yes| REV>"exit 3 — needs human / M2 breaker review"]

  classDef bad fill:#fdd,stroke:#c33; classDef ok fill:#dfd,stroke:#3a3; classDef warn fill:#ffd,stroke:#ca3;
  class F,IND2 bad; class PASS ok; class REV warn;
```

## 3. The honest verdict boundary (what a green means)

```mermaid
flowchart LR
  subgraph MECH [Mechanically ENFORCED]
    M1[break covered code<br/>without touching its test → blocked]
    M2b[neuter/delete a test → visible + routed]
    M3[tamper the harness<br/>runner/helper/golden/symlink/config → indeterminate]
  end
  subgraph HUM ["HUMAN review — exit 3"]
    U1[any test change = contract change]
    U2[critical surface touched]
  end
  subgraph M2D ["DECLARED — the M2 live breaker's job"]
    D1[in-process oracle subversion<br/>monkeypatch assert / process.exit 0]
    D2[gate fingerprinting]
    D3[execution-trust: build/codegen runs overlaid code]
    D4[no baseline tests]
  end
  MECH --> V([a green = 'the committed suite re-executed clean,<br/>and test changes were surfaced for review'<br/>NOT 'the code cannot be malicious'])
  HUM --> V
  M2D -. closed only by M2 .-> V
```

## 4. Build state (honest)

```mermaid
flowchart LR
  M0["M0 · make green real<br/>referee + red-team"]:::done --> M1["M1 · deterministic routing<br/>route.mjs"]:::done
  M1 --> M2["M2 · live breaker + dogfood 1 issue<br/>PROVE-OR-KILL"]:::next
  M2 --> M3["M3 · depth + metrics"]:::todo
  M3 --> M4["M4 · SDD-native"]:::todo --> M5["M5 · scale/targets"]:::todo --> M6["M6 · consolidation/UX"]:::todo
  classDef done fill:#dfd,stroke:#3a3; classDef next fill:#ffd,stroke:#ca3; classDef todo fill:#eee,stroke:#999;
```

- **M0 / M1 — done, hardened by execution** (breaker score 25 → converged; every attack a regression test).
- **M2 — next, and the critical one:** the **live breaker** is the only thing that closes the declared
  limits in §3; it is also the **prove-or-kill** dogfood (one real issue end-to-end, cost measured).
- **M3–M6 — designed (frozen docs), not started.**
