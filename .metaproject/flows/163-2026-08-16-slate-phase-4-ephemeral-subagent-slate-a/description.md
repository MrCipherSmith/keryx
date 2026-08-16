# Slate Phase 4: Ephemeral subagent slate and wrap-up composer

Status: frozen
Source: phase-execution-prompts.md section 4 (docs/requirements/slate/), verbatim scope from launch brief

## Problem

Slate Phases 1-3 (flows 157/160/161) built the storage primitive
(`src/session/slate.ts`), the Anchors/Course/Seeds lifecycle wired into
`keryx shell`/TUI (`src/session/slate-lifecycle.ts`, `slate-course.ts`,
`slate-terminal-state.ts`), and the `/goal` deterministic entry point
(`src/commands/goal-command.ts`). Two pieces of the spec
(`docs/requirements/slate/specification.md` SLATE-6, SLATE-7, SLATE-9) remain
unbuilt:

1. **SLATE-6 (subagent ephemeral slate).** `spawn-subagent-tool.ts` builds a
   hardcoded, minimal child system prompt (`spawn-subagent-tool.ts:255-258`)
   with no Anchors-equivalent, and never touches `slate.json` at all. A
   dispatched child today has no situational awareness, and even if it did,
   nothing would fold its findings back into the parent's slate through a
   structurally separate channel — a naive integration would risk merging a
   child's Seeds into the parent's own `slate.seeds`, misattributing the
   child's work as the parent's.
2. **SLATE-7 (wrap-up composer).** `trusted-wrap-up.ts`'s
   `resolveExplicitWrapUp` throws for any `request.source !== "session"` —
   the `"flow"`-sourced (machine-triggered) wrap-up path used by
   Flow-complete/explicit-command/one-shot-process-termination triggers does
   not exist. There is no code today that groups Seeds by `kind`, calls
   `runModelTurn` for a summary, or decides whether `workspaceId` was ever
   captured before attempting `workspace propose`.

Both gaps block Slate from ever producing a real, attributable knowledge
proposal from either a subagent dispatch or an unattended/one-shot run —
Seeds/Anchors/Course exist but nothing turns them into SAC evidence.

## Expected Outcome

- `spawn-subagent-tool.ts` assembles a fresh child Anchors block at dispatch
  time (mirroring `computeAnchors`) and injects it into the child's system
  prompt/history — the child's own ephemeral slate — kept pure per the scope
  note (assembly logic lives in `spawn-subagent-tool.ts`, not
  `harness/child/*`, which stays fs/clock/RNG-free).
- On dispatch return, the child's slate state (Anchors/Course/Seeds) is
  folded into `parent.slate.childDispatches[dispatchId]` as a tagged,
  non-merged entry with `status: completed | incomplete` — structurally
  separate from `parent.slate.seeds`/`.anchors`/`.course` (AC2/AC3), and
  unreachable by any other code path after the dispatch returns except
  through that snapshot. The existing work-result channel
  (`foldChildSummary`/`quarantineChildSummary`) is unchanged.
- `resolveMachineWrapUp` (new) implements the currently-throwing
  `WrapUpSource === "flow"` case: builds machine evidence (git diff, flow
  snapshot, deduped Seeds — including attributed `childDispatches` entries),
  requires a `slate.workspaceId` captured earlier in the session (never
  guesses one — AC6/AC7 in spec numbering, our frozen AC6), groups Seeds by
  `kind` (untagged → `follow-up`, our frozen AC7), and calls `runModelTurn`
  for a model-authored summary per group — fail-closed with no credential,
  bounded-timeout mechanical fallback with a slow-but-present one.
- Two near-simultaneous wrap-up triggers for the same flow transition
  converge on the same evidence set rather than producing two independently
  reviewable proposals (AC4).
- A one-shot `keryx harness run`/`--goal` invocation reaches wrap-up on
  natural process termination; a `keryx shell` REPL session never does, by
  construction (the trigger call site exists only in the one-shot path) —
  AC8.
- No slate-owned code path in either area calls `flow complete`, `workspace
  propose`, or `workspace review` on a subagent's behalf (AC1) — the parent
  process alone ever calls those, and only through the wrap-up composer
  described above, never automatically inside `spawn-subagent-tool.ts`.

## Out of Scope

- The rest of the spec's SLATE-8/10/11/12/13/14/15 acceptance criteria (AC9
  through AC23 in `specification.md`'s numbering) — those are Phase 2/3
  scope, already shipped, or a later phase's scope (SLATE-10 catch-up,
  SLATE-13 `list-proposals`). This flow's frozen AC1-AC8 are the subset the
  launch brief scoped to SLATE-6/7/9.
- Making `keryx harness run`'s `runOffline` path fully tool-capable (shell,
  slate_write_seed as an actual invokable tool inside that specific runner).
  AC8 is about the wrap-up *trigger* firing at one-shot process termination
  and never firing for the REPL — not about giving the offline runner a full
  tool surface it does not have today. A test may seed the slate directly to
  exercise the trigger.
- A new `keryx workspace propose --source machine` CLI subcommand surface.
  The spec's "Future CLI and MCP surface" section mentions this, but the
  frozen ACs for this flow only require the underlying `resolveMachineWrapUp`
  resolver and its trigger wiring to exist and be exercised by tests/the
  one-shot path — not a new user-facing flag.
- SLATE-10's `unbound-candidate` catch-up *display* (a `keryx workspace
  catch-up` command). AC6 only requires that the composer *writes* the local
  artifact instead of discarding work when `workspaceId` is unset; surfacing
  it in a catch-up UI is SLATE-10, a separate package.
