# Executable scenarios for contract.md (same folder). Tags cite the EARS criteria they falsify.
# Criteria PT-A10, PT-A14, PT-B1 (default 300), PT-C9 and the boundary arithmetic of PT-C8 are proven by unit
# tests of exported pure functions, not by this feature (no test-only env seams). Every grandchild sleeps at most 60 seconds.
# QK_LOCK_DIR and TMPDIR point at separate scratch directories; both are empty at the start of every scenario.
Feature: Gate commands never outlive the gate run

  Background:
    Given a fixture git repository with a committed base and a head that edits only "src/code.mjs"
    And a scratch TMPDIR that is empty
    And a scratch QK_LOCK_DIR that is empty
    And a unique marker MARK for this scenario
    And no process named "vitest" or "stryker" is running

  # ---------- A. Whole-tree termination ----------

  @PT-A1 @PT-A3 @PT-B2
  Scenario Outline: a timed-out command's whole tree is killed and the verdict is INDETERMINATE
    Given base tools.json has "timeoutSeconds" <timeout>
    And "verify" starts a grandchild carrying MARK that sleeps 60 seconds, then sleeps itself
    When the referee runs
    Then the exit code is 2
    And the verdict reason contains "timed out after <timeout>s"
    And the verdict reason contains "process tree killed"
    And no process carries MARK within 2 seconds of the verdict
    And the elapsed time is at most <timeout> + 5 + 3 seconds

    Examples:
      | timeout |
      | 1       |
      | 3       |

  @PT-A2
  Scenario: a SIGTERM-ignoring member is killed after the 5000 ms grace
    Given base tools.json has "timeoutSeconds" 2
    And "verify" starts a grandchild carrying MARK that ignores SIGTERM and sleeps 60 seconds
    When the referee runs
    Then the exit code is 2
    And the verdict reason contains "timed out after 2s"
    And no process carries MARK
    And the elapsed time is at least 2 + 5 seconds and at most 2 + 5 + 3 seconds

  @PT-A2 @PT-A15
  Scenario: a SIGTERM-ignoring descendant that left the group is SIGKILLed without grace
    Given base tools.json has "timeoutSeconds" 2
    And "verify" starts /usr/bin/perl -e carrying MARK in argv that stays attached for 1 second, then calls setpgrp(0,0), ignores SIGTERM and sleeps 60 seconds
    When the referee runs
    Then the exit code is 2
    And no process carries MARK
    And the elapsed time is at most 2 + 5 + 3 seconds

  @PT-A3
  Scenario: exiting 0 during the grace period does not turn a timeout into PASS
    Given base tools.json has "timeoutSeconds" 1
    And "verify" exits 0 on SIGTERM after sleeping past the timeout
    When the referee runs
    Then the exit code is 2
    And the verdict reason contains "timed out after 1s"

  @PT-A4 @PT-A5 @PT-A11
  Scenario Outline: stragglers are reaped after a command ends, without waiting for them
    Given "verify" starts a background grandchild carrying MARK that holds stdout open for 60 seconds
    And "verify" then exits with status <status>
    When the referee runs
    Then the exit code is <referee exit>
    And no process carries MARK at the moment the referee exits
    And the elapsed time is under 15 seconds

    Examples:
      | status | referee exit |
      | 0      | 0            |
      | 3      | 1            |

  @PT-A4
  Scenario: stragglers of "verifySetup" are reaped before "verify" starts
    Given base tools.json has "verifySetup" that starts a background grandchild carrying MARK and exits 0
    And "verify" fails with exit 4 if any process carries MARK, else exits 0
    When the referee runs
    Then the exit code is 0

  @PT-A6 @PT-A15 @PT-A16
  Scenario Outline: a descendant that left the process group is killed whether or not its environment is visible
    Given "verify" starts <escapee> carrying MARK in argv that stays attached for 1 second, then <escape> and sleeps 60 seconds
    And "verify" <ending>
    When the referee runs
    Then the exit code is <referee exit>
    And no process carries MARK at the moment the referee exits

    Examples:
      | escapee                      | escape                  | ending                        | referee exit |
      | a node process               | starts a detached child | exits 0                       | 0            |
      | /usr/bin/perl -e             | calls setpgrp(0,0)      | exits 0                       | 0            |
      | /usr/bin/perl -e             | calls POSIX::setsid()   | exits 0                       | 0            |
      | /usr/bin/perl -e             | calls setpgrp(0,0)      | sleeps past a 3 second timeout | 2           |
      | /usr/bin/perl -e             | calls POSIX::setsid()   | sleeps past a 3 second timeout | 2           |

  # Escapes that happen and finish inside one snapshot interval are the documented residual risk
  # (contract.md, residual risk 1) and are deliberately not asserted here.

  @PT-A7 @PT-D6
  Scenario: every command sees one run marker per run and no NODE_TEST_CONTEXT
    Given "verifySetup", "verify" and "acceptance" each append QK_RUN_ID and the presence of NODE_TEST_CONTEXT to a witness file
    And the caller exports NODE_TEST_CONTEXT=child
    When the referee runs twice
    Then within each run every recorded QK_RUN_ID is identical and matches "^[0-9a-f]{16}$"
    And the QK_RUN_ID of run 1 differs from that of run 2
    And NODE_TEST_CONTEXT is recorded as absent every time

  @PT-A8 @PT-D1
  Scenario Outline: large output is classified by exit status only
    Given "verify" writes <bytes> bytes to <stream> then exits with status <status>
    When the referee runs
    Then the exit code is <referee exit>
    And the verdict has no "indeterminate" field

    Examples:
      | bytes   | stream | status | referee exit |
      | 3145728 | stdout | 0      | 0            |
      | 3145728 | stderr | 0      | 0            |
      | 1048577 | both   | 0      | 0            |
      | 3145728 | stdout | 3      | 1            |

  @PT-D4
  Scenario Outline: exit 126/127 is "not executable" only when stdout is empty
    Given "verify" writes <bytes> bytes to stdout then exits with status <status>
    When the referee runs
    Then the exit code is <referee exit>
    And the verdict reason <reason check>

    Examples:
      | bytes   | status | referee exit | reason check                       |
      | 0       | 127    | 2            | contains "not executable (exit 127)" |
      | 0       | 126    | 2            | contains "not executable (exit 126)" |
      | 3145728 | 127    | 1            | does not contain "not executable"    |

  @PT-D5
  Scenario: a command killed by an external signal is INDETERMINATE "could not complete"
    Given "verify" kills its own shell with SIGKILL
    When the referee runs
    Then the exit code is 2
    And the verdict reason contains "could not complete"

  @PT-A9 @PT-C7
  Scenario Outline: a signal to the referee kills every tree and releases the lock
    Given "verify" starts a grandchild carrying MARK that sleeps 60 seconds
    And the referee is running and the grandchild exists
    When the referee receives <signal>
    Then the referee process ends within 10 seconds with exit code <code>
    And its stdout contains no verdict with "pass":true
    And no process carries MARK
    And QK_LOCK_DIR is empty

    Examples:
      | signal  | code |
      | SIGINT  | 130  |
      | SIGTERM | 143  |
      | SIGHUP  | 129  |

  @PT-A12
  Scenario Outline: a signal to the gate kills the referee and every tree
    Given "verify" starts a grandchild carrying MARK that sleeps 60 seconds
    And the gate is running and the grandchild exists
    When the gate receives <signal>
    Then within 15 seconds the gate, the referee and every process carrying MARK are gone
    And QK_LOCK_DIR is empty

    Examples:
      | signal  |
      | SIGINT  |
      | SIGTERM |
      | SIGHUP  |

  @PT-A13
  Scenario: SIGKILL of the gate is detected by the referee through parent death
    Given "verify" starts a grandchild carrying MARK that sleeps 60 seconds
    And the gate is running and the grandchild exists
    When the gate receives SIGKILL
    Then within 5 seconds of the kill the referee and every process carrying MARK are gone
    And QK_LOCK_DIR is empty

  # ---------- B. Configurable timeout ----------

  @PT-B3
  Scenario Outline: an invalid timeoutSeconds is INDETERMINATE and runs nothing
    Given base tools.json has "timeoutSeconds" <value>
    And "verify" would write a witness file
    When the referee runs
    Then the exit code is 2
    And the verdict reason contains "timeoutSeconds"
    And the witness file does not exist
    And TMPDIR is empty
    And QK_LOCK_DIR is empty

    Examples:
      | value |
      | 0     |
      | -1    |
      | 1.5   |
      | "5"   |
      | true  |
      | null  |
      | 3601  |
      | 99999 |

  @PT-B2
  Scenario Outline: boundary values are accepted unchanged
    Given base tools.json has "timeoutSeconds" <value>
    And "verify" exits 0
    When the referee runs
    Then the exit code is 0

    Examples:
      | value |
      | 1     |
      | 3600  |

  @PT-B4
  Scenario: the working tree and head cannot change the timeout
    Given base tools.json has "timeoutSeconds" 2
    And the uncommitted working-tree tools.json has "timeoutSeconds" 3600
    And "verify" sleeps 10 seconds
    When the referee runs
    Then the verdict reason contains "timed out after 2s"

  @PT-B5
  Scenario: each command has its own budget
    Given base tools.json has "timeoutSeconds" 4
    And "verifySetup" sleeps 3 seconds and "verify" sleeps 3 seconds
    When the referee runs
    Then the exit code is 0

  # ---------- C. Pre-flight ----------

  @PT-C2 @PT-C3
  Scenario: a live run on another worktree of the same repository blocks this run
    Given a second worktree of the same repository
    And both runs use the same QK_LOCK_DIR
    And a gate run on worktree A is running a "verify" that sleeps 20 seconds
    When the referee runs on worktree B
    Then the exit code is 2
    And the verdict reason contains "another gate run is active"
    And the verdict reason contains the holder's pid
    And QK_LOCK_DIR contains only the holder's lock file
    And TMPDIR is empty

  @PT-C2
  Scenario: runs on different repositories do not block each other
    Given a second, unrelated fixture repository
    And both runs use the same QK_LOCK_DIR
    And a gate run on the first repository is running a "verify" that sleeps 20 seconds
    When the referee runs on the second repository
    Then the exit code is 0

  @PT-C7
  Scenario: the lock is released after every verdict kind
    When the referee runs for a <outcome> fixture
    Then QK_LOCK_DIR is empty

    Examples:
      | outcome       |
      | PASS          |
      | FAIL          |
      | INDETERMINATE |

  @PT-C4
  Scenario: a lock whose holder pid does not exist is taken over and its processes swept
    Given a referee run was started with a "verify" that starts a grandchild carrying MARK
    And that referee was killed with SIGKILL and the grandchild is still alive
    When a new referee runs on the same repository
    Then the exit code is 0
    And no process carries MARK

  @PT-C4 @PT-A18
  Scenario: takeover kills a recorded tracked descendant that left the group, hides its environment and ignores SIGTERM
    Given a referee run was started with a "verify" that starts /usr/bin/perl -e carrying MARK in argv
    And that perl process stays attached for 1 second, then calls setpgrp(0,0), ignores SIGTERM and sleeps 60 seconds
    And at least 2 seconds have passed
    And the lock in QK_LOCK_DIR lists the perl process in "descendants"
    And that referee was killed with SIGKILL and the perl process is still alive
    When a new referee runs on the same repository
    Then the exit code is 0
    And the perl process is gone

  @PT-A17 @PT-C4
  Scenario: takeover never kills a pid whose start time differs from the recorded one
    Given a lock whose dead holder recorded in "descendants" the pid of a live unrelated "sleep 30" process with a wrong "start"
    When the referee runs
    Then the exit code is 0
    And the unrelated process is still alive

  @PT-C5
  Scenario: PID reuse is treated as stale and the unrelated process is untouched
    Given a lock naming the pid of a live unrelated "sleep 30" process with a wrong "lstart"
    When the referee runs
    Then the exit code is 0
    And the unrelated process is still alive

  @PT-C6
  Scenario: of two runs racing for a stale lock at most one proceeds
    Given a lock naming a pid that does not exist
    When two referee runs start at the same moment on the same repository
    Then at least one exit code is 0
    And every run that did not exit 0 exited 2 with reason containing "another gate run is active"

  @PT-C8 @PT-C10 @macos
  Scenario Outline: a breached macOS memory threshold refuses the run before any temp tree or lock exists
    Given the environment sets <variable> to <value>
    And "verify" would write a witness file
    When the referee runs
    Then the exit code is 2
    And the verdict reason contains "memory pressure"
    And the witness file does not exist
    And TMPDIR is empty
    And QK_LOCK_DIR is empty

    # A normal machine reports pressure level 1, so a maximum of 1 refuses; a percentage cannot exceed 100.
    Examples:
      | variable                    | value |
      | QK_MEM_MAX_PRESSURE_LEVEL   | 1     |
      | QK_MEM_MIN_LEVEL_PCT        | 101   |

  @PT-C8 @PT-C10 @macos
  Scenario Outline: thresholds the machine does not breach let the run proceed
    Given the environment sets <variable> to <value>
    When the referee runs
    Then the exit code is 0

    Examples:
      | variable                    | value |
      | QK_MEM_MAX_PRESSURE_LEVEL   | 5     |
      | QK_MEM_MIN_LEVEL_PCT        | 0     |

  @PT-C11 @macos
  Scenario: QK_MEM_GUARD=off disables the guard
    Given the environment sets QK_MEM_MIN_LEVEL_PCT to 101
    And the environment sets QK_MEM_GUARD to off
    When the referee runs
    Then the exit code is 0

  @PT-C1
  Scenario Outline: validation is checked before the memory guard, which is checked before the lock
    Given a gate run on the same repository holds a live lock
    And <setup>
    When the referee runs
    Then the exit code is 2
    And the verdict reason contains "<substring>"

    Examples:
      | setup                                           | substring                  |
      | base tools.json has "timeoutSeconds" 0          | timeoutSeconds             |
      | the environment sets QK_MEM_MIN_LEVEL_PCT to 101 (macOS) | memory pressure  |
      | no other condition                              | another gate run is active |

  @PT-C4
  Scenario: takeover kills a recorded process group even when its members scrubbed the marker
    Given a referee run was started with a "verify" that starts a grandchild with an empty environment in the command's process group
    And that referee was killed with SIGKILL and the grandchild is still alive
    When a new referee runs on the same repository
    Then the exit code is 0
    And the scrubbed grandchild is gone

  # ---------- D. Unchanged behavior ----------

  @PT-D1 @PT-D2 @PT-D7
  Scenario Outline: referee verdicts keep their exit codes and JSON shape
    Given "verify" exits with status <status>
    When the referee runs
    Then the exit code is <referee exit>
    And the last stdout line is a single JSON object with keys <keys>

    Examples:
      | status | referee exit | keys                                |
      | 0      | 0            | pass, evidence, reason              |
      | 5      | 1            | pass, evidence, reason              |

  @PT-D3
  Scenario Outline: the gate keeps its exit codes and output keys
    Given the referee would exit <referee exit> with route tier "<tier>"
    When the gate runs
    Then the gate exit code is <gate exit>
    And the output has keys "gate, refereePass, tier, requiresBreaker, requiresHumanReview, referee, route, notes"
    And "gate" equals "<gate>"

    Examples:
      | referee exit | tier     | gate exit | gate                  |
      | 0            | standard | 0         | pass                  |
      | 1            | standard | 1         | fail                  |
      | 2            | standard | 2         | indeterminate         |
      | 0            | critical | 3         | blocked-needs-breaker |

  @PT-D7
  Scenario Outline: the evidence ledger is appended only for PASS and FAIL
    Given "verify" <behavior>
    When the referee runs
    Then the file ".quality-kernel/evidence-ledger.jsonl" in the repository gains <lines> line(s)

    Examples:
      | behavior                    | lines |
      | exits 0                     | 1     |
      | exits 5                     | 1     |
      | exceeds a 1 second timeout  | 0     |
