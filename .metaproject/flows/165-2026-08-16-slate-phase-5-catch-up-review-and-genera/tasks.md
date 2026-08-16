# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`. IDs/kinds below match the
actual flow.json tasks (flow init's default T1-T4); execution order is
T1 -> T3 (tests first, TDD) -> T2 (implementation, two tracks) -> T4 (review).

| ID | Kind | Title | Notes |
|----|------|-------|-------|
| T1 | context | Collect remaining context | Done inline by flow-orchestrator: read specification.md/agent-protocol.md (SLATE-10/SLATE-13), sac-workspace-lifecycle specification.md WSL-2, proposal-lifecycle.ts, workspace-service.ts, fs.ts, store.ts, slate-course.ts, slate.ts, slate-terminal-state.ts, machine-wrap-up.ts, commands/workspace.ts, session/paths.ts. Findings folded into description.md/plan.md/context.md, including a real undocumented gap (TerminalState never persisted to disk). |
| T3 | test | Write failing tests for AC1-AC5 | tests-creator, Sonnet. See plan.md Steps section 1 for full required-coverage list: AC1 archived-workspace parity, AC2 four-section structural test, AC3 evidence-drift-before-accept staleness, AC4 cwd-isolation, AC5 live-lock-never-unknown plus stale-lock-falls-through, plus isLockHeld/listProposedProposals/listForActor/writeTerminalState unit+integration coverage. |
| T2 | implement | Implement per plan (Track A + Track B) | Track A (task-implementer, Sonnet): isLockHeld + DEFAULT_LOCK_STALE_MS extraction (fs.ts), listProposedProposals/listVisibleProposedProposals (proposal-lifecycle.ts), WorkspaceService.listForActor (workspace-service.ts), writeTerminalState + emitTerminalState wiring (slate-terminal-state.ts/agent.ts), SessionSummary runMode/courseStatus fields (store.ts). Track B (task-implementer, Sonnet): isEvidenceFresh (proposal-lifecycle.ts), new src/sac/catch-up.ts classifier (four hard-separated categories, priority-ordered session classification, only-slate-engaged-sessions filter), keryx workspace catch-up/list-proposals subcommands (commands/workspace.ts). Both tracks must make T3's tests pass. |
| T4 | review | Self-review and prepare draft PR | code-verifier (scoped to touched files + typecheck + `health run --changed` during iteration, one full-suite run right before PR per the speed instruction) + review-orchestrator; fix loop; then draft PR against main, `/code-review` high effort, fix findings, CI green, merge, AC confirm, flow complete, bookkeeping PR. |
