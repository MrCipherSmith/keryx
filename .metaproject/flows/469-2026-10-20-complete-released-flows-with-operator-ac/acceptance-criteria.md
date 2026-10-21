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

- AC1: Completion accepts only currently failing, explicitly named gates with a nonempty reason; review exceptions name individual conditions, never the whole review gate. Acceptance criteria, tasks, owner, folder-committed and confirmation cannot be waived. [verify: judged]
- AC2: Accepted completion persists cleanCompletion=false and exceptions with gate, condition where applicable, current refusal detail, reason, verbatim operatorWords, confirmedVia and timestamp; completing a completed flow refuses. [verify: judged]
- AC3: Exceptions require an operator decision through a keryx shell card, an interactive TTY, or the existing host-question protocol. Host questions include each selected gate and its current refusal text, require an affirmative answer, and refuse unattended or KERYX_TOOL_CALL=1 contexts. [verify: judged]
- AC4: flow base set records a reasoned base change in the journal without resetting implementation; subsequent fix PRs and their review rounds can be recorded and head-commit checks use the latest recorded PR. [verify: judged]
- AC5: Status, list, journal and product index distinguish completed with exceptions and show reasons; help and check-complete identify acceptable failures and the required invocation. [verify: judged]
- AC6: review complete supports host-question confirmation binding the reviewed head, evidence level, dispositions and waivers, reusing existing confirmation security checks. [verify: judged]
- AC7: Regression tests cover all four reported released-flow scenarios, protected and passing gates, incomplete or stale host questions, forbidden execution contexts, visible exception records and repeated completion; relevant tests, typecheck and lint pass. [verify: judged]
- AC8: flow-orchestrator documents when to complete with exceptions versus block, allowable gates and operator-question recording; CHANGELOG references issue #1062. [verify: judged]
