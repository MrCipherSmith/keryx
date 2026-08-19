# PRD: Busy-State /mode Command

## 1. Overview

`/mode` (permission-mode switching — `ask`/`trust`/`auto`) is currently
refused with the generic "main is busy — command deferred" message whenever
a main agent turn is in progress, purely because it was never evaluated for
the busy-branch allowlist (flow 172), not because it's genuinely unsafe like
`/new`/`/resume`/`/sessions`/`/compact`/`/model`. Because the tool-call
approval gate already re-reads the permission mode fresh on every individual
tool call (not once per turn), unblocking `/mode` while busy is sufficient
to make a mid-turn mode switch apply immediately to the running turn's
remaining, not-yet-gated tool calls — no other mechanism is needed.

## 2. Context

- **Product:** Keryx interactive shell (`keryx` CLI, OpenTUI-based)
- **Module:** `src/tui/tui-shell.ts`, `src/tui/busy-dispatch.ts`,
  `src/commands/permission-mode.ts`, `src/commands/agent.ts` (read side only,
  unaffected)
- **User Role:** Keryx operator running the interactive TUI shell who wants
  to change how aggressively the agent asks for approval, including while a
  turn the agent is already running keeps prompting for approval more than
  the operator wants
- **Tech Stack:** TypeScript/Bun, `@opentui/core`

## 3. Problem Statement

`classifyBusyDispatch()` (`src/tui/busy-dispatch.ts:32-55`, shipped in flow
172) explicitly allowlists `/think`/`/expand`/`/copy`/`/workspace`/`/review`
for use while `chrome.isBusy()` is true; every other command, including
`/mode`, falls to the generic `"deferred"` refusal
(`tui-shell.ts`'s busy branch). `/mode`'s actual handler
(`tui-shell.ts:3569-3644`) only mutates a plain closure variable
(`permissionMode`, `tui-shell.ts:2262`) that the approval gate
(`resolveApprovalDecision()` via `agent.ts:1985`, inside `executeCall()`)
already reads fresh on every tool call — there is no per-turn cache to
invalidate. So the operator's stated need — "switch to auto mid-turn and
have the agent stop asking" — is blocked purely by the busy-branch refusal,
not by any architectural gap in how mode is stored or read.

## 4. Goals

- G1: `/mode <ask|trust|auto>` (explicit argument form) works while
  `chrome.isBusy()` is true, applying the switch to the closure variable the
  approval gate already reads fresh per tool call — taking effect on the
  running turn's next not-yet-gated tool call.
- G2: `/mode clear` (clear the persisted project default) works while busy.
- G3: `/mode` with no argument (the interactive picker) works while busy,
  reusing the exact same overlay mechanism already proven busy-safe for
  `/workspace`/`/review` (flow 172).
- G4: Switching TO `auto` while busy still shows its existing one-time
  confirmation overlay (`tui-shell.ts:3580-3598`) — no silent auto-approve
  flip, busy or not.
- G5: The Review UI, side-worker dispatch, and every other consumer of
  `permissionMode`/`io.permissionMode` are unaffected — this PRD only
  changes WHEN `/mode`'s handler is reachable, never what it does once
  reached.

## 5. Non-Goals

- Do not touch `/new`, `/resume`, `/sessions`, `/compact`, `/model`, or any
  other command not named in Goals — they stay blocked while busy, per the
  existing "avoid racing main session" reasoning (unchanged from flow 172).
- Do not change `resolveApprovalDecision()`, `PermissionMode`'s type, or any
  part of `permission-mode.ts`'s decision logic.
- Do not add a mechanism to retroactively un-prompt an approval request that
  is already showing and awaiting the operator's answer for one specific,
  currently in-flight tool call — only calls not yet reached are affected by
  a mode switch, same as if the switch happened between two separate turns.
- Do not add new overlay/UI chrome — reuse the exact existing `/mode`
  handler code and its existing overlay calls, only make them reachable
  while busy.
- Do not change how `auto`'s one-time confirmation overlay looks or behaves
  — same prompt, same wording, same cancel-by-default.

## 6. Functional Requirements

- FR-1: MUST — `runLine`'s busy branch MUST handle `/mode <ask|trust|auto>`
  while busy, dispatching to the exact same `applyMode(...)` logic the idle
  path already uses.
- FR-2: MUST — the busy branch MUST handle `/mode clear` while busy,
  dispatching to the exact same clear logic the idle path already uses.
- FR-3: MUST — the busy branch MUST handle `/mode` with no argument while
  busy, opening the exact same picker overlay the idle path already opens.
- FR-4: MUST — none of FR-1..FR-3's dispatch paths may introduce new shared
  mutable state or duplicate the existing `applyMode`/picker logic — the
  existing `/mode` handler code (or logic extracted from it into a shared
  function callable from both branches) must be reused verbatim.
- FR-5: MUST — every command not named in FR-1..FR-3 continues to hit the
  existing generic busy refusal unchanged.
- FR-6: MUST — the `auto`-confirmation overlay (FR-1's `auto` case) and the
  no-arg picker overlay (FR-3) continue to require an explicit
  confirm/selection while busy — no path is introduced where busy-state
  changes an overlay's default/cancel behavior.
- FR-7: MAY — if opening an overlay while a turn is actively streaming
  output needs any adjustment versus the already-busy-safe `/workspace`/
  `/review` overlays (e.g. z-order, focus return timing), the difference and
  its reason must be documented at the call site with a short comment —
  TRD's call on whether any adjustment is actually needed.

## 7. Non-Functional Requirements

- NFR-1: No behavior change for `/mode`'s idle-path behavior — this PRD
  only adds busy-branch reachability, it does not modify what `/mode` does.
- NFR-2: No behavior change, performance or otherwise, for the six commands
  already explicitly handled in the busy branch before this PRD (`/exit`,
  `/help`, `/interrupt`, `/queue`, `/status`, `/flows`) or the five added by
  flow 172 (`/think`, `/expand`, `/copy`, `/workspace`, `/review`).
- NFR-3: A mode switch applied while busy must be observable on the very
  next tool call the running turn gates — no artificial delay, no
  requirement to wait for the current tool call (if one is already
  in-flight/awaiting approval) to resolve first, beyond that call's own
  already-in-progress approval prompt.
- NFR-4: Existing tests for `runLine`'s busy branch, `classifyBusyDispatch`,
  and `/mode`'s idle-path handler must continue to pass unmodified except
  where they directly assert the old (blocked) busy-branch behavior for
  `/mode`, which must be updated to assert the new (allowed) behavior.

## 8. Constraints

- Must reuse the existing `classifyBusyDispatch`/busy-branch-switch
  structure shipped in flow 172 (`src/tui/busy-dispatch.ts`,
  `tui-shell.ts`'s busy branch) — same pattern as the five commands already
  added there, not a new dispatch mechanism.
- Must not modify `permission-mode.ts`'s public surface or `agent.ts`'s
  gate/read logic — confirmed by investigation that neither needs to
  change (the read side is already fresh-per-call).
- Must not widen scope to any command beyond `/mode`, even if a similar
  argument could be made for another command — that is a separate, future
  PRD's decision.

## 9. Edge Cases

- EC-1: The operator switches to `auto` while busy, right as the running
  turn is about to gate a tool call. Accepted behavior: whichever happens
  first at the JS event-loop level wins — either the gate reads the old
  mode (that one call still asks) or the new mode (that call auto-approves)
  — this is the same non-deterministic-but-harmless race already accepted
  for a switch issued between two idle turns; not a new hazard introduced
  by allowing it mid-turn, and not something this PRD requires
  synchronizing away.
- EC-2: The operator opens the no-arg picker while busy, then the running
  turn finishes (stops being busy) WHILE the picker overlay is still open.
  Accepted behavior: whatever `/workspace`/`/review`'s existing overlays
  already do in this situation (they don't get force-closed by busy-state
  changing underneath them) — TRD should confirm this by reading their
  actual overlay lifecycle, not assume.
- EC-3: The operator issues `/mode auto` while busy, cancels the
  confirmation overlay. Accepted behavior: unchanged — mode stays whatever
  it was, `chrome.showToast("Cancelled — mode unchanged.")`, identical to
  the idle-path today.
- EC-4: `/mode clear` while busy, with no project default currently set.
  Accepted behavior: unchanged — same message/no-op as idle-path today.

## 10. Acceptance Criteria (Gherkin)

```gherkin
Feature: Busy-state /mode command

  Scenario: /mode <mode> applies immediately to the running turn
    Given the main agent turn is in progress (chrome.isBusy() is true)
    And the current permission mode is "ask"
    When the user types "/mode auto" and confirms the overlay
    Then the permission mode becomes "auto"
    And the very next tool call the running turn attempts to gate is
      auto-approved without a prompt (except credential-touching commands)

  Scenario: /mode clear works while busy
    Given the main agent turn is in progress
    And a project default permission mode is set
    When the user types "/mode clear" and submits
    Then the project default is cleared
    And the session's current mode is unchanged

  Scenario: /mode with no argument opens the picker while busy
    Given the main agent turn is in progress
    When the user types "/mode" and submits
    Then the permission-mode picker overlay opens
    And selecting a different mode applies it the same way the idle path does

  Scenario: switching to auto while busy still requires confirmation
    Given the main agent turn is in progress
    When the user types "/mode auto" and submits
    Then a one-time confirmation overlay appears
    And the mode does not change until the user explicitly confirms

  Scenario: an out-of-scope command is still deferred while busy
    Given the main agent turn is in progress
    When the user types "/model" and submits
    Then the "main is busy — command deferred" message is shown unchanged

  Scenario: /mode is unaffected while idle
    Given no main agent turn is in progress
    When the user types "/mode auto", "/mode clear", or "/mode"
    Then each behaves exactly as it did before this change
```

## 11. Verification

- **How to test:** unit/integration tests around `classifyBusyDispatch`
  (new `"mode"` target case) and `runLine`'s busy-branch switch, asserting
  `/mode <ask|trust|auto>`, `/mode clear`, and `/mode` (no arg) all dispatch
  correctly while `chrome.isBusy()` is true, using the same test approach
  established for flow 172's five commands.
- **Where to test:** wherever flow 172's busy-branch tests for `/think`/
  `/expand`/`/copy`/`/workspace`/`/review` landed (per that flow's TRD, a
  new/extended test file covering `classifyBusyDispatch`) — extend the same
  file/suite rather than inventing a new one.
- **Observability checks:** none — this is a local, synchronous UI dispatch
  change with no logging, metrics, or telemetry surface to update.
