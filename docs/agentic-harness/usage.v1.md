# Running a multi-day `/develop` run (v1)

How to keep a quality-kernel run alive for days on macOS, and how to pick it up after it dies.
The run's state is the journal (`spec-run-journal.v1.md`), never the conversation.

## 1. Start it where it survives a closed terminal and a sleeping Mac

```bash
tmux new -s qk-<feature>                     # survives closing the terminal / SSH drop
caffeinate -i claude                         # no idle sleep while claude runs (lid closed still sleeps)
# inside claude:
/quality-kernel:develop <description>
```

- Detach with `Ctrl-b d`; reattach with `tmux attach -t qk-<feature>`.
- `caffeinate -i` stops only idle sleep. On battery or with the lid closed the Mac still sleeps:
  keep it on power, lid open (or an external display).
- Start in the **org folder** (`~/Projects/Matchbox` or `~/Projects/personal`): the journal lives in
  `<org>/.quality-kernel/runs/<run-id>/journal.jsonl` and is refused inside a product repo.
- After the approval gate, `/develop` prints the run id. Write it down with the org folder.

## 2. While it runs

```bash
J=<plugin>/scripts/run-journal.mjs
node "$J" fold --org <org> --run <id>        # current state of every task (read-only)
node "$J" open --org <org>                   # runs without run_finished
```

Nothing to do unless a task is reported `blocked`: that one waits for you, the others continue.

## 3. After a crash, reboot, OOM kill or a closed session

```bash
tmux new -s qk-<feature>-resume
caffeinate -i claude --resume                # or a fresh `claude` in the org folder
```

Then tell it: "resume run `<id>` in `<org>`". `/develop` runs
`node "$J" resume --org <org> --run <id>` before anything else, and does not continue from memory:

| resume exit | meaning | what happens |
|---|---|---|
| 0 | journal, git and the gate agree | `done` is skipped, `continue` restarts, `blocked` is reported to you |
| 1 | divergence (`sha_unreachable`, `commits_after_green`, `orphan_commits`, `gate_red_now`, …) | it stops and reports; you decide. Nothing is repaired automatically |
| 2 | could not decide (corrupt journal, gate indeterminate, git error) | it stops and reports; never treated as green |

`resume` is read-only: it never touches a worktree, a branch or the org folder.
It re-runs the gate once per repo, which takes as long as that repo's tests.

## 4. Limits

- Only the latest green task per repo is re-gated on resume. Other green tasks are checked
  against git (their SHA is still on their branch, and no commits came after it), not re-tested.
- A commit without the `QK-Task: <id>` trailer is invisible to the orphan and
  commits-after-green checks.
