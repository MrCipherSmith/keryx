# Decisions

- F-001: acted-on — Fix commit 084380c9; merged in dbacee36 (#661): shell-approval.ts:74, shell-permissions.ts:144, :411, :477 all use touchesHumanConfirmation. (valid_followup, post_flow_feedback).
- F-002: acted-on — Fix commit 084380c9; merged in dbacee36 (#661): confirm-token.ts:192 returns token_target_mismatch; service.ts:878 (complete) and :1197 (confirmMint) both derive the target from completionTarget(). (valid_followup, post_flow_feedback).
- F-003: acted-on — Fix commit 084380c9; merged in dbacee36 (#661): command-risk.ts:382 FLOW_CONFIRM_MARKER = /\bflow\s+confirm\b/i; unattended.ts:96 marker is "confirm-token.json". (valid_followup, post_flow_feedback).
- F-004: acted-on — Fix commit 084380c9; merged in dbacee36 (#661): confirm-token.ts:139 parseStoredToken, :150 !isInstant(record["expiresAt"]), :172 /^\d+$/ prefix check. (valid_followup, post_flow_feedback).
- F-005: acted-on — Fix commit 084380c9; merged in dbacee36 (#661): service.ts:1232 refusal names the stale-lock window; store.ts:38 completionInProgressLine shown by flow status. (valid_followup, post_flow_feedback).
- F-006: acted-on — Fix commit 084380c9; merged in dbacee36 (#661): TM-03-terminal-confirmation-token.md:182 'Older keryx' paragraph. (valid_followup, post_flow_feedback).
- F-007: acted-on — Head 21c29e76; merged in dbacee36 (#661): TM-03-terminal-confirmation-token.md:29 Mint row 'With `--merged` the token binds only `merged`, not a commit'; docs/docs/cli-reference.md:2116 carries the same sentence. (valid_followup, post_flow_feedback).
- F-008: acted-on — Head 21c29e76; merged in dbacee36 (#661): command-registry.ts:530-539 summary tells an agent to ask the operator; intents are ['flow confirm', 'operator mints flow confirmation token']. (valid_followup, post_flow_feedback).
