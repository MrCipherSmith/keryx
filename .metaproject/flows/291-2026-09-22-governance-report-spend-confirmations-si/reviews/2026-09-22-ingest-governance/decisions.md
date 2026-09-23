# Decisions

- F-001: acted-on — src/governance/service.ts added as the zone's facade; src/commands/governance.ts routed through it; merged to main in 1ce98384 via PR #652. (valid_followup, post_flow_feedback).
- F-002: acted-on — governance report and governance show descriptors added to src/standard/command-registry.ts; merged to main in 1ce98384 via PR #652. (valid_followup, post_flow_feedback).
- F-003: acted-on — the tamper-safe attempt persistence in src/flow/service.ts (explicit re-check, save() before the final transition, failed attempt naming the tamper) with its regression test; merged to main in 1ce98384 via PR #652. (valid_followup, post_flow_feedback).
- F-004: acted-on — documented as unbounded by design in src/flow/types.ts and docs/docs/cli-reference.md; merged to main in 1ce98384 via PR #652. No behavior change: unbounded growth remains the intended contract. (valid_followup, post_flow_feedback).
- F-005: acted-on — renderTriggerSpendLine now formats through usd() with a regression test; merged to main in 1ce98384 via PR #652. (valid_followup, post_flow_feedback).
