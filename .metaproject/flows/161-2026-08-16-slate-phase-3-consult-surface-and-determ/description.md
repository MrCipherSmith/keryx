# Slate Phase 3: Consult surface and deterministic entry

Status: frozen
Source: docs/requirements/slate/phase-execution-prompts.md section 3

## Problem

Slate Phase 1 (flow 157) shipped the storage skeleton (`slate.ts`) and Phase 2
(flow 160) wired Anchors computation, open/close lifecycle, Course/Seeds
storage, and the unattended interactive gate. But three real gaps remain that
make Phase 1/2's work practically inert or unsafe once a session runs long
enough to matter:

1. Anchors are computed once at slate-open and never surface to the model
   again mid-session — `anchors.touched` is always `[]` by construction
   (Phase 1's own doc comment defers this explicitly to "Phase 3+"). A model
   has no live situational awareness of what it has actually touched.
2. There is no way for the model to explicitly consult Course/Seeds content
   (`workspace_overview`/`workspace_read` exist for SAC; nothing analogous
   exists for the session-local slate).
3. `finishWithBudgetSummary` (`src/commands/agent.ts:976-1087`) always pushes
   a free-text `"Do NOT call tools."` instruction into shared session
   `history` on budget exhaustion — including in a hypothetical unattended
   run, where nothing distinguishes a structured stop condition from ordinary
   conversation, and the instruction can leak into a later turn.
4. Nothing lets an operator or the model deterministically open a slate and
   bind a workspace id up front — `/goal` does not exist, so
   `SLATE-15`'s workspace-binding requirement (needed by wrap-up, not built
   this phase) has no entry point at all.

## Expected Outcome

- SLATE-2a: `renderAnchorsBlock` (in `src/session/slate.ts`), bounded via the
  existing `assembleContext` (`src/ctx/assembly.ts`), is injected as a
  harness-written `role:"user", provenance:"project"` history message
  immediately after a harness effect that changes
  `anchors.touched`/`tree`/`runtime` — tool call completed, worktree resolved
  (slate open/reopen, which recomputes `root`/`tree` from live git state),
  `/model` switch, or subagent spawn/return (subagent spawn is itself a tool
  call in the parent's own loop) — never baked into the static
  `systemInstruction`/`orient` block.
- SLATE-3a: new `slate_read`/`slate_write_seed` interactive tools, mirroring
  `workspace-context-tool.ts`'s shape, giving the model an EXPLICIT,
  agent-pulled way to read Course/Seeds — never auto-injected every round.
- SLATE-15: `/goal <text> [--workspace <id>]` shell command (both agent-mode
  surfaces — readline `commands/shell.ts` and the default OpenTUI
  `tui/tui-shell.ts`) and mirrored `keryx harness run --goal "<text>"
  --workspace <id> [--unattended]` CLI flags. `--workspace <id>` is validated
  via the existing `WorkspaceService` role-check (same construction
  `commands/workspace.ts`'s `service()` uses); an invalid/invisible id is
  rejected explicitly (fail closed) and the slate is never opened in that
  case. Omitting `--workspace` never auto-creates a workspace.
- SLATE-11: structured `TerminalState` emission
  (`status`,`reason`,`courseSnapshot`,`anchorsSnapshot`,`occurredAt`) replacing
  `finishWithBudgetSummary`'s free-text push, and intercepting an
  unattended session's `ask_user` call, when `AgentDeps.unattended === true`.
  Interactive (non-unattended) callers are byte-for-byte unaffected —
  `unattended` is undefined/false for every existing `keryx shell`/TUI call
  site today.

## Out of Scope (deferred to a later phase, per
docs/requirements/slate/phase-execution-prompts.md section 3 and the spec's
own functional-surface table)

- SLATE-6 (subagent two-channel `childDispatches` merge) — spawn_subagent's
  own child gets no slate of its own this phase; only the PARENT's Anchors
  update on spawn/return.
- SLATE-7 (wrap-up composer / `workspace propose --source machine`) and
  SLATE-10 (`workspace catch-up`) — no wrap-up trigger is implemented; SLATE-11
  only emits the structured stop record, it does not compose a proposal.
- Wiring `keryx harness run`'s `--goal`/`--workspace`/`--unattended` flags into
  an actual `runAgentTurn`-style execution loop — `harness run` today uses a
  separate Release-0 single-turn `RunResult` machinery
  (`src/harness/...`/`HarnessRunInput`) with no tool registration and no slate
  integration at all; that integration point does not exist yet and building
  it is out of this phase's scope. This phase only adds the flags, parses
  them, and fail-closed validates `--workspace` the same way `/goal` does.
- Any change to `--unattended`'s existing SLATE-8 accept/propose gating
  (`authorizeSacUse`/`ProposalLifecycleService.review()`) — that landed in
  Phase 2 and is untouched here.
