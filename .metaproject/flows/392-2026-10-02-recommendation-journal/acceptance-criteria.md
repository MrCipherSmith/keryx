# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: Every agent question with options writes one journal record with: flow, stage, question, options, the agent's recommendation and its reason, display mode, option order, the human's choice and time to answer, and an optional deviation reason. [verify: exec `bun test src/decisions`]
- AC2: The recommendation is recorded before the question is shown, so a blind question cannot have its recommendation written afterwards. [verify: exec `bun test src/decisions`]
- AC3: Blind mode is chosen at random with probability 1/3 per question; a blind question has no "recommended" mark and a random option order, and the recommendation is revealed right after the answer. [verify: exec `bun test src/decisions`]
- AC4: Blind mode never applies to an action in the irreversible list in config (release, delete, push to something others own). [verify: exec `bun test src/decisions`]
- AC5: When the human changes the answer after the reveal, both entries are written and the record says the answer was changed. [verify: exec `bun test src/decisions`]
- AC6: After a deviation from the recommendation the human is asked once for a reason and the tool result waits for the answer; the field is optional, an empty answer is recorded as absent and releases the wait. [verify: exec `bun test src/decisions`]
- AC7: `keryx decisions report` is deterministic, uses no model, and prints the match share by mode and stage plus the list of deviations with their reasons. [verify: exec `bun test src/decisions`]
- AC8: The TUI has a side-panel entry, a modal with the report, and a shell command for the decision journal. [verify: exec `bun test src/tui`]
- AC9: Journaling itself never blocks or delays a question and a journaling failure never throws into the question path; the single deliberate wait is the optional reason prompt after a deviation (AC6), by operator decision. A question outside a flow goes to the project-wide journal; a decision inside a flow also appears as a line in the flow's journal.md. [verify: exec `bun test src/decisions`]
- AC10: `originSet` no longer carries the previous quote or source over when the kind changes, and `/flow origin` without an id prints a bounded summary instead of every flow. [verify: exec `bun test src/flow`]
- AC11: After two weeks of use the report shows at least 20 decisions, at least 5 of them blind, and the operator judges that it lets them see whether they accept recommendations automatically. [verify: judged]
