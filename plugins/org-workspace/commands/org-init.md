---
description: Build the org guide — discover the repos of this folder, map who calls whom (SYSTEM-MAP.md), and write a short managed block into the root CLAUDE.md saying where the truth of each thing lives.
argument-hint: "[--org <dir>] [--repos a,b,c] [--forbid x,y]"
---

Run the **org-init** skill on `$ARGUMENTS` and follow it. Nothing is written until the user approves
the previewed diff; only the managed block of `CLAUDE.md` and `SYSTEM-MAP.md` are ever written.
