# TUI Busy-State Command Allowlist Notes

Status: **PRD + TRD drafted (2026-08-19), pre-implementation.** See
[prd.md](prd.md) for the formal requirements and [trd.md](trd.md) for the
grounded technical design. This README is the discovery log behind them.

## Origin

Voice request (RU) 2026-08-19: the operator asked about two things at once —
(1) whether tool-call output (including code diffs) could render collapsed by
default with an explicit expand step, and (2) a re-review of which TUI commands
can safely run while the main agent turn is busy, so read-only commands
(`/status`-like) aren't refused for no reason.

An Explore-agent investigation (same date) found that (1) is **already fully
implemented** — collapse-by-default, `/expand`/`/think`/`Ctrl+O`, and automatic
diff coloring on expand all already exist. (2) is a real, narrow gap: most
commands are refused while busy even when they are provably safe. This PRD
covers only (2).

## Current-state findings (code read, 2026-08-19)

- **`src/tui/tui-shell.ts:3006-3141`** — `runLine(line)`, the central command
  dispatcher. From `tui-shell.ts:3019` onward, while `chrome.isBusy()` is true,
  only 6 of the 24 registered commands (`src/commands/agent-commands.ts:59-171`)
  are explicitly handled: `/exit` (3021-3028), `/help` (3030-3043), `/interrupt`
  (3044-3052), `/queue <remove|edit|force> [N]` (3053-3076), `/status`
  (3077-3080), `/flows` (3081-3084). Everything else falls through to a generic
  refusal at `tui-shell.ts:3086-3097`: `"◇ main is busy — command deferred. Ask
  a normal question for a side worker, or wait."`
- **Busy-state source of truth**: `chrome.isBusy()` (`shell-chrome.ts:297,981`,
  flipped by `startBusy()`/`stopBusy()`), plus `mainTurnAbortController`
  (`tui-shell.ts:1601`).
- **`/expand` and `/think` are already safe today, just not wired into the busy
  branch**: both call `toggleNewest(kind?)` (`transcript-blocks.ts:1334-1341`),
  which only mutates the local `BlockRegistry` (`createBlockRegistry()`,
  `transcript-blocks.ts:126-254`). Proof this is already safe: the equivalent
  `Ctrl+O` keyboard path (`createBlockNavController()`,
  `transcript-blocks.ts:1162-1380`, wired unconditionally at
  `tui-shell.ts:3778-3780`) has **no busy gate at all** — its only gate is
  `isBlocked()` = menu/overlay active (`tui-shell.ts:1785`). So a user can
  already expand/collapse/copy blocks via keyboard mid-turn; only the *typed*
  slash-command equivalents are refused.
- **`/copy`** (`tui-shell.ts:3332-3341`) — same registry, read + clipboard only,
  same safety argument as `/expand`/`/think`.
- **`/workspace`** (`src/tui/workspace-inspector.ts:43-46`) and **`/review`**
  (`src/tui/review-inspector.ts:45`) — both open a read-only modal, structurally
  identical to the already-allowed `/status`/`/flows`, but not in the explicit
  busy-branch list, so they fall into the generic refusal for no principled
  reason.
- **Commands that must stay blocked, confirmed intentional**: `/new`,
  `/resume`, `/sessions`, `/compact`, `/model` — the existing code comment at
  `tui-shell.ts:3085` states the reasoning explicitly: "refuse (avoid racing
  main session)." These touch session identity/history/model selection that the
  in-flight turn is actively reading/writing.
- **Concurrency model**: single-threaded event loop — no true data race is
  possible for any of the target commands. The only real hazard is semantic:
  "toggle the newest block" can target a different block than intended if a new
  tool-result block registers between keystroke and toggle, because the main
  turn is concurrently calling `addBlock` (`tui-shell.ts:474-501`). This is a
  pre-existing, already-tolerated risk (the `Ctrl+O` path has lived with it
  since flow 109/115), not a new one introduced by unblocking `/expand`.

## Known limitation noted but explicitly out of scope

No in-repo file-edit tool produces structured `oldString`/`newString` diff
hunks (searched `src/harness/tool/builtin/`, found none) — the diff coloring on
expand is a generic "looks like a unified diff" content sniff
(`looksLikeUnifiedDiff`, `src/lib/md-blocks.ts:135-146`), not tool-aware. Diff
quality on expand is only as good as whatever raw text the upstream tool
already returns. This is a separate, larger topic; not part of this PRD.

## Next step

Task Manager flow to implement, per the TRD's resolved edit shape (insert
three `command?.name` arms plus two `isBusyReadonlyCommand` arms into
`runLine`'s busy branch, `tui-shell.ts:3006-3097`). TRD also found that
`runLine`'s dispatch has zero existing test coverage of any kind, busy or
idle — verification for this change is manual/smoke-only, matching the
existing precedent for the six commands already handled while busy.
