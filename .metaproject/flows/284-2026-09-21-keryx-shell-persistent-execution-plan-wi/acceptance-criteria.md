# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: The main interactive agent exposes typed plan_set, plan_update, and plan_get tools in both TUI and readline shells, while child and subagent tool rosters remain unchanged.
- AC2: A plan update enforces stable item identifiers, valid statuses, at most one in-progress item, and optimistic revision checking so stale writes fail visibly.
- AC3: The active execution plan is persisted in the session Slate and is restored when that session is resumed; a session without a plan remains backward-compatible.
- AC4: Each agent continuation receives a bounded current-plan snapshot, and an attempted final response with pending or in-progress items triggers a bounded continuation instead of silently declaring the task finished.
- AC5: The TUI renders a Plan panel immediately above Background Jobs only when a plan exists, displays no more than seven item rows, and centers the in-progress item when enough preceding and following rows exist.
- AC6: The Plan panel distinguishes completed, in-progress, pending, blocked, and skipped states, truncates rows to the sidebar width, and repaints when plan state changes without repainting on unrelated job-output chunks.
- AC7: Existing /plan read-only permission-mode behavior remains intact, and session-plan metadata tools do not grant filesystem or command mutation capability.
- AC8: Focused unit and TUI tests cover state transitions, persistence and resume, tool wiring, completion continuation, window selection at list boundaries, empty-plan visibility, and panel ordering.
