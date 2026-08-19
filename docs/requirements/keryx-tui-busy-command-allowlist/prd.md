# PRD: TUI Busy-State Command Allowlist

## 1. Overview

While the main TUI agent turn is running, `runLine`'s busy branch
(`src/tui/tui-shell.ts:3019-3097`) explicitly handles only 6 of the 24
registered slash commands (`/exit`, `/help`, `/interrupt`, `/queue`,
`/status`, `/flows`); every other command — including several that are
provably safe to run concurrently — is refused with a generic "main is busy —
command deferred" message. This PRD extends the explicit busy-branch handling
to five additional commands that are already safe today (`/expand`, `/think`,
`/copy`, `/workspace`, `/review`), closing an inconsistency where the
equivalent `Ctrl+O` keyboard path already works mid-turn but the typed
slash-command form does not.

## 2. Context

- **Product:** Keryx interactive shell (`keryx` CLI, OpenTUI-based)
- **Module:** `src/tui/` (`tui-shell.ts`, `transcript-blocks.ts`,
  `workspace-inspector.ts`, `review-inspector.ts`)
- **User Role:** Keryx operator running the interactive TUI shell while a main
  agent turn is in progress
- **Tech Stack:** TypeScript/Bun, `@opentui/core` (optional, lazily-loaded
  renderer)

## 3. Problem Statement

`chrome.isBusy()` gates most slash commands during a main turn
(`tui-shell.ts:3019` onward). The gate was designed to stop commands that
genuinely race the in-flight turn's own state (session identity, history,
model selection — `/new`, `/resume`, `/sessions`, `/compact`, `/model`, per
the code comment at `tui-shell.ts:3085`: "refuse (avoid racing main
session)"). But the same blanket refusal also catches commands that touch
nothing the main turn owns: `/expand`/`/think`/`/copy` only mutate the local
`BlockRegistry` (`transcript-blocks.ts`), and `/workspace`/`/review` only open
a read-only modal — structurally identical to the already-allowed
`/status`/`/flows`. This is inconsistent (proven by the fact that `Ctrl+O`,
the keyboard equivalent of `/expand`/`/think`/`/copy`'s block-nav actions,
already runs with zero busy gate — `createBlockNavController`'s only gate is
menu/overlay state, `tui-shell.ts:1785`) and gives the operator no way to
inspect tool output, reasoning, workspace state, or the review queue while a
long turn is running, without waiting or interrupting it.

## 4. Goals

- G1: `/expand` works while `chrome.isBusy()` is true, with the same behavior
  it already has when idle (toggle the newest `output`-kind block).
- G2: `/think` works while busy, toggling the newest `thought`-kind block.
- G3: `/copy` works while busy, copying the newest block's full text.
- G4: `/workspace` works while busy, opening its existing read-only modal.
- G5: `/review` works while busy, opening its existing read-only modal.
- G6: The busy-branch refusal message and its behavior for every command not
  named above is unchanged.

## 5. Non-Goals

- Do not change `/new`, `/resume`, `/sessions`, `/compact`, `/model`, or any
  other command not named in Goals — they stay blocked while busy, per the
  existing "avoid racing main session" reasoning.
- Do not change the collapse/expand mechanism itself (`BlockRegistry`,
  `createBlockView`, `createBlockNavController`) — it is already correct and
  out of scope.
- Do not attempt tool-aware/structured diff generation for edit tools — a
  separate, larger topic (see README's "Known limitation" section), not part
  of this PRD.
- Do not add new busy-state UI affordances (e.g. a visible "these commands
  work while busy" hint) unless trivial — this PRD is about unblocking
  behavior, not discoverability.
- Do not change how `Ctrl+O` block-nav mode behaves — it is already busy-safe
  and unaffected by this change.

## 6. Functional Requirements

- FR-1: MUST — `runLine`'s busy branch (`tui-shell.ts:3019-3097`) MUST handle
  `/expand` while `chrome.isBusy()` is true, dispatching to the same
  `toggleNewest("output")` call path used when idle.
- FR-2: MUST — the busy branch MUST handle `/think` while busy, dispatching to
  the same `toggleNewest("thought")` call path used when idle.
- FR-3: MUST — the busy branch MUST handle `/copy` while busy, dispatching to
  the same newest-block-copy call path used when idle.
- FR-4: MUST — the busy branch MUST handle `/workspace` while busy, opening
  the same modal (`workspace-inspector.ts`) used when idle.
- FR-5: MUST — the busy branch MUST handle `/review` while busy, opening the
  same modal (`review-inspector.ts`) used when idle.
- FR-6: MUST — none of FR-1..FR-5's dispatch paths may introduce new shared
  mutable state, new locks, or any synchronization primitive — they must call
  the exact same functions the idle path and/or the existing `Ctrl+O` path
  already call.
- FR-7: MUST — every command not named in FR-1..FR-5 continues to hit the
  existing generic busy refusal (`tui-shell.ts:3086-3097`) unchanged, byte-for-
  byte, including its message text.
- FR-8: MAY — if a command's busy-branch handling differs in any way from its
  idle-branch handling (e.g. because opening a modal while busy needs to avoid
  interfering with the main turn's own rendering), the difference and its
  reason must be documented at the call site with a short comment.

## 7. Non-Functional Requirements

- NFR-1: No behavior change, performance or otherwise, for any command
  already explicitly handled in the busy branch today (`/exit`, `/help`,
  `/interrupt`, `/queue`, `/status`, `/flows`).
- NFR-2: No behavior change for the idle (non-busy) path for any of the five
  target commands — this PRD only adds busy-branch handling, it does not
  modify what each command does.
- NFR-3: The five target commands must remain safe under the same concurrency
  model already accepted for `Ctrl+O` (single-threaded event loop, no shared-
  state corruption possible, "newest block" targeting is best-effort against a
  concurrently-appending main turn) — no new synchronization is required or
  expected.
- NFR-4: Existing tests for `runLine`'s busy branch and for
  `transcript-blocks.ts`'s `toggleNewest`/registry behavior must continue to
  pass unmodified except where they directly assert the old (blocked)
  behavior for one of the five target commands, which must be updated to
  assert the new (allowed) behavior.

## 8. Constraints

- Must reuse `runLine`'s existing busy-branch structure and style
  (`tui-shell.ts:3019-3097`) — same pattern as the existing `/status`/`/flows`
  entries, not a new dispatch mechanism.
- Must not modify `createBlockNavController`, `createBlockRegistry`, or any
  other part of `transcript-blocks.ts`'s public surface beyond what's needed
  to call it from the busy branch (if it isn't already callable as-is from
  there).
- Must not modify `workspace-inspector.ts` or `review-inspector.ts` beyond
  what's needed to open them from the busy branch (if they aren't already
  callable as-is from there).
- Must not widen scope to any command beyond the five named in Goals, even if
  a similar argument could be made for another command — that is a separate,
  future PRD's decision.

## 9. Edge Cases

- EC-1: A new tool-result block registers (via `addBlock`, the main turn's own
  concurrent activity) in the same tick the user issues `/expand`. Accepted
  behavior: best-effort, "newest" is whatever `registry.list()` returns at the
  moment `toggleNewest` runs — this matches the already-accepted behavior of
  the `Ctrl+O` path today and is not a regression to fix here.
  Not part of this PRD.
- EC-2: The user issues `/expand`/`/think` while busy and the registry has no
  blocks yet (turn just started, no tool calls/reasoning emitted yet).
  Accepted behavior: no-op, same as the existing idle-path behavior in this
  situation.
- EC-3: The user issues `/workspace` or `/review` while busy and a modal is
  already open (e.g. from a prior busy-state `/workspace` call, or from an
  approval-gate prompt firing mid-turn). Accepted behavior: whatever the
  existing idle-path modal-stacking/replacement behavior already is — this PRD
  does not change modal-open semantics, only when the command is reachable.
- EC-4: `/copy` while busy on an evicted block (beyond `DEFAULT_MAX_BLOCKS=64`
  retention). Accepted behavior: same as idle — copies `EVICTED_BLOCK_TEXT`
  placeholder, unchanged.

## 10. Acceptance Criteria (Gherkin)

```gherkin
Feature: Busy-state command allowlist

  Scenario: /expand works while the main turn is busy
    Given the main agent turn is in progress (chrome.isBusy() is true)
    And at least one output-kind block has been registered
    When the user types "/expand" and submits
    Then the newest output-kind block's collapsed state toggles
    And no "main is busy — command deferred" message is shown

  Scenario: /think works while the main turn is busy
    Given the main agent turn is in progress
    And at least one thought-kind block has been registered
    When the user types "/think" and submits
    Then the newest thought-kind block's collapsed state toggles

  Scenario: /copy works while the main turn is busy
    Given the main agent turn is in progress
    And at least one block has been registered
    When the user types "/copy" and submits
    Then the newest block's full text is copied to the clipboard

  Scenario: /workspace works while the main turn is busy
    Given the main agent turn is in progress
    When the user types "/workspace" and submits
    Then the workspace inspector modal opens

  Scenario: /review works while the main turn is busy
    Given the main agent turn is in progress
    When the user types "/review" and submits
    Then the review inspector modal opens

  Scenario: an out-of-scope command is still deferred while busy
    Given the main agent turn is in progress
    When the user types "/model" and submits
    Then the "main is busy — command deferred" message is shown
    And no model-selection state changes

  Scenario: five target commands are unaffected while idle
    Given no main agent turn is in progress
    When the user types "/expand", "/think", "/copy", "/workspace", or "/review"
    Then each behaves exactly as it did before this change
```

## 11. Verification

- **How to test:** unit tests around `runLine`'s busy-branch dispatch
  decision, per §12 below — the TRD's initial investigation found `runLine`
  has zero existing test coverage for any of its 24 commands (busy or idle),
  so this now requires a small, purpose-built seam rather than "extend an
  existing test file" (superseded by §12).
- **Where to test:** new test file alongside `tui-shell.ts` covering the
  extracted dispatch-classification function (see §12) — does not require
  mounting the full interactive shell or `@opentui/core` renderer.
- **Observability checks:** none — this is a local, synchronous UI dispatch
  change with no logging, metrics, or telemetry surface to update.

## 12. Addendum: Busy-Branch Dispatch Test Coverage (added 2026-08-19, operator request)

The original PRD (§11) deferred test coverage to "whatever test file already
covers this, if one exists" and the TRD (trd.md, original version) found none
exists and recommended manual/smoke verification only, reasoning that
building a harness was disproportionate to a five-arm insertion. The operator
explicitly asked for this to be covered by tests instead, given `runLine`'s
dispatch has zero coverage today. This addendum makes that a hard requirement
and resolves the "how" the original TRD only investigated.

- FR-9: MUST — `runLine`'s busy-branch dispatch decision (which of the 11
  named commands, or "deferred", or "not a slash command", a given input line
  resolves to while `chrome.isBusy()` is true) MUST be expressed as a pure,
  exported, independently unit-testable function, separate from the
  side-effecting calls (`toggleNewestBlock`, `showWorkspace`, `io.onSystem`,
  etc.) that act on its result. `runLine` calls this function and switches on
  its result; the side-effecting bodies themselves are unchanged from FR-1..FR-5.
- FR-10: MUST — unit tests cover, for the busy-branch decision function: all
  11 explicitly-handled commands (`/exit`, `/help`, `/interrupt`, `/queue`,
  `/status`, `/flows`, plus the 5 new ones), at least one representative
  out-of-scope command (`/model`) resolving to "deferred", and a non-slash
  line resolving to "not a slash command" (the recipient-selector path).
- NFR-5: MUST — the new tests do not require mounting `@opentui/core`, a real
  renderer, or `launchTuiAgentShell`'s full options — they exercise the pure
  decision function directly with plain string/boolean inputs.
- Constraint update: this addendum is the one deliberate, scoped exception to
  the original PRD's Constraints §8 ("must not modify... beyond what's needed
  to call it from the busy branch... not a new dispatch mechanism") — the
  *decision logic* is extracted for testability; the *dispatch structure*
  (which function each command calls, in what order, with what side effects)
  is unchanged. See trd.md §8 for the exact resolved shape.
