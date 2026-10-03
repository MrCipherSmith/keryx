# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

Draft for the operator's review: not frozen, nothing confirmed. `Qn` refers to
the open questions in `docs/requirements/keryx-topic-history/prd.md`.

## Criteria

- AC1: A probe sends the same wide 3-column table to a scratch topic in three forms (A: the current `table` block, B: rich `markdown` after helyx's separator rewrite, C: HTML `<pre>` aligned table) and records, for each, whether it is wide, whether it scrolls sideways, and its rendered height; the result and the chosen variant (Q9) go to `docs/requirements/keryx-topic-history/probe.md` with the screenshots named, and nothing in AC2 to AC5 is built before it exists. The live send needs the operator's OK (Q11). [verify: judged]
- AC2: The chosen table variant is built by a pure function whose output for a fixed corpus of tables (2 to 20 columns, empty cells, cells with `|`, Cyrillic, emoji, a 300-character cell) is pinned by a test; a table with more than 20 columns degrades to the HTML or plain form instead of failing. Short and 2-column tables follow Q10. [verify: exec]
- AC3: Every invariant flow 395 already holds for rich replies still holds for the new table path: escaping, block balance, model text never reaches a parser it was not meant for (a cell containing Markdown or block syntax stays a cell), and the property corpus passes unchanged. [verify: exec]
- AC4: The HTML fallback and the plain-text fallback of a table are byte-for-byte what they are before this flow (golden files compared); a send refused by Telegram still falls back in the same order. [verify: exec]
- AC5: A reply with a table too large for one message is split at row boundaries, never inside a row, and each part repeats the header row; the parts are sent in order and none exceeds 4096 characters (ordinary) or the rich-message limits (32768 characters, 500 blocks). [verify: exec]
- AC6: When `Hub.register` answers `reused: false` for a session that has at least one message (Q5), the bridge posts the last 10 messages of that session to the new topic without a command, once; when it answers `reused: true` it posts nothing. [verify: exec]
- AC7: A message in the restored history is an operator turn (`isOperatorMessage`) or, per Q2, an assistant turn with text and no tool calls; tool calls, tool output, injected or provenance-marked content, and reasoning are never posted. [verify: exec]
- AC8: Every restored message goes through the same redaction and length cap as a live reply (`composeReply`); a session fixture holding a token-shaped string and a 40,000-character turn yields a topic payload with the token redacted and the turn capped. [verify: exec]
- AC9: Restored messages arrive oldest first, each carrying a role label (the operator's and the agent's differ by text, not only by colour) and, per Q7, a time; a fixture with 25 turns posts exactly turns 16 to 25, in that order. [verify: exec]
- AC10: Restore respects Telegram pacing: the posts go through the outbound queue in order, a 429 pauses the queue and the history resumes where it stopped, no message is posted twice after the pause, and the digest or per-item form (Q3) never produces a message over 4096 characters. [verify: exec]
- AC11: With an empty session, or one with no qualifying messages, nothing is posted automatically and `/history` answers with one short line that the history is empty, not with silence and not with an error. [verify: exec]
- AC12: A reconnect, a heartbeat, a bridge restart in the same topic, or an at-least-once outbound retry does not repost the history; a second `/history` repeats it on purpose. The restore is remembered by a marker kept in session state, and a test restarts the bridge three times and counts one automatic restore. [verify: exec]
- AC13: `/history [N]` works from the shell and from the topic: no argument means 10, both roles, oldest first; N is accepted from 1 to the cap of Q6 (proposed 50) and anything else, including a non-numeric argument, gets a one-line usage message and posts nothing. [verify: exec]
- AC14: The command is visible in the shell: it is in the shell command registry (`AGENT_SLASH_COMMANDS`), in `/help` and `src/standard/help-groups.ts` (the cross-check test passes), and in `REMOTE_COMMANDS` and the bot menu, and a test fails if any of the three lacks it. [verify: exec]
- AC15: The `/remote-control` panel has a key that posts the history, the sidebar remote line and the status show when the history was last posted and how many messages, a transcript notice appears on every automatic and manual restore, and a TUI test renders each of them. [verify: exec]
- AC16: README, `docs/docs/guides/drive-keryx-remotely.md`, the CLI and command reference, and `CHANGELOG.md` describe `/history`, the automatic restore and the table layout, with a version bump, and `mkdocs build --strict` passes. [verify: exec]
- AC17: Live acceptance by the operator (needs the operator's OK for a live Telegram session): quit the shell, run `keryx shell --continue`, run `/remote-control <name>`, and see the 10 messages arrive in the new topic in order and labelled; run `/history 3` in the topic and in the shell and see three; ask the agent for a wide table and confirm it reads like helyx's, with horizontal scroll when it does not fit. [verify: judged]
