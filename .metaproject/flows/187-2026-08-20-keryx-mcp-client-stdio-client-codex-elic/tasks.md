# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

| ID | Kind | Title |
|----|------|-------|
| T1 | context | Collect remaining context |
| T2 | implement | Implement per plan (umbrella; closed once T6-T12 land) |
| T3 | test | Add/adjust tests and make them pass |
| T4 | review | Self-review and prepare draft PR |
| T5 | context | Live probe against real `codex mcp-server`: capture elicitation request/response shapes, confirm `codex_call_id` version-fix status (plan step 1) |
| T6 | implement | `src/mcp-client/`: stdio MCP client module on `@modelcontextprotocol/sdk` (plan step 2) |
| T7 | implement | MCP-shaped supervisor for `codex-cli`: new supervision path wired into external dispatch, `ExternalEvent` vocabulary preserved (plan step 3) |
| T8 | implement | Elicitation handling: `resolveApprovalDecision` + `requestApproval`/`AgentIO` wiring, `ElicitResult` response (plan step 4) |
| T9 | implement | Escalation classifier (`destructive`/`credentials`) feeding `resolveApprovalDecision`, ADR-0010 shape (plan step 5) |
| T10 | implement | Three rough-edge defenses: timeout -> named refusal, malformed/empty content -> deny, `codex_call_id` version-skew (plan step 6) |
| T11 | implement | Capability gate: fold into `gdskills.external-agents` descriptor, no second toggle (plan step 7) |
| T12 | implement | TUI surfacing for a pending elicitation (same path as existing write-risk approval prompt) (plan step 10) |
| T13 | test | Fixtures `fixtures/mcp-client/codex/*` + tests for AC1-AC9; confirm original `keryx-external-agent-runtime` AC5 suite passes unmodified (plan step 8). Only `exec-approval` elicitation vendor fields are live-confirmed (T5); `patch-approval`'s field set was only seen through the SDK-stripped view and needs its own live check before being pinned as a fixture. |
| T14 | docs | Revise `keryx-external-agent-runtime` spec/decisions to record the D-05 approval-routing layer (plan step 9) |

## AC coverage map

- AC1, AC2 -> T5, T6, T7
- AC3 -> T7, T8
- AC4, AC5 -> T10
- AC6 -> T8
- AC7 -> T6, T7 (no credential path exists to begin with)
- AC8 -> T7 (verified by T13's unmodified-suite run)
- AC9 -> T9
