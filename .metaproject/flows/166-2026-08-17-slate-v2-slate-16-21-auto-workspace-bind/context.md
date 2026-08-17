# Context

## Source of truth

- `docs/requirements/slate/prd.md` v2.0.0 — Product requirements SLATE-16..21.
- `docs/requirements/slate/specification.md` v2.0.0 — Functional surface,
  Data contracts, Future CLI/MCP surface, Permission model, AC-24..AC-33.
- `docs/requirements/shared-agent-context-lifecycle-binding/README.md` v0.2.0
  — RP-03's narrowed remaining scope (do not re-implement what it still owns).

## Key files this flow touches

- `src/sac/session-wrap-up.ts`, `src/sac/trusted-wrap-up.ts`,
  `src/sac/proposal-lifecycle.ts` — SLATE-20 token gate, SLATE-21 evidence.
- `src/commands/workspace.ts`, `src/mcp/tools.ts` — `propose`/`review`
  handlers SLATE-20/21 extend; SLATE-19 needs `list`/`create`/`show`/
  `propose` parity confirmed against these.
- `src/sac/workspace-service.ts` (`localWorkspaceAuthorizationServer`,
  `~line 280-284`) — OS-UID-only actor; SLATE-20's token check lives here or
  adjacent, not a new identity model.
- `src/commands/interactive-agent-tools.ts`,
  `src/harness/tool/builtin/workspace-context-tool.ts`,
  `src/harness/tool/builtin/slate-tool.ts` (pattern to mirror for
  `risk: "read"` tools) — SLATE-19's four new tools.
- `src/session/slate.ts` (`Slate.workspaceId`), `src/session/slate-course.ts`
  (`Slate.course.flowRef`), `src/flow/types.ts` (new optional `workspaceId`
  field), `src/commands/goal-command.ts`, `src/commands/agent.ts`
  (`isActionRequest`/close-trigger heuristic) — SLATE-16/17.
- `src/commands/agent.ts` (SLATE-7's existing wrap-up trigger points) —
  SLATE-18.

## Prior session findings (already verified, do not re-derive)

- `resolveSessionWrapUp` (`src/sac/session-wrap-up.ts:55-110`) calls
  `exportSessionMarkdown` — zero references to `seeds`/`course`/`readSlate`
  in the whole file.
- `sac.review` (`src/mcp/tools.ts:129-145`) sets `interactive: true`
  unconditionally with a comment acknowledging this is a known, deliberately
  deferred trust gap, not a real check.
- `interactive-agent-tools.ts`'s `buildInteractiveAgentTools` has
  `workspace_overview`/`workspace_read` only — no `propose`/`create`/`list`.
- `Slate` type (`src/session/slate.ts:63-69`): `workspaceId?`, `anchors`,
  `course: { flowRef? }`, `seeds`, `childDispatches?` — `workspaceId` and
  `flowRef` are currently independent siblings, no derivation between them.
- `parseGoalArgs`/`runGoalCommand` (`src/commands/goal-command.ts`) is the
  ONLY existing write site for `slate.workspaceId` today.
