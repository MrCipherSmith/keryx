# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- Every criterion ends with [verify: exec `<command>`],
  [verify: invariant `<command>`], [verify: judged] or
  [verify: none — <reason>].
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: A shared operator-confirmation helper builds a card (title, decision lines, subject) and a single-use in-memory token; the driver asks for it in every permission mode including auto, saved approvals, review-auto and ask_user auto-answer cannot answer it, and an unattended run (no requestApproval) is denied without effect. Tests drive one confirmation tool through the agent driver in auto mode and unattended mode. [verify: exec `bun test src/commands/operator-confirm-tools.test.ts`]
- AC2: `review_chunks_answer`, `review_publish`, `review_waive_coverage` and `review_waive_readiness` tools exist; on yes each performs the same effect as its CLI counterpart in process and records the card text, the answer, the time and `confirmedVia: "tui-card"`; on no nothing changes. Tests per tool, including the no path. · sensitive: failure-scenario [verify: exec `bun test src/commands/operator-confirm-review-tools.test.ts`]
- AC3: `flow_confirm`, `external_apply`, `learn_accept`, `learn_promote`, `learn_graduate`, `schedule_resume`, `schedule_run`, `schedule_pause` and `schedule_remove` tools exist with the same yes/no/record contract; `flow_confirm` returns a token `flow complete --confirm-token` accepts; `external_apply` shows the full patch hash on the card. Tests per tool, including the no path. · sensitive: failure-scenario [verify: exec `bun test src/commands/operator-confirm-other-tools.test.ts`]
- AC4: Each card shows the real decision from state, not from model input alone: chunks answer shows the pass count over the ceiling, waive-coverage the files, waive-readiness the item, publish the target PR, verdict and body size, external apply the run id, branch and patch hash, flow confirm the flow id and criteria checksum, schedule the schedule name and action. Tests assert card content. [verify: exec `bun test src/commands/operator-confirm-review-tools.test.ts src/commands/operator-confirm-other-tools.test.ts`]
- AC5: In a real terminal the existing TTY paths of all eight commands behave exactly as before; without a TTY, and under KERYX_TOOL_CALL=1, each refusal names the tool to use instead. Existing command tests stay green and new tests assert the refusal text. · sensitive: revert [verify: exec `bun test src/commands/review-chunks.test.ts src/flow/confirm-token.test.ts src/commands/agents-external-write.test.ts src/commands/learn src/commands/schedule src/commands/review-tty-refusal.test.ts`]
- AC6: The new tools are listed as interactive-only for unattended dispatch (src/trigger/unattended.ts) and the review-orchestrator skill (both copies), flow skill docs and learn/schedule guidance tell the agent to call the tool and never to send the operator to a terminal. [verify: invariant `bun test src/trigger/ src/gdskills/`]
- AC7: A decision record next to TM-03 states what the card proves (a human pressed yes in this TUI session) and what it does not (who; a same-user shell can still forge stores), and whether remote approval answers a card. [verify: judged]
- AC8: The repository stays green: typecheck, lint and the core test suite pass on the PR head. [verify: invariant `bun run typecheck && bun run lint && bun run test:core`]
- AC9: A patch release containing this flow is published to npm and recorded in journal.md. [verify: exec `npm view @mrciphersmith/keryx version`]
- AC10: Owner's live check in keryx shell: at least one real operator decision (e.g. a review pass-ceiling answer or waiver) is asked as a card and answered with yes/no in the TUI, without leaving it; the package records `confirmedVia: "tui-card"`. [verify: judged]
