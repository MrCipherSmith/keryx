# Implementation Plan

Status: frozen

## Approach

Four independent-ish feature slices sharing Phase 1/2's storage/lifecycle
primitives, delivered as three TDD (tests-creator → task-implementer) pairs
plus one cross-cutting verification/review pass — matching flow 160's actual
granularity and rigor:

1. **SLATE-2a — Anchors auto-inject** (AC4). Entirely inside
   `src/session/slate.ts` (new `renderAnchorsBlock`), `src/session/
   slate-lifecycle.ts` (new touched-tracking helper), and
   `src/commands/agent.ts` (tool-call-loop + `ensureSlateOpened` injection
   points) — PLUS `src/tui/tui-shell.ts`'s `/model` handler (the one
   surface-specific hook this phase has; readline agent mode structurally
   has no `/model` command, verified by grep in context.md). No change to
   `runAgentTurn`'s existing `options.slateSession` threading is needed —
   both surfaces already pass it (Phase 2).
2. **SLATE-3a — `slate_read`/`slate_write_seed`** (AC5). New
   `src/harness/tool/builtin/slate-tool.ts` + a lazy `getSessionDir` getter
   threaded through `makeAgentDeps` (`shell.ts`)/`launchTuiAgentShell`
   (`tui-shell.ts`)/`buildInteractiveAgentTools`
   (`interactive-agent-tools.ts`) — the single factory both surfaces call,
   so wiring it once there is sufficient once the getter reaches it.
3. **SLATE-11 + SLATE-15 — TerminalState and `/goal`** (AC1/AC2/AC3). New
   `AgentDeps.unattended` flag + `TerminalState` type/emission in
   `agent.ts`; new `/goal` command in both `shell.ts` and `tui-shell.ts`;
   `--goal`/`--workspace` flags in `harness.ts`. Grouped together because
   both need the SAME `WorkspaceService`-role-check helper and both are
   security-adjacent (fail-closed validation, no free-text leakage into
   `history`).
4. **Cross-cutting verification** — code-verifier + review-orchestrator,
   remediate, prepare the draft PR.

## Why tests-creator → task-implementer per slice

The brief's delivery protocol calls for this pairing explicitly. Each
tests-creator dispatch is handed the exact function/module signatures already
designed in `context.md` (not asked to invent an interface), so its failing
tests are grounded in a concrete contract the following task-implementer
dispatch then makes pass.

## Steps

1. T2 (test) → T3 (implement): SLATE-2a Anchors auto-inject.
2. T4 (test) → T5 (implement): SLATE-3a `slate_read`/`slate_write_seed`.
3. T6 (test) → T7 (implement): SLATE-11 TerminalState + SLATE-15 `/goal`.
4. T8 (review): code-verifier + review-orchestrator, remediate, draft PR.

## Model selection

- Slices 1–3 (task-implementer dispatches): Sonnet. Each touches 3+ files
  with non-obvious interactions (closure/TDZ threading in slice 2, fail-closed
  ordering + cross-surface command wiring in slice 3, change-detection +
  token-bounding design in slice 1).
- tests-creator dispatches: Sonnet (grounding failing tests in a not-yet-built
  interface requires the same judgment as building it).
- No task in this flow is mechanical enough for Haiku on its own merits; the
  one plausibly-mechanical piece (`--goal`/`--workspace`/`--unattended` CLI
  flag parsing) is folded into slice 3 because it shares a helper and a
  review unit with the security-adjacent workspace validation.

## Risks

- Missing the `/model`/`/goal` wiring on one of the two agent-mode surfaces
  (the exact Phase 2 lesson) — mitigated by an explicit grep-verification
  instruction in every dispatch touching either surface, and by review.
- TDZ/closure threading of `getSessionDir` across `shell.ts`/`tui-shell.ts`
  getting the timing wrong (reading `slateSession` before it is assigned) —
  mitigated by dedicated tests exercising the TUI's deps-rebuild-before-
  session-open ordering.
- History bloat from injecting an Anchors block on every tool call —
  mitigated by change-detection (only inject when `touched`/`tree`/`runtime`
  actually changed) plus `assembleContext` token-bounding on the rendered
  view.

## Out of Scope (see description.md)

No wrap-up composer (SLATE-7), no `harness run` → `runAgentTurn` wiring, no
subagent `childDispatches` snapshot (SLATE-6).
