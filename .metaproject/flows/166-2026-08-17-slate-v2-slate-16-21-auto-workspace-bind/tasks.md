# Tasks

- T1 (implement) — SLATE-20: review confirm-token. `keryx workspace
  confirm-review <workspace-id> <proposal-id>` mints a 2-min, single-use,
  `(workspaceId, proposalId)`-bound token; `decision: "accepted"` in both
  `commands/workspace.ts`'s `review` handler and `mcp/tools.ts`'s
  `sac.review` requires it (`token_required`/`token_invalid` typed failure
  otherwise); `"rejected"`/`"dismissed"` unaffected; `confirm-review` itself
  is `risk: "shell"` via `shell_exec`, not any agent-native tool.
- T2 (implement) — SLATE-21: finish SLATE-7 machine evidence.
  `resolveSessionWrapUp`/the wrap-up composer builds evidence from
  `anchors.touched` + git diff + `course.flowRef`/flow status + `seeds[]` as
  primary text; full `exportSessionMarkdown` transcript kept as a linked
  reference attachment, not the sole/embedded evidence.
- T3 (implement) — SLATE-19: cross-runtime agent-tool parity. Four new
  `risk: "read"` interactive tools in `interactive-agent-tools.ts`:
  `workspace_create`, `workspace_list`, `workspace_show`, `workspace_propose`
  (`sessionId` defaults to current session). No `workspace_review` tool
  anywhere.
- T4 (implement) — SLATE-16: workspace resolve-or-create. New optional
  `workspaceId` on the flow record; procedure triggered at flow-creation and
  at slate-open without a bound workspace (default action-intent trigger or
  bare `/goal`) — calls `workspace_list`, model judges topic match, creates
  via `workspace_create` if none, binds `flow.workspaceId` or
  `slate.workspaceId` directly.
- T5 (implement) — SLATE-17: mid-session re-evaluation. The existing
  close-trigger heuristic (SLATE-5/`isActionRequest`, without `/clear`)
  additionally re-runs T4's procedure.
- T6 (implement) — SLATE-18: autonomous wrap-up dispatch. Wrap-up composer
  calls `workspace_propose` itself on SLATE-7's existing triggers when
  `workspaceId` is bound, without waiting for a separate human command.

Each task closes only after: focused tests pass, `bunx tsc --noEmit`
clean, and the specific AC-N it targets is demonstrably true (see
acceptance-criteria.md).
