# Review — flow 295, scheduled agent tasks (PR #664), round 3 — TUI and merge review

Review of the T9 TUI work (Schedules sidebar, detail modal, `/schedules`) together with the
main-branch merges folded into the branch, run on top of commit `338178da`. Eight findings were
raised: three major (a resume supply-chain gap, an arbitrary-path report read, and a nested-TUI
confirmation bypass), one minor UI-completeness gap, and four more (one minor, one grouped
test-gap note, one minor race, and one grouped set of small items). All eight were acted on.
Re-verified below against the code that merged to `main` as
`89dbea8dc25d80639ead9f7497287767138a040c` (PR #664, squash-merged from head
`4be4004daf96599ec3f2e28b1e6e4e8ab94a1c9d`; identical trees). A mutation sweep separately
reverted each of the 19 regression tests' fixes one at a time; 18 were caught, and the one that
survived (M2's `lstat` check alone) was expected, because the independent `O_NOFOLLOW|O_NONBLOCK`
+ `fstat().isFile()` layer still refuses the symlink/FIFO on its own — confirmed directly below.

```json keryx:findings
[
  {
    "id": "M1",
    "reviewer": "tui-reviewer (flow 295)",
    "severity": "major",
    "file": "src/trigger/schedules.ts",
    "quote": "resumeStoredSchedule",
    "problem": "`keryx schedule resume` could rewrite or resume a unit using the CALLER's own `keryx` binary/env rather than the one confirmed at draft time.",
    "impact": "An operator resuming a schedule from a different `keryx` install (a dev checkout, a shell alias, a stale PATH entry) could silently reinstall the unit to run that DIFFERENT binary going forward — a supply-chain substitution the operator never confirmed.",
    "suggested_fix": "Sign the confirmed invocation argv+env into the schedule's content hash at draft/install time; have resume/install/pause/remove all use the signed value, never the live caller's; refuse a draft whose resolved keryx binary is inside the project.",
    "evidence": "Pre-fix, resume/install used whatever `keryx` invocation the current process resolved, not a value pinned at confirmation time.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/trigger/config.ts (scheduleContentCanonical — install{argv,env} block)",
        "src/trigger/schedules.ts (draftSchedule, confirmSchedule, resumeStoredSchedule, pauseStoredSchedule, removeSchedule)"
      ],
      "enumeration_method": "enumerated every lifecycle operation that can (re)write the installed unit — install, pause, resume, remove — and confirmed each reads the signed `entry.install` block rather than re-resolving the caller's own keryx."
    }
  },
  {
    "id": "M2",
    "reviewer": "tui-reviewer (flow 295)",
    "severity": "major",
    "file": "src/trigger/store.ts",
    "quote": "readScheduleReport",
    "problem": "The TUI's Report tab could be made to read an arbitrary path — a planted `reportPath` value, a symlink, or a FIFO — rather than only the report keryx itself wrote.",
    "impact": "A crafted or tampered ledger record naming a `reportPath` outside the expected `reports/<trigger>/<runId>.md` shape, or pointing at a symlink or FIFO, could make the Report tab display arbitrary local file contents or hang reading a pipe.",
    "suggested_fix": "Drop any `reportPath` that is not exactly `reports/<trigger>/<runId>.md`; require the real directory; `lstat` for a plain regular file under a size cap; open with `O_NOFOLLOW|O_NONBLOCK` and `fstat().isFile()` as an independent second check; bound the read; scrub the result through `cardSafe`.",
    "evidence": "Pre-fix, the report reader accepted whatever `reportPath` the record carried and read it directly with no shape check, symlink guard or size cap.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/trigger/record.ts (expectedReportRelPath, withSafeReportPath)",
        "src/trigger/store.ts (readScheduleReport — lstat + O_NOFOLLOW|O_NONBLOCK + fstat + bounded read)",
        "src/tui/schedules-inspector.ts (Report tab rendering through cardSafe)"
      ],
      "enumeration_method": "enumerated every way an attacker-controlled path could reach the read: the ledger's reportPath shape, a symlinked file, a symlinked containing directory, and a FIFO — each needed its own check, and two of the checks (lstat, and the open-flags+fstat pair) are independently sufficient, which the mutation sweep confirmed."
    }
  },
  {
    "id": "M3",
    "reviewer": "tui-reviewer (flow 295)",
    "severity": "major",
    "file": "src/lib/command-risk.ts",
    "quote": "nestedAgentScheduleRefusal",
    "problem": "A nested TUI could be driven through a PTY to bypass the schedule confirmation card — spawning an interactive keryx, or a terminal multiplexer wrapping one, from inside an unattended/tool-call context.",
    "impact": "An agent running inside its own tool call could launch `keryx shell` (or drive one through `tmux send-keys`/`screen -X stuff`/`script`/`unbuffer`) and use the PTY to click through a confirmation the human never actually saw, defeating every always-ask floor built for the scheduler.",
    "suggested_fix": "Refuse every schedule TUI surface (`/schedule`, the modal's actions, `schedule_create`'s card) outright when `KERYX_TOOL_CALL=1`; separately, extend the always-ask confirmation family to cover launching `keryx`/`keryx shell` (except `-p`/`--print`), any terminal-driver wrapper around keryx, and `tmux send-keys`/`screen -X stuff`.",
    "evidence": "Pre-fix, neither the TUI schedule surfaces nor the always-ask family recognised a nested keryx launched through a terminal driver.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/trigger/schedules.ts (nestedAgentScheduleRefusal)",
        "src/tui/schedules-inspector.ts (modal p/r/d actions)",
        "src/tui/schedule-command.ts (/schedule)",
        "src/commands/schedule-tools.ts (schedule_create confirmation)",
        "src/lib/command-risk.ts (TERMINAL_DRIVERS, launchesInteractiveKeryx, drivesKeryxTerminal)"
      ],
      "enumeration_method": "enumerated every TUI entry point that can reach a schedule confirmation (slash command, modal actions, agent tool) plus every way a nested keryx or a terminal driver could reach the same confirmation from inside an unattended context — both halves needed independent coverage."
    }
  },
  {
    "id": "M4",
    "reviewer": "tui-reviewer (flow 295)",
    "severity": "minor",
    "file": "src/tui/schedules-inspector.ts",
    "quote": "overviewLines",
    "problem": "The schedule detail modal's Overview tab was missing the systemd unit name and linger status, so an operator could not see what was actually installed.",
    "impact": "An operator inspecting a schedule had no way, short of the shell, to confirm which unit was installed or whether linger was enabled (and therefore whether the schedule would run while logged out).",
    "suggested_fix": "Show `unit`, `linger`, and `verified` lines on the Overview tab, sourced from the same install-description function the CLI uses.",
    "evidence": "Pre-fix, the Overview tab rendered cadence and run times but no unit/linger/verified lines.",
    "confidence": "medium"
  },
  {
    "id": "L1",
    "reviewer": "tui-reviewer (flow 295)",
    "severity": "minor",
    "file": "src/trigger/schedules.ts",
    "quote": "verifyStoredSchedule",
    "problem": "`keryx schedule resume` did not re-verify the schedule's MAC and pinned binaries before re-enabling the timer.",
    "impact": "A schedule tampered with while paused (a forged content hash, or a granted binary swapped for a different one) would be silently resumed and start running again without re-checking the signature that made it trustworthy in the first place.",
    "suggested_fix": "Have resume verify the MAC and pins FIRST, before touching the timer, and refuse (leaving the entry paused) on any mismatch; show the verified status on the Overview tab.",
    "evidence": "Pre-fix, resume re-enabled the timer without calling the verification step that install/run already used.",
    "confidence": "medium"
  },
  {
    "id": "L2",
    "reviewer": "tui-reviewer (flow 295)",
    "severity": "info",
    "file": "src/tui/schedules-sidebar.test.ts",
    "quote": "test gaps",
    "problem": "Several TUI behaviours had no regression test: cancelling an armed action with a non-`n` key, respecting `keyboardOwnedElsewhere`, a no-op repaint on an unchanged tick, the exact next-run-time display, the crontab effects of pause/resume/remove, `triggerRunArgv({schedule:true})`, and the AC12 keyboard-only flow through `routeSchedulesCommand` shared by both `tui-shell.ts` branches.",
    "impact": "Without these tests, a regression in any of the above behaviours would go undetected until an operator hit it interactively.",
    "suggested_fix": "Add a targeted test for each listed behaviour.",
    "evidence": "Pre-fix, none of the listed behaviours had a named regression test.",
    "confidence": "low"
  },
  {
    "id": "L3",
    "reviewer": "tui-reviewer (flow 295)",
    "severity": "minor",
    "file": "src/tui/schedules-inspector.ts",
    "quote": "y",
    "problem": "An armed destructive action (delete or run-now awaiting the `y` confirm keystroke) could fire against a schedule that had vanished from the store between arming and confirming, or could lose its arm state incorrectly when another overlay took the keyboard.",
    "impact": "Confirming an armed action against a schedule that no longer exists could throw or act on stale data; failing to drop the arm when another overlay takes the keyboard could let a later, unrelated `y` keystroke fire the old action.",
    "suggested_fix": "Re-check that the item still exists when `y` is pressed, refusing gracefully if not; drop an armed action when another overlay takes the keyboard.",
    "evidence": "Pre-fix, `y` acted on the originally-captured item with no existence re-check, and an armed action was not cleared when the keyboard moved to another overlay.",
    "confidence": "medium"
  },
  {
    "id": "L4",
    "reviewer": "tui-reviewer (flow 295)",
    "severity": "info",
    "file": "src/tui/schedules-panel.ts",
    "quote": "small items",
    "problem": "A set of small correctness/polish gaps: ACP did not pin `schedule`/`schedules` as TUI-only commands; Overview showed times in a non-local zone; the `reservation-resolved` governance outcome used the default role instead of \"attention\"; the sidebar row did not say \"not installed\" when the timer was missing; the Grants tab did not show the pinned realpath/sha or interpreter; `detectBackend` was not cached per host; the confirmation card's `execStart` was not quoted the same way the actual unit file quotes it; the Runs tab's cap counted reservation (open) records, not just closing ones; and list selection in the modal followed row index rather than schedule name across a reload.",
    "impact": "Individually minor: a slightly misleading time zone, a missed \"attention\" highlight, a confusing Runs count, a lost selection on reorder, or an extra systemctl probe per reload.",
    "suggested_fix": "Pin schedule/schedules in ACP_TUI_ONLY_COMMANDS; format Overview times with formatLocalDateTime; map reservation-resolved to the attention role; show \"not installed\" when the timer is missing; show the pinned realpath/sha/interpreter on the Grants tab; cache detectBackend per host; share the same quoting function between the card and the unit writer; filter the Runs list to closing records before capping; key list-selection restoration by schedule name.",
    "evidence": "Pre-fix, each of the nine items above was individually absent or incorrect, verified by direct inspection during the TUI review.",
    "confidence": "low"
  }
]
```

## Coverage

Reviewed: `src/tui/schedules-sidebar.ts`, `src/tui/schedules-panel.ts`, `src/tui/schedules-inspector.ts`,
`src/trigger/schedules.ts`, `src/trigger/store.ts`, `src/trigger/record.ts`, `src/trigger/config.ts`
(the signed `install` block), `src/lib/command-risk.ts` (nested-TUI and terminal-driver matchers),
`src/commands/schedule-tools.ts`, `src/commands/schedule-command.ts`, `src/acp/commands.ts`, and the
main-branch merges folded into the T9 commit. Not reviewed: the rest of the repository, unchanged
by this flow.

## Outcome

Eight findings recorded: three major, one minor (M4), one minor (L1), one info (L2, a grouped
test-gap note), one minor (L3), one info (L4, nine grouped small items). All eight were acted on,
and are independently re-verified below against `89dbea8dc25d80639ead9f7497287767138a040c`
(== worktree HEAD `4be4004daf96599ec3f2e28b1e6e4e8ab94a1c9d`), each against its own named
regression test in `src/commands/schedule-review.test.ts` or `src/tui/schedules-sidebar.test.ts`.
A mutation sweep independently confirmed 18 of 19 regression tests fail when their fix is
reverted; the one exception (M2's `lstat` check) is defence-in-depth, confirmed still enforced by
a second, independent check.
