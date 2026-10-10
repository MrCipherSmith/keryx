# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: With an open review-flow package that `review complete` still refuses on and a review run seen in the session, a text-only finish is not accepted: the harness injects the refusal reasons and continues (unit test on the gate decision).
- AC2: The gate stops, with a state report, after 20 continues or after 3 consecutive continues that add no artifact; with no review run in the session, or a package closed since the session began, the stop is accepted; before review start has opened a package the gate still holds (unit tests).
- AC3: A blocked plan item does not bypass the gate, and `plan_get`, `slate_trail` and `recall_step` are exempt from the repeated-call guard (unit test on REPEATABLE_TOOL_NAMES).
- AC4: The review-orchestrator SKILL.md states that Step 1 is a prose step with no CLI command, stays at 1614 lines, and both copies are identical.
- AC5: Each gate continue prints a `[review-gate]` line in the pane; README/docs guide and CHANGELOG describe it; the release is 0.3.94.
