# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.


## Criteria

- AC1: In mode `trust` the main agent's tool-round limit is 200 (was 40); modes `ask` and `auto` keep their current limit. A test proves round 41 runs in trust and is refused in ask, and the limit is a named setting, not a literal.
- AC2: In mode `trust`, no approval prompt is shown for a command in the trust allowlist; a test runs a trust session with shell_exec of a routine review command and observes zero prompts. Commands trust does not allow still prompt.
- AC3: A turn does not end while the plan has open items and the agent has not reported a blocker: the shell continues on its own, up to a stated bound, and a test shows a four-item plan finishing without an operator message.
- AC4: An operator answer to an orchestrator question (counterpart, model plan, budget, scope choice) is stored in the session slate and not asked again after compaction or a new turn; a test asks twice and sees one prompt.
- AC5: A slash command sent while main is busy is queued and runs when the turn ends, instead of being dropped; the user sees that it is queued.
- AC6: Ctrl+C during a turn cancels the turn and returns to the prompt; the shell closes only on a second Ctrl+C at an idle prompt or on `/exit`.
- AC7: Reviewer dispatch in the shell validates the reviewer-input payload against its schema before sending; a dispatch without a slice assignment is refused with a named error, not sent.
- AC8: Scope A larger than the reviewer budget is cut by domain into slices, each at most the stated size, with a manifest; files classified as data ledgers (csv, lockfile, snapshot) are omitted from review and listed in the omissions.
- AC9: A reviewer that returns INCOMPLETE or BLOCKED is retried once with a smaller slice; if it is still incomplete the report names it as not run, and it never counts as a clean pass.
- AC10: A wave dispatches up to 10 reviewers (the ceiling), not 3, when the plan has them.
- AC11: A file the read tool cannot open because it is outside the working directory fails with an error that names the cause and the alternative; machine artifacts are never saved through `keryx ctx run` wrapping.
- AC12: Live: the review of Presight-AI/vantage-frontend PR 7435, started in a keryx shell in trust mode with no input after the task, reaches `review complete` and a report with findings, and the time, tokens and findings are recorded beside the Claude run (17m58s, 2x10 reviewers, 5 Majors).
- AC13: The CHANGELOG and the shell docs state the trust-mode limit, the queueing of slash commands and the Ctrl+C behavior; the docs site builds with --strict.
