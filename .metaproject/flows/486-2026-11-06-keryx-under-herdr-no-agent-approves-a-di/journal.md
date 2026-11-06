# Flow Journal

- 2026-11-06T22:23:44.020Z - flow created
- 2026-11-06T22:25:22.831Z - task-done: T1: Collect remaining context
- 2026-11-06T22:25:23.047Z - task-done: T2: Implement per plan
- 2026-11-06T22:25:23.269Z - task-done: T3: Add/adjust tests and make them pass
- 2026-11-06T22:25:23.486Z - task-added: T5: L1 dialog input guard and terminal approval mark
- 2026-11-06T22:25:23.688Z - task-added: T6: L2 hc dialog-control and agent-launch floors
- 2026-11-06T22:25:23.899Z - task-added: T7: L3 herdr prompt section and template
- 2026-11-06T22:25:24.116Z - task-added: T8: L4 keryx report and external bus origin
- 2026-11-06T22:25:24.313Z - task-added: T9: L5 strip HC_ and HERDR_ from the external child env
- 2026-11-06T22:25:24.509Z - task-added: T10: Live stand: force send, Enter and a real Claude child's report
- 2026-11-06T22:25:24.708Z - frozen: 11 criteria; checksum recorded
- 2026-11-06T22:25:24.710Z - warning: no verification kind on AC1, AC3, AC4, AC8 — add [verify: …] or accept them unclassified
- 2026-11-06T22:25:24.909Z - started
- 2026-11-06T22:25:37.697Z - ac-updated: AC1: "A paste into an open choice's list step never resolves it: the next Enter is swallowed even after the accept delay, the Enter after that approves, Esc still cancels, a paste in the text step goes to the input, and the pasted text reaches the registered sink. [verify: exec `bun test src/tui/composer-choice.test.ts`] · sensitive: revert" -> "A paste into an open choice's list step never resolves it: the next Enter is swallowed even after the accept delay, the Enter after that approves, Esc still cancels, a paste in the text step goes to the input, and the pasted text reaches the registered sink. [verify: exec `bun test src/tui/composer-choice.test.ts` · sensitive: revert]" (the sensitive tag belongs inside the verify marker)
- 2026-11-06T22:25:37.905Z - ac-updated: AC3: "`hc keys`, `hc send --force` in any flag position, and an `HC_TERMINAL_ID=` assignment on an hc command count as human confirmation through path, `env`, `sh -c` and quoting spellings, while `hc send` without the flag, `hc read`, `hc wait` and `hc interrupt` do not. [verify: exec `bun test src/lib/command-risk-operator-floors.test.ts`] · sensitive: revert" -> "`hc keys`, `hc send --force` in any flag position, and an `HC_TERMINAL_ID=` assignment on an hc command count as human confirmation through path, `env`, `sh -c` and quoting spellings, while `hc send` without the flag, `hc read`, `hc wait` and `hc interrupt` do not. [verify: exec `bun test src/lib/command-risk-operator-floors.test.ts` · sensitive: revert]" (the sensitive tag belongs inside the verify marker)
- 2026-11-06T22:25:38.119Z - ac-updated: AC4: "The first `hc run` of a known agent asks in every permission mode, including when a saved rule matches; after approval the same agent passes under the normal mode in that session and a different agent asks again; a denial grants nothing; `hc run cargo test` is unaffected. [verify: exec `bun test src/commands/permission-mode.test.ts src/commands/shell-approval.test.ts src/lib/command-risk-operator-floors.test.ts`] · sensitive: revert" -> "The first `hc run` of a known agent asks in every permission mode, including when a saved rule matches; after approval the same agent passes under the normal mode in that session and a different agent asks again; a denial grants nothing; `hc run cargo test` is unaffected. [verify: exec `bun test src/commands/permission-mode.test.ts src/commands/shell-approval.test.ts src/lib/command-risk-operator-floors.test.ts` · sensitive: revert]" (the sensitive tag belongs inside the verify marker)
- 2026-11-06T22:25:38.344Z - ac-updated: AC8: "The external child env contains no `HC_*` or `HERDR_*` variable. [verify: exec `bun test src/harness/external/env.test.ts`] · sensitive: revert" -> "The external child env contains no `HC_*` or `HERDR_*` variable. [verify: exec `bun test src/harness/external/env.test.ts` · sensitive: revert]" (the sensitive tag belongs inside the verify marker)

- T9 (L5) accepted. The sweep list is shared, so MCP child envs also lose HC_/HERDR_; accepted: an MCP server has no use for the herdr identity. 8 failures in src/security/read-source.test.ts fail at a git commit in a temp repo, which matches the known local git-template hook refusal, not this change.
- 2026-11-06T22:29:15.281Z - task-done: T9: L5 strip HC_ and HERDR_ from the external child env

- T6 (L2) accepted. Concerns: the cause line is generic until callers pass the agent name (follow-up after L1 and L3 finish; the dialog shows the command either way). `export HC_TERMINAL_ID=x; hc send` in a separate segment is not matched: command-line inspection, same stated limit. A line starting two agents asks once and grants both.
- 2026-11-06T22:32:43.421Z - task-done: T6: L2 hc dialog-control and agent-launch floors

- T8 (L4) accepted. A report sender may use a live peer name; origin=external in the tag, the banner and the display mark it, and the name proves nothing by design, so it is not refused. Worker added src/cli.test.ts (pinned help) and src/bus/log.ts, client.ts, display.ts beyond the brief; all needed.
- 2026-11-06T22:34:27.355Z - task-done: T8: L4 keryx report and external bus origin
- 2026-11-06T22:38:34.796Z - task-done: T7: L3 herdr prompt section and template
- 2026-11-06T22:38:47.288Z - task-done: T5: L1 dialog input guard and terminal approval mark
- 2026-11-06T22:43:39.596Z - task-added: T11: Fix the three defects the live stand found: grant lifetime, remember options, transcript mark

- Live stand, first pass: force send no longer approves, the report queues, the next Enter approves, the approval line is marked. Found three defects: the launch grant dies with the per-turn io facade, the launch dialog offers remember options that cannot work, and a pasted line shows with the user mark in the transcript. A Claude child with a false-looking task refused to run keryx report, so the report path needs a task it can truthfully do.
- 2026-11-06T22:49:42.235Z - task-done: T11: Fix the three defects the live stand found: grant lifetime, remember options, transcript mark

- Live stand, second pass (dev build, gpt-6.1-sol parent, real claude children): launch dialog names claude and offers only allow once or deny, in trust mode. Approved; the child ran git log and sent keryx report; parent showed "@kid487a (external, unverified) notice: commits: 0" and answered "not independently verified". A second launch of claude in a later turn was auto-approved under trust with no ask. Not exercised live: hc keys and --force floors from an agent (unit tests only); Codex and OpenCode parents, which are not keryx code.
- 2026-11-06T22:52:39.644Z - task-done: T10: Live stand: force send, Enter and a real Claude child's report
