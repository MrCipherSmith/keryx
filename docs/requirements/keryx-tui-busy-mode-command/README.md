# Busy-State /mode Command Notes

Status: **PRD + TRD drafted (2026-08-19), pre-implementation.** See
[prd.md](prd.md) for the formal requirements and [trd.md](trd.md) for the
grounded technical design. This README is the discovery log behind them.

## Origin

Voice request (RU) 2026-08-19: the operator noted that while some commands
work during a busy main turn and some don't, `/mode` (permission-mode
switching — ask/trust/auto) is one that's blocked. They want two things:
(1) `/mode` usable while busy, and (2) a mode switch issued mid-turn to
actually apply to the CURRENTLY RUNNING turn's remaining tool calls, not
just future turns — e.g. switching to `auto` mid-turn should immediately
stop the agent from prompting for approval on its next tool call, not
require waiting for the turn to end.

An Explore-agent investigation (same date) found that (2) already works for
free once (1) is fixed — the approval gate already re-reads the mode value
fresh on every single tool call, not once per turn. The only reason a
mid-turn switch doesn't apply today is that `/mode` never runs while busy at
all (it's silently deferred, same generic bucket as every other
not-explicitly-listed command). The operator confirmed ("Да") they want a
PRD for unblocking `/mode` in the busy branch.

## Current-state findings (code read, 2026-08-19)

- **What `/mode` is**: registered at `src/commands/agent-commands.ts:153-158`
  (`AGENT_ONLY`). `PermissionMode = "ask" | "trust" | "auto"`
  (`src/commands/permission-mode.ts:17-26`, default `"ask"`). This gates
  ONLY the interactive tool-call approval prompt
  (`resolveApprovalDecision()`, `permission-mode.ts:87-108`) — `read` calls
  always auto-approve, `credentials`/`sacReviewConfirmation` are hard floors
  that always ask regardless of mode, `auto` auto-approves everything else,
  `trust` auto-approves unless `destructive`, `ask` (default) always asks.
- **Storage is a live closure, not a per-turn snapshot**: `tui-shell.ts:2262-2264`
  — `let permissionMode: PermissionMode = ...` and
  `io.permissionMode = () => permissionMode;`. The `/mode` handler
  (`tui-shell.ts:3569-3644`) mutates this same variable in place
  (`permissionMode = next;`, line 3600) inside a local `applyMode` closure.
- **Read side is fresh per individual tool call**: `src/commands/agent.ts:1985`
  — `const mode: PermissionMode = permissionMode?.() ?? DEFAULT_PERMISSION_MODE;`
  inside `executeCall()`, called once per pending tool call from two loop
  sites — `agent.ts:1481` (sequential main-turn loop) and `agent.ts:1851`
  (concurrent `spawn_subagent` wave batches). No caching, no per-turn
  snapshot anywhere between the mutation site and this read.
- **Consequence**: a `/mode auto` that could actually reach `applyMode()`
  mid-turn would take effect on the very next not-yet-gated tool call in
  that SAME running turn, with zero change needed to the read/gate side.
- **`/mode` is currently busy-deferred, confirmed by omission not by
  design**: `classifyBusyDispatch()` (`src/tui/busy-dispatch.ts:32-55`,
  shipped in flow 172) explicitly lists `/think`/`/expand`/`/copy`/
  `/workspace`/`/review` as busy-safe; `/mode` isn't named, so it falls to
  the generic `"deferred"` tail. Flow 172's PRD/TRD never mention `/mode` at
  all (confirmed via `keryx ctx rg` across all three of its docs — zero
  hits) — it was never evaluated, not deliberately excluded like
  `/new`/`/resume`/`/sessions`/`/compact`/`/model` (which genuinely touch
  session identity/history/model selection the busy turn owns; `/mode`
  touches neither).
- **UX nuance to resolve**: `/mode`'s handler opens an overlay in TWO cases
  — switching TO `auto` shows a one-time confirmation (`tui-shell.ts:3580-3598`,
  via `chrome.withOverlay`/`showComposerChoice`), and calling `/mode` with no
  argument opens a mode picker (`tui-shell.ts:3621-3643`, same overlay
  mechanism). Both are structurally the same overlay machinery already used
  busy-safe by `/workspace`/`/review` (flow 172) — but those two are
  READ-ONLY modals; `/mode`'s overlays end in a STATE WRITE
  (`permissionMode = next`). This needs an explicit PRD decision, not a
  silent assumption that "same mechanism = same safety."

## Open questions carried into the PRD

- Scope: unblock only the explicit-argument form (`/mode auto`/`/mode trust`/
  `/mode ask`/`/mode clear`) which is the operator's actual stated need, or
  also the no-arg interactive picker? PRD should decide, not leave open.
- Whether the `auto`-confirmation overlay is safe/desirable to show while a
  turn is actively streaming output — TRD-level UX call, grounded against
  how `/workspace`/`/review`'s already-busy-safe overlays behave visually
  during an active turn.

## Next step

Task Manager flow to implement. TRD resolved both open questions: scope
covers all three `/mode` forms (explicit mode, `clear`, no-arg picker) via
one hoisted `runModeCommand` function reused by both branches; the
overlay-during-busy question is resolved by precedent — `/mode`'s overlays
use the exact same `chrome.withOverlay` mechanism already busy-safe for
`/workspace`/`/review`, and `chrome.isBusy()`/overlay state are tracked
independently in `ShellChrome`, so no new interaction-safety code is needed.
