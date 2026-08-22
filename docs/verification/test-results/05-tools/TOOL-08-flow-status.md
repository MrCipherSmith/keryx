# TOOL-08 — flow_status

**Area:** Built-in agent tools · **Date:** 2026-08-22 · **Status:** PASS

## Test case (from the catalog)

> Tool: `flow_status` | Test: Ask about current work state | Expected: Matches `keryx flow status <id>` CLI

## What was actually run

```bash
printf 'what is the status of flow 186?\n' | DEEPSEEK_API_KEY="$DS_KEY" keryx shell --no-tui --provider deepseek
```

and independently:

```bash
keryx flow status 186
```

Session id: `9d879404` (shell session)

## Captured output (terminal text capture — no visual PTY available in this environment)

### Shell output (readline method with deepseek provider):

```text
  keryx — deepseek/deepseek-chat · agent · ~/goodea/keryx
  Type a message, or /help for commands.

  ❯   Session 9d879404 · per-project (keryx shell -c to continue)

  ● keryx

  ⚙ flow_status(id=186)
  ↳ Flows (1): · +1 more (/expand)
  Flow 186 is done — completed 15/15 tasks. It was "Bounded autonomous continuation for /goal (Task-Manager-backed, self-verified stop)".

  ↑8829 ↓36 tokens
```

### CLI output (direct `keryx flow status 186`):

```text
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  flow 186
  Bounded autonomous continuation for /goal (Task-Manager-backed, self-verified stop)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  status:  done
  source:  github-issue (https://github.com/MrCipherSmith/keryx/issues/379)
  AC:      frozen, 9 confirmed
  PR:      https://github.com/MrCipherSmith/keryx/pull/378

Tasks (15/15)
  ✓ T1 Collect remaining context (context)
  ✓ T2 Implement per plan (implement)
  ✓ T3 Add/adjust tests and make them pass (test)
  ✓ T4 Self-review and prepare draft PR (review)
  ✓ T5 Confirm SLATE numbering, flow-plan granularity, and existing token/turn budget accounting to reuse (context)
  ✓ T6 parseGoalArgs: recognize trailing --auto [N], composable with --workspace (implement)
  ✓ T7 Auto-provision + bind a Task Manager flow when --auto has none bound (implement)
  ✓ T8 Arm SlateSessionRef.autoGoalRounds, in-memory only (implement)
  ✓ T9 Continuation loop in runGoalCommand: reuse isCourseDone, re-invoke runAgentTurn, decrement round budget (implement)
  ✓ T10 Verifier spawn_subagent call before final stop; surface gaps; count against round cap (implement)
  ✓ T11 Confirm closeSlateOnFlowDone/wrap-up dispatch needs no change once the loop stops (implement)
  ✓ T12 Per-surface progress-line wiring in shell.ts/tui-shell.ts for a multi-round --auto run (implement)
  ✓ T13 Unit tests for every ACn (round cap, forked-session non-inheritance, unmodified SLATE-18 suite) (test)
  ✓ T14 Self-review and prepare draft PR (review)
  ✓ T15 Update docs/requirements/goal-continuation/ with as-built design; cross-link SLATE-N table (docs)

Recent history
  2026-08-21T16:33:55.356Z task-done: T5: Confirm SLATE numbering, flow-plan granularity, and existing token/turn budget accounting to reuse
  2026-08-21T16:53:50.332Z implemented: draft PR: https://github.com/MrCipherSmith/keryx/pull/378 (warning: PR is not a draft)
  2026-08-21T16:53:57.056Z completing
  2026-08-21T16:54:00.150Z done: all gates passed
  2026-08-21T17:05:00.000Z source-linked: Manual hand-edit (no CLI command retrofits `source` post-init): retroactively linked to https://github.com/MrCipherSmith/keryx/issues/379, created and closed for the record after the flow was already done.
```

## Cross-checks (if applicable)

The shell's `flow_status` tool call produced output consistent with the CLI's direct query:

1. **Flow ID and status match:** Both report flow 186 as `done`
2. **Task count matches:** Shell reports "15/15 tasks completed", CLI shows "Tasks (15/15)" with all 15 tasks marked ✓
3. **Description matches:** Both sources report the exact same flow description: "Bounded autonomous continuation for /goal (Task-Manager-backed, self-verified stop)"
4. **Completeness difference:** Shell output is a condensed summary (core facts only), CLI output provides full details including source issue, PR link, AC status, and task breakdown — expected difference in scope between agent-facing and CLI presentation

The model successfully invoked the `flow_status` tool with the correct parameter (`id=186`), received real flow data from the store, and reported it accurately.

## Summary

The `flow_status` tool behaves exactly as documented: when asked "what is the status of flow 186?", the model called the tool with the correct id parameter and received real data that matched the independent CLI query. Both outputs confirm flow 186 is done with all 15 tasks completed. The tool integration is working correctly.

## Analysis

The test confirms that:

1. **Tool invocation:** The model correctly parsed the user's natural-language question and invoked `flow_status(id=186)` with the proper parameter.
2. **Data accuracy:** The returned flow status data matches what the CLI command independently queried, confirming the tool reads from the authoritative flow store.
3. **Output presentation:** The shell's tool output (condensed summary) differs intentionally from the CLI's presentation (detailed breakdown) — both are appropriate for their contexts (agent-facing vs. human-facing).
4. **Real provider call:** The test used a fresh deepseek session with a real API call, not a mock or cached response.

This is exactly what the test specification expected: the agent-accessible `flow_status` tool produces results that align with the `keryx flow status <id>` CLI command.

## Improvement / fix suggestion

None — behaves as documented.
