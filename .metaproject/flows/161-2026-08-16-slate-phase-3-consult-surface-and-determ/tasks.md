# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

T1–T4 are the CLI's default template tasks, superseded by the specific
breakdown below (T5–T12) and marked done immediately with a journal note
rather than left stale.

| ID | Kind | Title |
|----|------|-------|
| T1 | context | (template) Collect remaining context — superseded by T5 |
| T2 | implement | (template) Implement per plan — superseded by T7/T9/T11 |
| T3 | test | (template) Add/adjust tests and make them pass — superseded by T6/T8/T10 |
| T4 | review | (template) Self-review and prepare draft PR — superseded by T12 |
| T5 | context | Context collected directly by the orchestrator (context.md) — no dispatch needed |
| T6 | test | Failing tests for SLATE-2a Anchors auto-inject (AC4): renderAnchorsBlock, touched extraction/change-detection, agent.ts tool-call-loop + ensureSlateOpened injection, tui-shell.ts /model injection |
| T7 | implement | Implement SLATE-2a to make T6's tests pass (Sonnet) |
| T8 | test | Failing tests for SLATE-3a (AC5): slate_read/slate_write_seed tools, getSessionDir threading through shell.ts + tui-shell.ts + interactive-agent-tools.ts |
| T9 | implement | Implement SLATE-3a to make T8's tests pass (Sonnet) |
| T10 | test | Failing tests for SLATE-11 TerminalState (AC3) + SLATE-15 /goal + harness.ts --goal/--workspace flags (AC1/AC2) |
| T11 | implement | Implement SLATE-11 + SLATE-15 to make T10's tests pass (Sonnet, security-adjacent workspace role-check) |
| T12 | review | code-verifier + review-orchestrator; remediate findings; prepare draft PR |
