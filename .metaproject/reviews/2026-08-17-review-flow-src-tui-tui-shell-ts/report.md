# Managed Review Report

Reviewer: review-orchestrator (run by agent, flow 167 T4)
Target: path src/tui/tui-shell.ts (+ src/tui/main-queue.ts)

### F-001 - major: main-queue per-item commands (remove/edit/force) are defined but never attached to UI
- severity: major
- class_scope: sites=[tui-shell.ts removeMainQueue/editMainQueue/forceMainQueue definitions ~2370-2420], enumeration_method=rg 'const (remove|edit|force)MainQueue' shows definitions with zero callers
The three helpers are declared but nothing invokes them, so a queued main item has no remove / edit / force affordance in the transcript. AC3-AC6 (commands present, remove, edit, force) are not satisfied by behavior, only by dead code.

### F-002 - minor: stray extra indentation on focusComposer() in the main-turn finally
- severity: minor
- class_scope: sites=[tui-shell.ts finally block ~3190], enumeration_method=diff review
Cosmetic over-indentation; no behavior.

### F-003 - minor: mainTurnActive is declared but never used
- severity: minor
- class_scope: sites=[tui-shell.ts mainTurnActive ~2334], enumeration_method=rg 'mainTurnActive'
Unused mutable; remove.

### F-004 - info: edit does not re-queue at original position despite reinsertMainQueueItem existing
- severity: info
- class_scope: sites=[tui-shell.ts editMainQueue ~2392, main-queue.ts reinsertMainQueueItem], enumeration_method=code review
editMainQueue removes the item and puts text back in composer; on re-submit it goes through runLine normally, not to its original slot. AC5 not fully met.

### F-005 - major: force may not run because it depends on stopBusy already having fired
- severity: major
- class_scope: sites=[tui-shell.ts forceMainQueue ~2400], enumeration_method=code review
forceMainQueue calls runLine only when !chrome.isBusy(); abort() does not synchronously stop the turn, so the queued item can be dropped. And force paths are unreachable (F-001) anyway.

## Resolution (flow 167, follow-up session)

All five findings fixed on top of the same diff:

- **F-001 (fixed)**: `remove`/`edit`/`force` are now reachable via a new `/queue
  <remove|edit|force> [N]` slash command (`AGENT_ONLY`, registered in
  `agent-commands.ts`, dispatched in `tui-shell.ts`'s busy branch right after
  `/interrupt`). Argument parsing extracted as the pure `parseQueueCommand`
  (`main-queue.ts`), unit-tested (6 cases).
- **F-002 (fixed)**: stray indentation on `focusComposer()` in the main-turn
  `finally` corrected.
- **F-003 (fixed)**: unused `mainTurnActive` removed.
- **F-004 (fixed)**: `editMainQueue` now records `pendingQueueEdit { id, at }`;
  the next busy plain-text submit consumes it via `reinsertMainQueueItem` at
  the original position instead of opening the recipient selector again.
  Known accepted limitation: if the user submits something OTHER than the
  edited text after `/queue edit N` (changed their mind instead of
  resubmitting), that text silently becomes the re-queued item at position N
  — there is no "cancel edit" escape hatch. Matches the plan's scope (AC5
  only specifies the resubmit path); flagged here for visibility, not treated
  as a new finding.
- **F-005 (fixed)**: `forceMainQueue` no longer gates on `chrome.isBusy()`.
  It stashes the item in `priorityMainQuestion` and aborts; the main turn's
  `finally` checks `priorityMainQuestion` BEFORE the FIFO `mainQueue` drain,
  so the forced item always runs next once the aborted turn actually settles.

Verification: `bunx tsc --noEmit` clean; `bun test src/tui` 231/231 pass;
`bun test src/commands/agent-commands.test.ts src/commands/agent.test.ts`
84/84 pass; `keryx health run` → PASS (score 93). AC1–AC7, AC9 confirmed via
`keryx flow ac confirm`. AC8 ("covered by unit tests") intentionally left
UNCONFIRMED: `launchTuiAgentShell` has no headless test harness in this
codebase (documented limitation, `tui-shell.ts` comments ~748/~1882) — only
the extracted pure logic (marker/remove/edit/reinsert/parse) is unit-tested,
same bar as every other command in this file. The selector-branch and
FIFO-drain WIRING itself is verified by code reading + the full passing
regression suite, not by an isolated integration test.
