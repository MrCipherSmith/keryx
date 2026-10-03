# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

One flow, two PRs (operator, poll 53). PR 1 carries the history restore: AC6 to AC17 and AC19. PR 2 carries the tables: AC2 to AC5 and AC18. AC1 is the live probe, done before PR 2. `Dn` refers to the defaults list in the PRD (`docs/requirements/keryx-topic-history/prd.md`).

## Criteria

- AC1: A probe sends the same wide 3-column table to the operator's keryx-shell topic in three forms (A: the current `table` block, B: rich `markdown` after helyx's separator rewrite, C: HTML `<pre>` aligned table) and records, for each, whether it is wide, whether it scrolls sideways, and its rendered height; only the three test tables are sent, with no secrets, and the message ids are recorded in the flow's spike notes (`.metaproject/flows/399-2026-10-03-topic-history-and-wide-tables/spike.md`) together with the chosen variant and why. [verify: judged]
- AC2: The chosen table variant is built by a pure function whose output for a fixed corpus of tables (2 to 20 columns, empty cells, cells with `|`, Cyrillic, emoji, a 300-character cell) is pinned by a test; a table with more than 20 columns degrades to the HTML or plain form instead of failing. Short and 2-column tables follow D5. [verify: exec]
- AC3: Every invariant flow 395 already holds for rich replies still holds for the new table path: escaping, block balance, model text never reaches a parser it was not meant for (a cell containing Markdown or block syntax stays a cell), and the property corpus passes unchanged. [verify: exec]
- AC4: The HTML fallback and the plain-text fallback of a table are byte-for-byte what they are before this flow (golden files compared); a send refused by Telegram still falls back in the same order. [verify: exec]
- AC5: A reply with a table too large for one message is split at row boundaries, never inside a row, and each part repeats the header row; the parts are sent in order and none exceeds 4096 characters (ordinary) or the rich-message limits (32768 characters, 500 blocks). [verify: exec]
- AC6: When a session that was resumed (opened with `-r` or `-c`, or switched to with `/resume`) gets a NEW topic (`Hub.register` answers `reused: false`) and holds at least one qualifying message, the bridge posts the last 10 messages to the topic without a command, once. Nothing is posted automatically for a session that was not resumed, nor when `reused: true`; those cases are served by `/history N`. [verify: exec]
- AC7: A restored message is an operator turn (`isOperatorMessage`) or the final assistant text of a turn; tool calls, tool output, reasoning, injected or provenance-marked content, and intermediate narration between tool calls are never posted. [verify: exec]
- AC8: Every restored message goes through the same redaction as a live reply (`composeReply`) and is cut at the per-item cap (D2) with an «…» marker; a session fixture holding a token-shaped string and a 40,000-character turn yields a topic payload with the token redacted and the turn cut. [verify: exec]
- AC9: Restored messages arrive oldest first, each as its own message carrying a role label (the operator's and the agent's differ by text, not only by colour); a fixture with 25 turns posts exactly turns 16 to 25, in that order, and no timestamps are shown (D1). [verify: exec]
- AC10: The restored messages are separate posts (10 by default, no digest) sent through the outbound queue with pacing: the queue spaces them, a 429 pauses it and the history resumes where it stopped, and no message is posted twice after the pause. [verify: exec]
- AC11: With an empty session, or one with no qualifying messages, nothing is posted automatically and `/history` answers with one short line that the history is empty, not with silence and not with an error. [verify: exec]
- AC12: A reconnect, a heartbeat, a bridge restart in the same topic, or an at-least-once outbound retry does not repost the history; a second `/history` repeats it on purpose. The automatic restore is remembered by a marker kept per topic in session state, and a test restarts the bridge three times and counts one automatic restore. [verify: exec]
- AC13: `/history [N]` works from the shell and from the topic: no argument means 10, both roles, oldest first; N is accepted from 1 to 20 (D2) and anything else, including a non-numeric argument, gets a one-line usage message and posts nothing. From the shell it needs remote control on; with it off the shell answers with one line saying so. [verify: exec]
- AC14: The command is visible in the shell: it is in the shell command registry (`AGENT_SLASH_COMMANDS`), in `/help` and `src/standard/help-groups.ts` (the cross-check test passes), and in `REMOTE_COMMANDS` and the bot menu, and a test fails if any of the three lacks it. [verify: exec]
- AC15: The `/remote-control` panel has a key that posts the history, the sidebar remote line and the status show when the history was last posted and how many messages, a transcript notice appears on every automatic and manual restore, and a TUI test renders each of them. [verify: exec]
- AC16: README, `docs/docs/guides/drive-keryx-remotely.md`, the CLI and command reference, and `CHANGELOG.md` describe `/history` and the automatic restore, with a version bump, and `mkdocs build --strict` passes. [verify: exec]
- AC17: Live acceptance of the history by the operator (needs the operator's OK for a live Telegram session): quit the shell, run `keryx shell --continue`, run `/remote-control <name>`, and see the last 10 messages arrive in the new topic as separate, labelled posts in order; run `/history 3` in the topic and in the shell and see three. [verify: judged]
- AC18: README, `docs/docs/guides/drive-keryx-remotely.md` and `CHANGELOG.md` describe the new table layout, with a version bump, and `mkdocs build --strict` passes; live acceptance by the operator: ask the agent for a wide table and confirm it reads like helyx's, with horizontal scroll when it does not fit. [verify: judged]
- AC19: PR 1 does not touch the table code (`src/remote/format-rich.ts`, `src/remote/format-table.ts`), so the two PRs merge in any order. [verify: invariant]
