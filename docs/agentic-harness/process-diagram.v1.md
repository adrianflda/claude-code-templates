# Final Process Diagram — v1 (FROZEN)

> **Status:** FROZEN reference. The end-state (M6) flow of the harness: SDD is the method,
> forge is the engine, the deterministic gates are the teeth. **Versioning:** never overwrite → `.v2`.

```mermaid
flowchart TD
  IN([Input: issue OR feature]) --> DOOR{Entry door}
  DOOR -->|feature| ELICIT[Elicit / analyze]
  DOOR -->|issue| REPRO[Detect / reproduce / RCA]
  ELICIT --> SPEC
  REPRO --> SPEC

  subgraph SDD [SDD method — governed by the Constitution]
    SPEC["Spec  = forge specifier<br/>EARS + observable invariants + acceptance"] --> PLAN["Plan  = forge architect<br/>design + ADRs"]
    PLAN --> ROUTE{{"route.mjs<br/>blast-radius / tier<br/>+ decompose?"}}
    ROUTE --> TASKS["Tasks<br/>task + guardrails + done"]
  end

  ROUTE -->|epic| DECOMP[Decompose + freeze contract]
  DECOMP --> LANES["Parallel lanes ×N<br/>each = the pipeline"]
  ROUTE -->|single unit| TASKS
  TASKS --> PIPE

  subgraph PIPE [forge engine — per unit of work]
    CODER["coder  (test-first RED)"] --> CLEAN[cleaner] --> HARD["hardener  (mutation)"] --> QAR["qa  (UI / live)"]
  end

  PIPE --> GATES
  LANES --> PIPE
  PIPE --> INTEG[Integration gate]
  INTEG --> GATES

  subgraph GATES [Deterministic gates — the teeth]
    REF[["referee<br/>re-executes · fail-closed"]]
    BRK[["breaker<br/>live oracle · on critical surface"]]
    FIXG[["regression fixtures<br/>from real past bugs"]]
    PP[["pre-push panel"]]
  end

  GATES --> HUMAN{{"Human checkpoints — by blast-radius<br/>contract · irreversible action · escalation-on-cap"}}
  HUMAN --> SHIP["Ship  PR / deploy<br/>config-by-target (local/staging/prod)"]
  SHIP --> POST[Post-deploy verify]
  POST --> MEAS[("Measurement<br/>cost · false-green · gate-execution")]
  MEAS --> LEARN["Retrospective / post-mortem<br/>→ new permanent regression fixture"]
  LEARN -. feeds .-> FIXG
  LEARN -. next .-> IN
```

**How to read it:** one door for any input → the SDD spine (governed by the Constitution)
defines *what* and routes *how much rigor* → forge runs the per-unit pipeline (an epic fans
out into parallel lanes + an integration gate) → the deterministic gates make "done" real →
the human is touched only at blast-radius checkpoints → ship (config-by-target) → measure →
learn, and every fixed bug becomes a permanent fixture that feeds the gates.

> We are currently building the **`referee`** node (M0) — the first tooth. Everything else
> is designed (frozen v1 docs) and built in order M0→M6.
```
