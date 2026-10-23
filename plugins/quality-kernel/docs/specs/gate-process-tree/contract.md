# Contract — gate-process-tree

> Behavior contract for hardening the quality gate (`scripts/referee.mjs`, `scripts/qk-gate.mjs`)
> so that no command it launches can outlive the gate run, and so that gate runs cannot stack up.
> It specifies externally observable behavior only. Executable scenarios:
> `gate-process-tree.feature` (same folder). The `## Invariants` table follows the contract-lint
> format (`scripts/contract-lint.mjs`): one `INV-PT-*` row per invariant, one assertion per row.

## Why (incident)

On 2026-10-22 a 24 GB Mac froze (hard reset) with 16+ orphaned vitest processes above 4 GB each.
- OBSERVED (design, verified by the expert on macOS): `run()` in `referee.mjs` used
  `spawnSync(cmd, { shell: true, timeout: 300000 })`. On timeout only `/bin/sh` receives SIGTERM;
  `npm`, `vitest` and its workers survive. Repeated gate runs stacked orphan trees.
- OBSERVED (design): `spawnSync` default `maxBuffer` (1 MiB) kills a chatty command with ENOBUFS,
  which `run()` reports as a spurious INDETERMINATE.
- INFERRED (design): `qk-gate.mjs` blocks its event loop in `spawnSync`, so SIGTERM aimed at the
  gate orphans the referee.

Source of intent: `design-process-tree.md` (expert design, session scratchpad). Anything the design
leaves open is under "Open questions" and is NOT specified here.

## Residual risk (read first)

1. A process that leaves its process group, hides or scrubs its environment (macOS: Apple platform binaries such as `/usr/bin/perl` and `/usr/bin/python3` do not expose their environment to `ps`, so the marker layer cannot see them), AND is created and detached from the tracked tree within one snapshot interval (500 ms) may escape every mechanism below. Not covered; no criterion claims otherwise.
2. SIGKILL of the referee (or of the whole machine) cannot be intercepted. Orphans from that event live until the NEXT run's stale-lock takeover (PT-C4/PT-C5), except (a) a descendant that was created and detached within one snapshot interval of the last lock update, and (b) a process forked by a surviving orphan AFTER the referee died: no tracker is running then, so (b) is never recorded in the lock and is reaped only if it still carries `QK_RUN_ID` or stays in a recorded process group. Both exceptions are bounded by residual risk 1. The killed referee's temporary directory under `TMPDIR` is also left behind; no criterion requires its removal.
3. Only macOS is empirically verified in the design; Linux behavior is INFERRED. Windows is unsupported and fails closed (PT-A14).
4. Memory thresholds are judgment values from the design, not measurements. Linux thresholds have no override.

## Definitions

- **command**: one of `verifySetup`, `verify`, `acceptance` as launched by the referee (setup runs
  once per tree, so up to five command executions per referee run).
- **tree**: the command's shell, all its descendants in the same process group, and every process
  carrying the run's marker.
- **marker**: environment variable `QK_RUN_ID=<16 lowercase hex chars>` placed in every command's
  environment.
- **snapshot interval**: at most 500 ms between two process-table snapshots taken while a command runs.
- **tracked descendant**: a process observed in a snapshot whose parent chain leads to the command's shell or to another tracked descendant, recorded with its pid, ppid and start time. A process stays tracked after its parent dies or it leaves the process group.
- **grace**: 5000 ms between the graceful signal and the forced kill.
- **survivor**: a process whose command line contains the test's unique marker string, found by
  `pgrep -f`, after the verdict has been emitted.
- **INDETERMINATE**: referee stdout last line is `{"pass":false,"indeterminate":true,"evidence":null,"reason":"<text>"}`
  and exit code is `2`.
- **repository lock**: a file in `QK_LOCK_DIR` (default: the OS temp directory) named `qk-gate-*.lock`, holding `{pid, lstart, runId, repo, pgids[], descendants: [{pid, start}]}`; a lock keyed by the repository's git common directory, so every worktree of
  one repository shares it.

## Acceptance criteria (EARS)

### A. Whole-tree termination

- PT-A1 WHEN a command runs longer than its timeout THE SYSTEM SHALL send SIGTERM to the entire process group of that command.
- PT-A2 IF any member of the command's process group is still alive 5000 ms after the SIGTERM THEN THE SYSTEM SHALL send SIGKILL to the group. The 5000 ms grace applies to the process group only: a tracked descendant that has left the group is sent SIGKILL directly, never SIGTERM, without a grace period, at reap time (when the command ends, or when the grace expires on the timeout path, whichever comes first).
- PT-A3 WHEN a command times out THE SYSTEM SHALL emit INDETERMINATE (exit 2) whose reason contains `timed out after <N>s` and `process tree killed`, even if the command exits 0 during the grace period.
- PT-A4 WHEN a command ends, with any exit status including 0, THE SYSTEM SHALL kill every remaining member of its process group before the next command starts and before the verdict is emitted.
- PT-A5 WHEN a command ends while a background descendant still holds the command's output streams open THE SYSTEM SHALL NOT delay the command's result until that descendant releases them.
- PT-A6 WHEN a command ends THE SYSTEM SHALL also kill every process that carries the run's marker, including processes that left the command's process group (second layer; it cannot see processes that hide their environment).
- PT-A7 THE SYSTEM SHALL give every command of one referee run the same `QK_RUN_ID`, and different referee runs different values.
- PT-A8 WHEN a command writes more than 1 MiB (1048576 bytes) to stdout, to stderr, or to both THE SYSTEM SHALL classify the command by its exit status only, never as INDETERMINATE because of output volume.
- PT-A9 WHEN the referee receives SIGINT, SIGTERM or SIGHUP THE SYSTEM SHALL kill every live tree, release the repository lock, emit no PASS verdict, and exit with status 128 plus the signal number: 130 for SIGINT, 143 for SIGTERM, 129 for SIGHUP.
- PT-A10 IF the referee hits an uncaught exception THEN THE SYSTEM SHALL kill every live tree and release the repository lock before exiting.
- PT-A11 WHEN the referee exits by any path it controls (PASS, FAIL, INDETERMINATE, signal) THE SYSTEM SHALL leave no process of its commands running.
- PT-A12 WHEN `qk-gate.mjs` receives SIGINT, SIGTERM or SIGHUP THE SYSTEM SHALL terminate its referee child and every tree under it, then exit non-zero.
- PT-A13 WHEN the process that launched the referee dies (including by SIGKILL) THE SYSTEM SHALL make the referee, which checks for parent death every 1 second, kill every live tree, release the repository lock and exit within 5 seconds of the parent's death.
- PT-A15 WHILE a command runs THE SYSTEM SHALL take process-table snapshots at an interval of at most 500 ms and track every descendant of the command, recording pid, ppid and start time, whether or not the descendant later leaves the command's process group (setpgrp, setsid) or is reparented, and whether or not its environment is visible.
- PT-A16 WHEN a command ends, times out, or the referee exits abnormally (PT-A9, PT-A10, PT-A13) THE SYSTEM SHALL kill every tracked descendant that is still alive and whose current start time equals the recorded start time.
- PT-A17 IF a tracked pid is alive but its start time differs from the recorded one (pid reuse) THEN THE SYSTEM SHALL NOT signal it. (Verified by a unit test of an exported pure function.)
- PT-A18 WHILE a command runs THE SYSTEM SHALL write the tracked descendants into the repository lock as `descendants: [{pid, start}]`, replacing the lock file atomically (write a temporary file, then rename) whenever the tracked set changes, at most once per snapshot interval, so that the lock file is always either the previous or the new complete JSON document.
- PT-A14 IF the platform is `win32` THEN THE SYSTEM SHALL emit INDETERMINATE whose reason names the unsupported platform, before creating any temp tree or running any command. (Verified by a unit test of an exported pure function; no environment seam.)

### B. Configurable timeout

- PT-B1 WHERE `tools.json` at base has no `timeoutSeconds` THE SYSTEM SHALL apply a 300 second timeout to each command. (The default is verified by a unit test of an exported pure function, not by waiting 300 s.)
- PT-B2 WHERE `tools.json` at base has `timeoutSeconds` equal to an integer from 1 to 3600 inclusive THE SYSTEM SHALL apply exactly that many seconds to each command.
- PT-B3 IF `timeoutSeconds` is present (including JSON `null`) and is not an integer from 1 to 3600 inclusive THEN THE SYSTEM SHALL emit INDETERMINATE whose reason contains `timeoutSeconds`, SHALL NOT clamp or default the value, and SHALL NOT run any command.
- PT-B4 THE SYSTEM SHALL read `timeoutSeconds` only from `tools.json` at the base ref, never from the head ref or the working tree.
- PT-B5 THE SYSTEM SHALL give each command (setup, verify, acceptance, on each tree) its own full timeout budget.

### C. Pre-flight (before any temp tree is created)

- PT-C1 WHEN a run starts THE SYSTEM SHALL perform, in this order and each before creating any temp tree or running any command: (1) argument, repository and `tools.json` validation (including `timeoutSeconds`), (2) the memory-pressure guard, (3) repository lock acquisition. The first step that refuses determines the INDETERMINATE reason.
- PT-C2 THE SYSTEM SHALL allow at most one referee run at a time per repository, across all worktrees of that repository.
- PT-C3 IF the lock is held by a live run THEN THE SYSTEM SHALL emit INDETERMINATE whose reason contains `another gate run is active` and the holder's pid and start time.
- PT-C4 IF the lock's holder pid does not exist THEN THE SYSTEM SHALL take the lock over and, before proceeding, apply three mechanisms: (1) kill every process group recorded in `pgids`; (2) kill every process recorded in `descendants` that is still alive and whose current start time equals the recorded `start` (PT-A17 applies: never a reused pid); (3) kill every process carrying the stale run's marker. The lock records `{pid, lstart, runId, repo, pgids[], descendants: [{pid, start}]}`; `pgids` holds the process group of every command the stale run had launched.
- PT-C5 IF the lock's holder pid exists but its start time differs from the recorded `lstart` (pid reuse) THEN THE SYSTEM SHALL treat the lock as stale and act as in PT-C4, without signalling the unrelated live process.
- PT-C6 IF two runs race for one stale lock THEN THE SYSTEM SHALL let at most one proceed; the other SHALL emit the PT-C3 INDETERMINATE.
- PT-C7 WHEN the referee exits by any path it controls THE SYSTEM SHALL remove the lock it owns. The lock lives in the directory named by `QK_LOCK_DIR`, default the OS temp directory.
- PT-C8 IF any single readable memory-pressure signal breaches its threshold (table below) THEN THE SYSTEM SHALL emit INDETERMINATE whose reason contains `memory pressure` and names the signal, its value and its threshold, before creating any temp tree or lock.
- PT-C9 IF no memory-pressure signal can be read THEN THE SYSTEM SHALL write a warning to stderr and proceed as if the guard passed, never emitting INDETERMINATE because of the unreadable probe. (Verified by a unit test of an exported pure function; no environment seam.)
- PT-C10 WHERE `QK_MEM_MAX_PRESSURE_LEVEL` is set THE SYSTEM SHALL refuse when the macOS pressure level is greater than or equal to it (default 2); WHERE `QK_MEM_MIN_LEVEL_PCT` is set THE SYSTEM SHALL refuse when the macOS level percentage is below it (default 20).
- PT-C11 WHERE `QK_MEM_GUARD` equals `off` THE SYSTEM SHALL skip the memory-pressure guard entirely.

Memory thresholds (from the design; refusal is strict inequality, equality passes):

| Platform | Signal | Refuse when |
|---|---|---|
| macOS | `sysctl -n kern.memorystatus_vm_pressure_level` | value >= `QK_MEM_MAX_PRESSURE_LEVEL` (default 2; 2 = warn, 4 = critical) |
| macOS | `sysctl -n kern.memorystatus_level` (percent) | value < `QK_MEM_MIN_LEVEL_PCT` (default 20) |
| Linux | `/proc/pressure/memory` `some avg10` | value > 25 (fixed, no override) |
| Linux | `/proc/meminfo` MemAvailable / MemTotal | ratio < 15 percent (fixed, no override) |

`os.freemem()`, `process.availableMemory()` and `vm.swapusage` are NOT guard signals (OBSERVED in
design: freemem reported 0.21 GB on a machine 89 percent free).

### D. Unchanged behavior (regression oracle)

- PT-D1 THE SYSTEM SHALL keep the referee exit codes: `0` PASS, `1` real FAIL, `2` INDETERMINATE.
- PT-D2 THE SYSTEM SHALL keep the referee verdict JSON shape. PASS/FAIL: `{pass, evidence:{verify, trustedExit, headExit, acceptance, acceptanceExit, base, head, overlaidTests}, reason}`. INDETERMINATE: `{pass:false, indeterminate:true, evidence:null, reason}`.
- PT-D3 THE SYSTEM SHALL keep the `qk-gate.mjs` exit codes: `0` pass, `1` fail, `2` indeterminate, `3` referee passed but a breaker or human review is required; and the output keys `gate, refereePass, tier, requiresBreaker, requiresHumanReview, referee, route, notes`.
- PT-D4 IF a command exits 126 or 127 with empty (or whitespace-only) stdout THEN THE SYSTEM SHALL emit INDETERMINATE containing `not executable`; WHERE its stdout is non-empty it is an ordinary failing exit status.
- PT-D5 IF a command ends without an exit status for a reason other than the timeout (for example killed by an external signal) THEN THE SYSTEM SHALL emit INDETERMINATE containing `could not complete`.
- PT-D6 THE SYSTEM SHALL NOT pass the environment variable `NODE_TEST_CONTEXT` to commands, and SHALL pass all other inherited variables.
- PT-D7 THE SYSTEM SHALL write exactly one JSON verdict line as the last line of referee stdout, and SHALL append an evidence-ledger record only for PASS and FAIL verdicts (as today).

## End-to-end QA procedure (user-visible surface only)

The only interface is the command line: `qk-gate.mjs` / `referee.mjs`, a fixture git repository,
its committed `.quality-kernel/tools.json`, and the operating system's process table. No internal
function is called. Safety: never point any step at a real project; use only fixture repos under a
scratch directory. Every grandchild is a `sleep` of at most 60 seconds or a `node -e` that sleeps at
most 60 seconds. Pick `MARK=qkpt_$(uuidgen)` once per scenario and put it in the grandchild's argv.
Set `TMPDIR` and `QK_LOCK_DIR` (`$L`) to distinct empty scratch directories per scenario. Cleanup after every scenario, pass or fail:
`pkill -f "$MARK"`; assert `pgrep -f "$MARK"` is empty; remove the scratch directory.
Precondition for the whole procedure: `pgrep -fl vitest` and `pgrep -fl stryker` print nothing.

Fixture: `git init`, commit `.quality-kernel/tools.json` (`verify` per scenario, `productionGlobs`
`["src/**"]`), a trivial `src/code.mjs`, commit again as head (one benign production edit). Run
`node scripts/qk-gate.mjs --repo <fixture> --base <base> --head <head>` unless a step says referee.

1. Timeout kills the tree (PT-A1..A3, B2). `verify` = a script that starts a grandchild
   (`sleep 60` with `$MARK` in argv), then sleeps. `timeoutSeconds: 2`. Run the gate. Expect exit 2,
   `referee.reason` containing `timed out after 2s` and `process tree killed`, elapsed time at most
   2 + 5 + 3 seconds. Then `pgrep -f "$MARK"` is empty.
2. SIGTERM-ignoring member (PT-A2). Same, but the grandchild traps SIGTERM. Expect the same verdict
   and no survivor, with elapsed time at least 2 + 5 seconds (the grace was honored) and at most
   2 + 5 + 3.
3. Stragglers after success (PT-A4, A5). `verify` starts a background grandchild that holds stdout
   open (`sleep 60 &` with `$MARK`) and exits 0. Expect `gate` `pass`, exit 0, elapsed under 15
   seconds (not 60), and no survivor.
4. Escapee (PT-A6, A15, A16). `verify` starts a grandchild in its own session (`node -e` spawning a detached child with `$MARK` in argv, then exiting) and exits 0. Expect no survivor after the gate returns.
4b. Platform-binary escapee (PT-A15, A16). `verify` starts `/usr/bin/perl -e` (argv carries `$MARK`) that stays attached for 1 second (longer than one snapshot interval), then calls `setpgrp(0,0)` (variant: `POSIX::setsid()`) and sleeps 60 seconds, and `verify` exits 0. Expect no survivor after the gate returns. Repeat with a `verify` that never exits and `timeoutSeconds` 3: expect INDETERMINATE (timeout) and no survivor. Cleanup with `pkill -f "$MARK"` regardless.
5. Large output (PT-A8, D4). `verify` writes 3 MiB to stdout, then exits 0: expect exit 0 and
   `referee.pass` true. Repeat with 3 MiB to stderr, with exit 3 (expect gate exit 1, `referee.pass`
   false, not indeterminate), and with 3 MiB to stdout then `exit 127` (expect FAIL, not
   `not executable`).
6. Gate killed (PT-A12, A13). Start the gate in the background with a long `verify` (grandchild with `$MARK`, `timeoutSeconds` 300) and `QK_LOCK_DIR=$L`. Wait until the grandchild exists. (a) `kill -TERM <gate pid>`; (b) in a fresh scenario `kill -KILL <gate pid>`. Expect no gate, no referee, no survivor and no lock file in `$L`: within 15 seconds for (a), within 5 seconds of the kill for (b).
7. Referee killed by signal (PT-A9). Same as 6 but target the referee with `kill -INT`, `-TERM`, `-HUP` in three scenarios. Expect no survivor, no PASS output, and the referee exit code 130, 143 and 129 respectively.
8. Referee SIGKILLed, next run recovers (PT-C4, A18). Start a referee with a long `verify`, `QK_LOCK_DIR=$L`, that starts (a) a grandchild carrying `$MARK`, (b) a grandchild started with a scrubbed environment (`env -i`) in the same process group, and (c) `/usr/bin/perl -e` (argv carries `$MARK`) that stays attached for 1 second, then calls `setpgrp(0,0)` and ignores SIGTERM, sleeping 60 seconds. After at least 2 seconds `kill -KILL` the referee and observe (a), (b) and (c) still alive (this documents residual risk 2); read `$L/qk-gate-*.lock` and observe (c) listed in `descendants`. Then run a normal gate on the same repository. Expect that run to proceed (`gate` `pass`) and (a), (b) and (c) gone.
9. Pid reuse (PT-C5). Write, into `$L`, a lock for the repository naming the pid of a long-lived unrelated `sleep 30` and a deliberately wrong `lstart`. Run the gate: expect it proceeds, and the unrelated `sleep 30` is still alive.
10. Live lock across worktrees (PT-C2, C3, C7). Create a second worktree with `git worktree add`. With `QK_LOCK_DIR=$L` start a gate on worktree A with a long `verify`. Run a gate on worktree B with the same `QK_LOCK_DIR`: expect exit 2 and reason containing `another gate run is active`, the holder pid and start time, `$L` holding only the holder's lock and `TMPDIR` empty. Let A finish or kill it; `$L` is empty and a run on B now proceeds.
11. Invalid timeout (PT-B3). For each of `0`, `-1`, `1.5`, `"5"`, `true`, `null`, `3601`, `99999` commit it as base `timeoutSeconds`: expect exit 2, reason containing `timeoutSeconds`, no marker process ever started (the `verify` would create a witness file; it must not exist), `TMPDIR` and `$L` empty. Boundaries `1` and `3600` (with a `verify` that exits 0) proceed.
12. Contract source (PT-B4). Commit `timeoutSeconds: 2` at base; uncommitted, edit the working-tree
    `tools.json` to 3600; `verify` sleeps 10. Expect the 2 second timeout applies.
13. Memory guard (PT-C8, C10, C11; macOS only, skip on Linux where unit tests cover it). Run the gate with `QK_MEM_MAX_PRESSURE_LEVEL=1` (a normal machine reports level 1, so this refuses) and again with `QK_MEM_MIN_LEVEL_PCT=101`: expect exit 2, reason containing `memory pressure`, empty `TMPDIR` and `$L`. Run again with the same variable plus `QK_MEM_GUARD=off`: expect a normal verdict. Never create real memory pressure.
14. Marker visibility (PT-A7, D6). `verify` writes `$QK_RUN_ID` and `$NODE_TEST_CONTEXT`-presence to
    a file. Run twice: the value is 16 lowercase hex chars, constant within a run (setup, verify,
    acceptance each record it), different between runs, and `NODE_TEST_CONTEXT` is absent even when
    exported by the caller.
15. Order (PT-C1). With a live lock held by another run and an invalid `timeoutSeconds` committed: expect the `timeoutSeconds` reason. With a live lock and `QK_MEM_MAX_PRESSURE_LEVEL=1` (macOS): expect the `memory pressure` reason.
16. Final check, always: `pgrep -f "$MARK"`, `pgrep -fl vitest` and the listing of `$L` are empty.

## Invariants (External Observable Invariants)

Probe notation: `$MARK` unique marker in the grandchild argv; `$T` the run's scratch `TMPDIR`; `$L` the run's scratch `QK_LOCK_DIR`;
`$REF`/`$GATE` the pid of the launched process. All probes avoid pipes so each fits one table cell.
"Probe harness" names the downstream script that wraps the shell command with the scenario setup.

| id | predicate (external state) | probe |
|---|---|---|
| INV-PT-1 | After a timed-out run returns, zero processes carry the marker, within 2 s of the verdict, including a platform-binary (perl) descendant that called `setpgrp` after 1 s attached | `test -z "$(pgrep -f "$MARK")"` after `sleep 2`; harness: probe-timeout-tree |
| INV-PT-2 | After a run whose command exited 0 leaving a background child, zero processes carry the marker at verdict time | `test -z "$(pgrep -f "$MARK")"` immediately after gate exit; harness: probe-straggler |
| INV-PT-3 | After a run whose command left a detached child (new session, `setpgrp`, or `POSIX::setsid`, including Apple platform binaries whose environment is not visible to `ps`), zero processes carry the marker, on both the exit-0 path and the timeout path | `test -z "$(pgrep -f "$MARK")"`; harness: probe-escapee |
| INV-PT-4 | After SIGINT, SIGTERM or SIGHUP to the referee, zero marker processes, no live referee, and exit code 130, 143, 129 respectively | `test -z "$(pgrep -f "$MARK")" && ! kill -0 $REF` and exit status check; harness: probe-signal |
| INV-PT-5 | After SIGTERM to the gate, within 15 s, and after SIGKILL to the gate, within 5 s of the kill, zero marker processes, no referee, no lock file | `test -z "$(pgrep -f "$MARK")" && ! kill -0 $REF && test -z "$(ls -A $L)"`; harness: probe-gate-killed |
| INV-PT-6 | A timed-out run's stdout last line is INDETERMINATE JSON, exit 2, reason matches `timed out after [0-9]+s.*process tree killed` | `node scripts/qk-gate.mjs ... ; echo $?` then assert regex on `referee.reason`; harness: probe-verdict |
| INV-PT-7 | Elapsed time of a timed-out run is at most N + 5 + 3 s, and for a SIGTERM-ignoring member of the process group at least N + 5 s; a SIGTERM-ignoring tracked descendant that left the group adds no grace (it is SIGKILLed at reap time) | wall-clock around the gate invocation; harness: probe-verdict |
| INV-PT-8 | For each invalid `timeoutSeconds` value the run exits 2 with a reason containing `timeoutSeconds`, no witness file written by `verify`, `$T` empty | `test -e $WITNESS` is false and `test -z "$(ls -A $T)"`; harness: probe-timeout-validation |
| INV-PT-9 | `timeoutSeconds` 1 and 3600 are accepted by a real run; the default 300 is proven by a unit test of an exported pure function (no env seam) | exit 0 for both boundaries; unit test `node --test` on the exported function; harness: probe-timeout-validation |
| INV-PT-10 | The timeout applied equals the BASE value even when the working tree differs | elapsed time and reason `after 2s`; harness: probe-timeout-source |
| INV-PT-11 | While run A holds the lock, a run on another worktree of the same repo (same `QK_LOCK_DIR=$L`) exits 2 with reason containing `another gate run is active`, `$L` holds only A's lock file and `$T` is empty | `test "$(ls -A $L)" = "$LOCKNAME" && test -z "$(ls -A $T)"`; harness: probe-lock-live |
| INV-PT-12 | After any run exiting by a path it controls, `$L` is empty | `test -z "$(ls -A $L)"`; harness: probe-lock-release |
| INV-PT-13 | After a run following a SIGKILLed referee, processes carrying the dead run's marker, processes in its recorded pgids (even with scrubbed env) AND recorded descendants (including an Apple platform binary such as `/usr/bin/perl` that called `setpgrp` and ignores SIGTERM) are gone, and the new run proceeds; before the new run, the lock lists that descendant | `grep -c "$PERL_PID" $L/qk-gate-*.lock` is at least 1 before; after: `test -z "$(pgrep -f "$MARK_OLD")" && ! kill -0 $SCRUBBED_PID && ! kill -0 $PERL_PID`, verdict `pass`; harness: probe-lock-takeover |
| INV-PT-14 | A lock naming a live unrelated pid with a wrong `lstart` is taken over and the unrelated process is still alive | `kill -0 $UNRELATED` succeeds and verdict `pass`; harness: probe-lock-pid-reuse |
| INV-PT-15 | A memory refusal (macOS, via `QK_MEM_MAX_PRESSURE_LEVEL=1` or `QK_MEM_MIN_LEVEL_PCT=101`) exits 2, reason contains `memory pressure`, and leaves `$T` and `$L` empty; with `QK_MEM_GUARD=off` the same run proceeds | `test -z "$(ls -A $T)" && test -z "$(ls -A $L)"`; harness: probe-memory-guard |
| INV-PT-16 | With every probe unreadable the guard passes and a warning is produced (unit test of an exported pure function; no env seam) | `node --test` on the exported function; harness: unit |
| INV-PT-17 | A command writing 3 MiB to stdout or stderr with exit 0 yields PASS; with a nonzero exit yields FAIL (exit 1), never INDETERMINATE | exit code and `referee.indeterminate` absent; harness: probe-large-output |
| INV-PT-18 | Each command sees `QK_RUN_ID` of 16 lowercase hex chars, constant within a run, different across runs, and never sees `NODE_TEST_CONTEXT` | witness files written by `verify`; harness: probe-env |
| INV-PT-19 | Referee exit codes are only 0, 1, 2 on its own verdict paths; gate codes only 0, 1, 2, 3; verdict JSON keys as in PT-D2 and PT-D3 | key and exit-code assertions over the existing suite plus new fixtures; harness: probe-verdict-shape |
| INV-PT-20 | On win32 the platform check yields INDETERMINATE naming the platform (unit test of an exported pure function; no env seam) | `node --test` on the exported function; harness: unit |

## Resolved decisions (human-approved)

| # | Decision | Where applied |
|---|---|---|
| 1 | Order: validate tools.json, then memory guard, then lock, then build temp trees | PT-C1, QA step 15 |
| 2 | Signal exit codes 128+n: SIGINT 130, SIGTERM 143, SIGHUP 129 | PT-A9, feature |
| 3 | Referee polls for parent death every 1 s and exits (after killing its tree) within 5 s of parent death | PT-A13, INV-PT-5 |
| 4 | Lock payload `{pid, lstart, runId, repo, pgids[]}`; takeover kills recorded pgids AND marker-sweeps the stale runId | PT-C4, PT-C5, INV-PT-13 |
| 5 | Lock directory env `QK_LOCK_DIR` | PT-C7, probes |
| 6 | Env `QK_MEM_MAX_PRESSURE_LEVEL` (default 2, refuse if level >=), `QK_MEM_MIN_LEVEL_PCT` (default 20, refuse if below), `QK_MEM_GUARD=off` disables the guard | PT-C10, PT-C11 |
| 7 | Default timeout 300, pressure evaluation, win32 fail-closed and unreadable-probe are proven by unit tests of exported pure functions; NO test-only env seams in production code | PT-A14, PT-B1, PT-C8, PT-C9 |
| 8 | `timeoutSeconds: null` is invalid and yields INDETERMINATE naming the field | PT-B3 |
| 9 | A command that exits 0 during the grace period is still timed out, INDETERMINATE | PT-A3 |
| 10 | Any single readable signal breaching refuses | PT-C8 |
| 11 | Unreadable-probe warning goes to stderr | PT-C9 |
| 12 | Exact reason wording is the coder's; only these substrings are contractual: `timed out after <N>s`, `process tree killed`, `timeoutSeconds`, `another gate run is active`, `memory pressure`, a platform name | all |
| 13 | Uncaught exception is verified by a code-level fault-injection unit test | PT-A10 |
| 14 | No full-output tee to a log file | none |
| 15 | No overall wall-clock cap; budgets are per command | PT-B5 |
| 20 | Descendant tracking by periodic process-table snapshots (interval <= 500 ms; pid, ppid chain, start time); at command end, timeout or abnormal exit every tracked descendant still alive with matching start time is killed, never a reused pid; the env-marker sweep stays as a second layer. Added after BREAKER_FAIL on PT-A6/INV-PT-3 (macOS `ps eww` hides the environment of Apple platform binaries) | PT-A15, PT-A16, PT-A17, INV-PT-1, INV-PT-3 |
| 21 | Tracked descendants are persisted into the lock as `descendants: [{pid, start}]`, replaced atomically (temp + rename) whenever the tracked set changes (at most once per snapshot interval); takeover has three mechanisms: recorded pgids, recorded descendants (alive AND start time matches), env-marker sweep. The 5 s grace applies to the command's process group only; descendants that left the group are SIGKILLed at reap time without grace. Added after the second BREAKER_FAIL (vector V-K: referee SIGKILLed with a tracked perl setpgrp escapee) | PT-A2, PT-A18, PT-C4, INV-PT-7, INV-PT-13 |
| 22 | Resolves OPEN-Q19: on the timeout path a tracked descendant that left the process group may be SIGKILLed at any time from the start of the timeout up to the group's SIGKILL (no SIGTERM, no grace); the implementation does so at reap time | PT-A2, INV-PT-7 |
| 16 | Linux uses the same override variables: `QK_MEM_MIN_LEVEL_PCT` applies to MemAvailable/MemTotal percent (Linux default 15; macOS default 20), and PSI `some avg10` > 25 refuses (fixed, no override) | PT-C8, PT-C10 |
| 17 | A non-numeric or out-of-range `QK_MEM_MAX_PRESSURE_LEVEL` / `QK_MEM_MIN_LEVEL_PCT`, or a `QK_MEM_GUARD` other than unset, `on` or `off`, yields INDETERMINATE naming the variable (fail closed, never silently defaulted). Valid: level = integer >= 1; percentage = number >= 0 | PT-C8, PT-C10, PT-C11 |
| 18 | Process groups are persisted into the lock at each command spawn, via an atomic write (temp file plus rename), so a SIGKILL mid-command is recoverable | PT-C4 |
| 19 | Cucumber.js is not added (the plugin stays zero-dependency); the `node:test` acceptance harness with verbatim scenario titles plus a trace test is the accepted Gherkin binding | none |

Unit-test-only criteria (no Gherkin scenario by design): PT-A10, PT-A17, PT-A18 (atomicity), PT-A14, PT-B1 (default 300), PT-C9,
and the boundary arithmetic of PT-C8.

## Open questions

None. Q16-Q18 are resolved in decisions 16-18 above.
