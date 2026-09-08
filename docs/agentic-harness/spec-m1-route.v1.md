# Spec — M1: Deterministic Risk/Tier Router (`route.mjs`) — v1 (FROZEN)

> **Status:** FROZEN spec (SDD). Scope = milestone **M1** of `build-sequence.v1.md`
> ("make rigor deterministic"). Governed by `constitution.v1.md` (esp. P4 rigor∝blast-radius,
> P5 fail-closed). **Versioning:** never overwrite → `spec-m1-route.v2.md`.

## 1. Purpose
Decide **how much rigor** a change gets by a **mechanism**, not model judgment (Constitution
P4). Today tier/blast-radius is prose in `forge.md` that the LLM is trusted to honor, and the
config it should read (`critical-surface.json`) does not exist. `route.mjs` makes the risk
classification a deterministic function so a critical change (auth, tenancy, money, migrations,
PHI…) **can never be routed down a cheap/autonomous lane** by a model mis-judging it.

## 2. What it does (functional requirements)
- **FR1 — Resolve the change.** `route.mjs --repo <dir> --base <ref>` → changed files via
  `git diff --name-only <base>...HEAD`; or accept `--changed <fileA,fileB,…>` for testing.
- **FR2 — Load the surface config.** Read `.quality-kernel/critical-surface.json`
  (`criticalGlobs`, `safeGlobs`) from the repo.
- **FR3 — Classify (the floor).**
  - any changed path matches a `criticalGlob` → `tierFloor = "critical"`, `requiresBreaker = true`;
  - else if **every** changed path matches a `safeGlob` → `tierFloor = "trivial"`;
  - else → `tierFloor = "standard"`.
- **FR4 — Fail-closed (Constitution P5).** Config absent/unreadable → any change with a
  non-safe path is treated as **critical** (fail-safe default). No config ≠ no rigor.
- **FR5 — Floor semantics.** Optional `--proposed <trivial|standard|critical>`; the returned
  `tier = max(tierFloor, proposed)`. A proposal may only **raise**, never lower the floor.
- **FR6 — Typed verdict.** Emit `{ tierFloor, tier, requiresBreaker, criticalFiles, reason }`.
  Exit `0` on a successful classification (including critical); exit `2` only on an operational
  error (e.g. cannot run git) — fail-closed.

## 3. Non-functional
- Deterministic, pure (same inputs → same verdict); local-only; language/stack-agnostic (globs).
- Node/`.mjs` + `node --test`, consistent with `referee.mjs`.

## 4. Observable invariants (the contract — proven by execution)
- **INV-R1** — a change touching a `criticalGlob` → `tierFloor="critical"`, `requiresBreaker=true`.
- **INV-R2** — a change touching only `safeGlobs` → `tierFloor="trivial"`.
- **INV-R3** — config absent → a non-safe change → `critical` (fail-safe).
- **INV-R4** — floor holds: `--proposed trivial` on a critical change stays `critical`;
  `--proposed critical` on a trivial change → `critical` (raised).
- **INV-R5 (ground-truth replay — the kill-condition, G6):** run `route.mjs` over the REAL
  changed-file sets of two past bugs — the PHI/IDOR fix (`app/controllers/copdMonitoringWebsocket.controller.ts`,
  `app/services/copdMonitoringSession.ts`) and the inhaler #560 regression — against a
  hand-authored `critical-surface.json`; **both must classify `critical`.** If either does not,
  the globs/approach are wrong and must be fixed before M1 is done.

## 5. Out of scope (later milestones)
Recursion into epic decomposition (M5); config-by-target strictness profiles (M5); wiring
`route.mjs` into the forge pipeline / the referee (a later integration step). M1 delivers the
standalone classifier + its validation.

## 6. Definition of done (M1 GREEN)
INV-R1…INV-R5 pass by execution — above all **INV-R5**: the classifier forces `critical` on the
two real past bugs. When green, rigor is a mechanism, not prose.
