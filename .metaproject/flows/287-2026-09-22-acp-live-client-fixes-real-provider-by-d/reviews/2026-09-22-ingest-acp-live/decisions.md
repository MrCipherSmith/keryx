# Decisions

- F-001: acted-on — shellGrantRefresh() ordering fix in commit 2ce9f0b2 (fix(acp): refresh grants first, share server sets, stop servers on signals, scrub what servers return); merged to main in 4aba62bc via PR #648. (valid_followup, post_flow_feedback).
- F-002: acted-on — acpMcpSetKey + shared refcounted server sets in commit 2ce9f0b2; merged to main in 4aba62bc via PR #648. (valid_followup, post_flow_feedback).
- F-003: acted-on — try/finally read loop, shutdown AbortSignal, SIGTERM/SIGINT handlers in commit 2ce9f0b2; merged to main in 4aba62bc via PR #648. (valid_followup, post_flow_feedback).
- F-004: acted-on — tool result/error scrub + stripped credential env keys in commit 2ce9f0b2; merged to main in 4aba62bc via PR #648. (valid_followup, post_flow_feedback).
- F-005: acted-on — tightened assertions in commit 2ce9f0b2, confirmed by mutation (revert-and-rerun); merged to main in 4aba62bc via PR #648. (valid_followup, post_flow_feedback).
- F-006: dismissed-incorrect — no allow_always path exists for a client MCP tool call — use_tool is unconditionally destructive, so this finding's premise does not hold. No code change was needed; confirmed against the code merged to main in 4aba62bc via PR #648. (valid_followup, post_flow_feedback).
- F-007: acted-on — turn-settings resolution wired into ACP turns in commit 2ce9f0b2; merged to main in 4aba62bc via PR #648. (valid_followup, post_flow_feedback).
- F-008: acted-on — raw+escaped scrub matching via the tools.ts redact hook in commit a559059d (fix(acp): scrub secrets where server text is produced, and restart only servers that died); merged to main in 4aba62bc via PR #648. (valid_followup, post_flow_feedback).
- F-009: acted-on — redact-before-truncate ordering in commit a559059d; merged to main in 4aba62bc via PR #648. (valid_followup, post_flow_feedback).
- F-010: acted-on — AcpSessionMcp.revive() in commit a559059d; merged to main in 4aba62bc via PR #648. (valid_followup, post_flow_feedback).
- F-011: acted-on — stopping flag (set on abort and in finally) in commit a559059d; merged to main in 4aba62bc via PR #648. (valid_followup, post_flow_feedback).
- F-012: acted-on — cli-reference secrets paragraph rewritten in commit a559059d; merged to main in 4aba62bc via PR #648. (valid_followup, post_flow_feedback).
- F-013: acted-on — REVIVE_PROBE_MS removed, isClosed()-based revive in commit a559059d; merged to main in 4aba62bc via PR #648. (valid_followup, post_flow_feedback).
