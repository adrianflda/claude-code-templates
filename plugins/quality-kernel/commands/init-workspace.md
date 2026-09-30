---
description: Initialize the org workspace for multi-repo quality-kernel — discover and profile the repos, verify each proposed gate config by re-execution, and write the proposal to a new workspace branch for human review.
argument-hint: "[--org <dir>] [--repos a,b,c] [--exclude x,y]"
---

Run the **init-workspace** skill on `$ARGUMENTS` and follow it exactly.

This is quality-kernel's init step for working across several repos: the workspace it proposes is
what `/gate` (with `--workspace`), `qk-org-gate`, `/forge` and `/develop` use to know the repos of the
system, their base branches, how their tests run and what is critical.

- Scope is explicit: with `--repos` only those repos are opened; otherwise show the discovered
  candidates and ask the user to confirm the selection first.
- The tool writes nothing into product repos (verification runs with `--no-ledger`; the suites run in
  temp copies — only `linkPaths` such as `node_modules` are the real dirs, where a suite may cache).
  The proposal goes to a NEW branch `init/<date>` of `<org>/workspace`; never write or merge its `main`.
- Before verification, show the user every proposed `verify` command and wait for an explicit OK —
  verification executes them. Then every gate config is re-executed and labelled; report the labels
  as they are.
