# Software Lifecycle Backbone — v1 (FROZEN)

> **Status:** FROZEN. This is the spine of the agentic dev/issue-resolution harness.
> **Versioning rule:** never overwrite. Changes go into `lifecycle-backbone.v2.md`,
> `.v3.md`, … Each version is immutable once written.
> **Grounded in:** SWEBOK v4.0 (IEEE, Oct 2024, 18 knowledge areas incl. new
> Architecture / Operations / Security), ISO/IEC/IEEE 12207:2017 (software life
> cycle processes), the DevOps loop + DORA/Accelerate, and ITIL 4 + Google SRE
> (incident/problem management) for the issue-resolution flow.

There are **two flows** that share a common spine and differ only at the front and
back ends: **A — Development** (new feature/greenfield) and **B — Issue resolution**
(bug/incident). No stage is omitted; how *much* of each applies varies (that is what
the risk/tier router decides).

---

## FLOW A — Development

### 1. Inception / Framing (before building)
- **1.1 Problem framing & goal** — the "why", the value, stakeholders.
- **1.2 Requirements elicitation** — gather from users / systems / business.
- **1.3 Analysis & specification** — functional + **non-functional** (performance,
  security, accessibility, reliability), with **acceptance criteria**.
- **1.4 Requirements validation** — is it the right thing? feasibility, ambiguity resolved.
- **1.5 Planning & estimation** — prioritization, task breakdown, **risk assessment**.

### 2. Design
- **2.1 Architecture** — structure, boundaries, technology decisions, **ADRs** *(SWEBOK v4 new KA)*.
- **2.2 Detailed design** — interfaces, data models, **contracts**.
- **2.3 Threat modeling / security** *(SWEBOK v4 new KA)* — shift-left.
- **2.4 Test strategy** — how correctness will be proven (test-first mindset).

### 3. Construction
- **3.1 Implementation / coding** *(SWEBOK: Software Construction)*.
- **3.2 Unit testing** — TDD / genuine RED.
- **3.3 Code review + static analysis**.
- **3.4 Continuous integration** — merge, build.

### 4. Verification & Validation (two distinct things)
- **4.1 Integration testing**.
- **4.2 System / E2E testing**.
- **4.3 Non-functional testing** — load, security, accessibility, reliability.
- **4.4 Acceptance** — **Verification** (built it right?) vs **Validation** (built the right thing?).

### 5. Transition / Release
- **5.1 Release engineering** — packaging, versioning, changelog.
- **5.2 Deployment** — strategy (canary/blue-green), **config-by-target** (local/staging/prod).
- **5.3 Post-deploy verification** — smoke tests in the real target.

### 6. Operation & Evolution
- **6.1 Operations** *(SWEBOK v4 new KA)* — running the system.
- **6.2 Monitoring & observability** — metrics, logs, traces, **SLOs**.
- **6.3 Maintenance** — the **4 types**: corrective, adaptive, perfective, preventive.
- **6.4 Retrospective / continuous improvement** — learning that feeds back into stage 1.

### ⟳ Cross-cutting (run through ALL stages — ISO 12207 management + SWEBOK)
Configuration & change management (version control, traceability) · Quality assurance ·
Project & risk management · Documentation · Measurement.

---

## FLOW B — Issue resolution (bug/incident)

Own front-end, then **converges** into Flow A's spine:

- **B.1 Detection / report** — from monitoring, a user, or a failing test.
- **B.2 Logging & triage** — categorize, **prioritize by severity/impact** *(ITIL)*.
- **B.3 Reproduction** — make the bug reproducible *(the engineering crux; no reliable fix without it)*.
- **B.4 Diagnosis / root-cause analysis (RCA)** — the heart of *problem management*; "5 whys".
- **B.5 Immediate mitigation** *(incidents only)* — workaround / restore service **first** *(SRE)*.
- **B.6 → CONVERGE:** the designed fix **re-enters Flow A** (specify → design → implement → V&V → release).
- **B.7 Regression prevention** — write **the test that would have caught it** (canary fixture).
- **B.8 Post-mortem** — **blameless**, capture learnings, feed back.
- **B.9 Closure**.

---

## Governing observation

> Both flows share a common spine — *understand → specify → design → implement →
> verify → integrate → release → operate → learn* — and differ only at the **front-end**
> (elicit/analyze for features vs. detect/reproduce/RCA for issues) and the **back-end**
> (retrospective vs. post-mortem + regression fixture).

Design implication for the harness: **one spine of stages, two entry doors** (feature
vs. issue). No stage is skippable; the risk/tier router decides *how much* of each applies.
