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

Scope (operator, poll 227, 2026-10-19): the four standalone review verbs `decide-premise`, `confirm-plan`, `waive-mutation` and `override-reviewers` accept a recorded host question. `review complete` accepts none, and so do its `--waive` and `--waive-coverage` flags, which exist only on `complete`. A free-text answer is never a decision.

## Criteria

- AC1: `keryx review decide-premise --package <dir> --finding <id> --reason "<why>" --answer uphold|dismiss --answered-by <source>:<ref> --answer-text "<operator's words>" --question-text "<question as asked>"` records the decision with no TTY: `operator-decisions.json` and the finding change exactly as on the terminal path, and the record carries `confirmedVia: "host-question"`, the source, the ref, the verbatim question and answer text, and the time. [verify: exec `bun test src/commands/review-host-question.test.ts -t AC1`]
- AC2: The same flags work with no TTY on `confirm-plan`, `waive-mutation` and `override-reviewers`, each with the same effect and record fields as its terminal path. [verify: exec `bun test src/commands/review-host-question.test.ts -t AC2`]
- AC3: Each refusal records nothing and exits non-zero with a message: an `--answer` that is not one of the verb's options (decide-premise: uphold or dismiss), an empty or blank `--answer-text` or `--question-text`, a missing or malformed `--answered-by` (source not one of claude-code, codex, keryx-shell, helyx-poll, other; empty ref), an unknown package, an unknown or not-held finding, a stale plan, a missing `--reason`, and an `--answer-text` that is a decline (empty, `n`, `no`) or, for decide-premise, does not name the same choice as `--answer`. [verify: exec `bun test src/commands/review-host-question.test.ts -t AC3`]
- AC4: With no TTY and no `--answered-by` the four verbs refuse exactly as before (same message), and with a TTY and no `--answered-by` they behave as before; the existing review-operator tests pass without edits. [verify: exec `bun test src/commands/review-operator-cli.test.ts src/commands/operator-confirm-review-tools.test.ts src/review/harness-robustness.test.ts`]
- AC5: Failure scenario: `--answered-by` is refused, with nothing recorded, in an unattended run and in a nested keryx (`KERYX_TOOL_CALL=1`), on every one of the four verbs. [verify: exec `bun test src/commands/review-host-question.test.ts -t AC5` · sensitive: failure-scenario]
- AC6: Each accepted host question also writes a `keryx decisions` entry (question text, the options, the choice, the source and ref), readable with `keryx decisions report --json`; a refused one writes none. [verify: exec `bun test src/commands/review-host-question.test.ts -t AC6`]
- AC7: `keryx review complete` refuses `--answered-by`, `--answer-text` and `--question-text` (its flag check names them as unknown), and its terminal and card paths are unchanged. [verify: exec `bun test src/commands/review-host-question.test.ts -t AC7`]
- AC8: The record is visible as a host question, distinct from a card: `confirmedVia` and the source show in the review report and in the `/decisions` modal of keryx shell. [verify: exec `bun test src/commands/review-host-question.test.ts -t AC8`]
- AC9: The skills `review-orchestrator`, `job-orchestrator` and `review-premise` (every bundled copy, within the line ceilings and byte-identity checks) tell the agent to ask the operator with the host's question tool, then record the answer with the verb, and no longer send the operator to a terminal for these four acts; `complete` still goes to the operator. [verify: exec `bun test src/gdskills`]
- AC10: TM-04 has a section for the host-question path: what it proves (the operator answered a question the agent reports), what it does not (keryx cannot verify the agent reported it truthfully), and the reversal of §5 on the operator's instruction (polls 225 and 227). `docs/docs/limitations.md`, the CLI reference, README, `keryx review <verb> --help` and the docs site match, and the docs coverage tests stay green. [verify: exec `bun test src/docs src/cli-docs-structure.test.ts src/cli-reference-coverage.test.ts`]
- AC11: The PR 1052 decisions are recorded through the new verb into the packages' `operator-decisions.json` with the poll references: C-05 uphold, C-10 uphold, C-25 dismiss (poll 223) and E-42 uphold (poll 227). Only what the operator answered is recorded. [verify: judged]
- AC12: (operator-only) The operator asks for a held finding in a live review, answers a question in Telegram, and sees the decision recorded with `confirmedVia: "host-question"`. The agent does not confirm this criterion. [verify: judged]