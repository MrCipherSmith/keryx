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

- AC1: A paste into an open choice's list step never resolves it: the next Enter is swallowed even after the accept delay, the Enter after that approves, Esc still cancels, a paste in the text step goes to the input, and the pasted text reaches the registered sink. [verify: exec `bun test src/tui/composer-choice.test.ts` · sensitive: revert]
- AC2: Text that a paste sends through the sink reaches the model framed as not the user's words and is not lost. [verify: exec `bun test src/tui/hc-message.test.ts src/tui/composer-choice.test.ts`]
- AC3: `hc keys`, `hc send --force` in any flag position, and an `HC_TERMINAL_ID=` assignment on an hc command count as human confirmation through path, `env`, `sh -c` and quoting spellings, while `hc send` without the flag, `hc read`, `hc wait` and `hc interrupt` do not. [verify: exec `bun test src/lib/command-risk-operator-floors.test.ts` · sensitive: revert]
- AC4: The first `hc run` of a known agent asks in every permission mode, including when a saved rule matches; after approval the same agent passes under the normal mode in that session and a different agent asks again; a denial grants nothing; `hc run cargo test` is unaffected. [verify: exec `bun test src/commands/permission-mode.test.ts src/commands/shell-approval.test.ts src/lib/command-risk-operator-floors.test.ts` · sensitive: revert]
- AC5: The herdr section states the choice rule, the report channel, the ban on answering another terminal's dialog, cleanup and the reporting of a broken path; names the resolved keryx path and the bus name when given; stays within its ceiling; and is absent outside an hc terminal. [verify: exec `bun test src/tui/hc-message.test.ts src/commands/herdr.test.ts`]
- AC6: `keryx report --to @name "text"` writes an event with origin `external` that the addressed shell receives under a banner saying it is an external agent's unverified message. [verify: exec `bun test src/commands/report.test.ts src/bus/peer-notification.test.ts src/bus/schema.test.ts`]
- AC7: `keryx report` fails with a named non-zero error and writes nothing when the bus is disabled, the name is unknown, the body is over the bound (the error names the file route), the rate limit is reached, or it runs inside a keryx tool call; an external-origin event cannot be a pause, resume or override. [verify: exec `bun test src/commands/report.test.ts`]
- AC8: The external child env contains no `HC_*` or `HERDR_*` variable. [verify: exec `bun test src/harness/external/env.test.ts` · sensitive: revert]
- AC9: A keyboard shell approval under `HC_TERMINAL_ID` is marked in the transcript as unverified by author; outside hc, and for a Telegram answer, the line is unchanged. [verify: exec `bun test src/tui/composer-choice.test.ts src/tui/hc-message.test.ts`]
- AC10: Live stand: a dev keryx in ask mode under `hc`; `hc send --force` with a report does not approve, the report appears as an agent message, and Enter from a person then approves; a real Claude child's `keryx report` reaches the parent marked external. [verify: judged]
- AC11: The typecheck passes. [verify: exec `bun run typecheck`]
