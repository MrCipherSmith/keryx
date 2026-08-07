# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: The shell system instruction (`src/commands/shell.ts`) separates output-length economy from tool-call budget: brevity guidance no longer applies to how many tools may be called, and a unit test asserts the instruction text contains no single clause governing both.
- AC2: The instruction states when a first-party tool result must be checked against source — specifically when that result is the deliverable rather than an input to it — and the wording is covered by a test that fails if the clause is removed.
- AC3: Brevity is preserved: the instruction still directs lead-with-the-conclusion, shortest-correct-answer output for prose, verified by the same test.
- AC4: A regression fixture reproduces the A3 condition — a first-party graph query returning cycles that include a dynamic-import edge — and asserts the agent's answer qualifies the tool output rather than restating it unchecked.
- AC5: The relationship to P1 is recorded in the flow journal: whether `gdgraph` was fixed to exclude or mark `await import()` edges, and, if it was, that AC4's fixture still forces the unchecked-trust path rather than passing because the underlying data got better.
