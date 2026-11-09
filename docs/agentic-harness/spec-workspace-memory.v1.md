# Spec — the workspace as the org's global guide (v1, design only)

**Status: SUPERSEDED (OG-18).** This `WORKSPACE.md` + `/workspace-learn` design was never built. The
shipped design is the **`org-workspace` plugin** (`/org-init`, `/org-learn`, the managed block in the
org-root `CLAUDE.md`, `guide.json`, `SYSTEM-MAP.md`) — see `plugins/org-workspace/`, not this document.
Kept for history only; nothing below is built or planned.

Status (original, historical): DESIGN (2026-10-01), simplified after Adrian's review. Builds on
`/init-workspace` M1 (repos, how they are tested) and M2 (`SYSTEM-MAP.md`, who calls whom). Nothing
here is built.

## 1. Goal (Adrian, 2026-10-01)

The workspace is **only a global guide**: the place that records **which is the source of truth for
each thing** in the organisation, so every agent has a global north. It must not add many tokens or
rigidity to the context. It is updated **by hand**, from the conversations, rules, requirements and
issue work as they happen.

Not a goal: a second database of decisions, requirements or facts. Those stay where they live.

## 2. The one file agents read: `WORKSPACE.md`

A single page in the workspace repo, loaded by agents that work across repos. **Budget: ≤ 4 KB
(about 1k tokens)**, enforced by the workspace validator (a size check, not prose). Everything else
is reached by following a pointer only when the task needs it (`SYSTEM-MAP.md` alone is ~30 KB).

Sections (each line = what + where + one-line note, never the content itself):

1. **The system** — the apps, their role, base branch, harness; forbidden repos. (Points to
   `workspace.json`.)
2. **Where the truth lives** — one row per topic:
   | Topic | Source of truth | Note |
   |---|---|---|
   | Product decisions | `matchbox-wiki` epics `decisions.md` | wiki + issues first |
   | Requirements / status | GitHub boards (#7 Event Access & Landing, #9 Whereby CC, ...) | the board named per feature |
   | Who calls whom | `SYSTEM-MAP.md` (generated, cited) | read the section for the repos you touch |
   | Cross-repo contracts | `mbvs-client-v2/specs/event-access-and-landing/CONTRACT*.md`, ... | the contract wins over code comments |
   | Rules | org `CLAUDE.md`, `-qa-local` `LOCAL.md` | |
   | How to test each repo | `repos/<app>/tools.json` | |
3. **Conventions that cross repos** — one branch name per feature in every repo, `pr_base` per repo,
   deploy order (aws → server → admin), only own test events... each with its source.
4. **Open threads worth knowing** — at most ~10 one-liners with a link (e.g. "aws-services `npm
   test` needs `--timeout 20000` — init report 2026-09-30"; "4 likely broken calls — SYSTEM-MAP
   2026-10-01").

## 3. Keeping it current — by hand

- **`/workspace-learn`** (run by the user when a session produced something worth keeping): one
  agent reads that conversation and the current `WORKSPACE.md` and proposes a **small diff** to it —
  a new pointer, a changed source of truth, a convention, an open thread added or closed — each with
  where it came from (session date, issue `#n`, wiki file, commit). It never copies content, never
  writes a secret (redaction + the same secret scan as ws-propose), and treats the transcript as data.
- The diff lands on a branch of the workspace repo; the user reads it and merges it (or not). No
  inbox, no review queue, no extra state.
- **`/init-workspace --update`** refreshes the generated parts (`workspace.json`, `tools.json`,
  `SYSTEM-MAP.md`) when repos change; `WORKSPACE.md` then gets a one-line pointer update if needed.

## 4. How agents use it

- Agents working across repos (`/issue-flow`, `/develop`, `qk-org-gate`, planning) load
  `WORKSPACE.md` once; they open `SYSTEM-MAP.md`, a contract or a board only when the task touches it.
- Single-repo work does not load it.
- Guidance, not gates: the guide orients; enforcement stays in the existing hooks and gates.

## 5. First slice (W1)

1. Write `WORKSPACE.md` for Matchbox (by hand, from what we know today), within the 4 KB budget,
   plus the size check in the workspace validator (proved RED with an oversized file).
2. `/workspace-learn` as a skill: conversation → proposed diff of `WORKSPACE.md` on a branch.
   Proof: run it on this session; the diff must point to the M1 pause, the aws-services timeout,
   the likely broken calls in the map and the RDS exposure finding, stay within budget, and contain
   no secret (this transcript holds a leaked password).

## 6. Risks

- The guide goes stale → every line names its source, `/workspace-learn` proposes closing threads,
  and `--update` refreshes the generated parts.
- The guide grows into a manual → the 4 KB budget fails the validator.
- A wrong pointer misleads every agent → changes are diffs a human merges.
