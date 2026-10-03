# PRD: Telegram topic history restore and wide tables

Flow: 399 (`.metaproject/flows/399-2026-10-03-topic-history-and-wide-tables/`)
Status: draft for the operator's review. Not frozen, no acceptance criterion confirmed, nothing implemented.
Origin: human-request, channel message 179104 (2026-10-02T20:11:19Z); second message 179814 (2026-10-03T06:26:31Z).

## 1. Request (verbatim)

179104:

> 1. Как только я вышел из keryx shell топик убился, когда я запустил с продолжением keryx shell подхватил сессию, но топик создался новый и пустой. Это правильно, но нудна команда восстановить историю, и по ней присылать в топик 10 последних сообщений(и мои и агента)
> 2 смотри скриншоты. 1 это что пришло, 2 это как в keryx shell

Screenshots: (1) what arrived in Telegram: a native three-column table "Номер / Дата / Что вошло" in a narrow bubble, the long column wrapping 8 to 10 lines per row; (2) the same table, compact, in keryx shell.

179814:

> Про таблицы в телеграм, в helyx они широкие и если не вылазят, есть горизонтальный скрол

## 2. Problem

1. Exit from the shell deletes the Telegram topic. `keryx shell --continue` restores the session, but remote control does not start by itself (flow 376, AC4); `/remote-control <name>` then creates a new topic that is empty, while the session holds the whole conversation.
2. A table reaches Telegram as a native table block in a narrow bubble and wraps tall; in helyx the same kind of table is wide and scrolls sideways.

## 3. Goals

- G1. A new topic created for a session that already has a conversation receives the last 10 messages (operator and agent) on its own.
- G2. `/history [N]` posts the last N messages on demand (default 10), from the shell and from the topic.
- G3. Both are visible in the shell: command registry, help, remote-control panel, sidebar and status.
- G4. A table in a reply reads in Telegram as wide, with horizontal scroll when it does not fit, as in helyx, without weakening what flow 395 guarantees.

## 4. Behaviour

### 4.1 Trigger

`Hub.register` answers `reused: false` when it created a topic and `reused: true` when a live or kept topic held the name. The bridge learns it from `RemoteClient.start()` in `RemoteBridge.enable()` (`src/remote/shell-bridge.ts`). Restore fires automatically only when a RESUMED session (opened with `-r` or `-c`, or switched to with `/resume`) gets a new topic (`reused: false`) and holds qualifying messages, once. Everything else (a fresh session, a reused topic, an in-topic `/new`) is served by `/history N` (operator decision, poll 53). It never fires on `reused: true`, on a reconnect, on a heartbeat, or on an outbound retry (AC12).

### 4.2 What counts as a message

Included: the operator's turns (`isOperatorMessage`) and the final text of each agent turn. Excluded, always: tool calls, tool output, injected or provenance-marked content (memory, hooks, slate), reasoning, and the agent's intermediate narration between tool calls (poll 53). Every message passes `composeReply`, the same redaction as a live reply, and is cut at the per-item cap (AC8, D2).

### 4.3 Order and labels

Oldest first. Each item is its own message with a role label in text ("You" or "Agent", English as the rest of the product text); no timestamps (D1). The default N is 10 and counts both roles together, not 10 of each.

### 4.4 Telegram limits

An ordinary message is capped at 4096 characters; a group tolerates about 1 message per second and 20 per minute; a 429 pauses the outbound queue, which is at-least-once. The restore is 10 separate messages with role labels, paced by the outbound queue, with no digest (poll 53). A 429 pauses the queue and the history continues where it stopped, in order, without duplicates (AC10). Each item is cut so it fits one message.

### 4.5 Empty history

Nothing is posted automatically. `/history` replies with one line saying the history is empty (AC11).

### 4.6 `/history [N]`

No argument: 10. N from 1 to 20 (D2); anything else, including a non-number, gets a one-line usage message and posts nothing. Repeatable on purpose. No collision exists: `/history` is not in `AGENT_SLASH_COMMANDS`, `HELP_GROUPS`, or `REMOTE_COMMANDS`; `/rewind` takes a `history` argument only (AC13).

### 4.7 TUI visibility (a rule, not a nicety)

- `/history` is in the shell command registry (`src/commands/agent-commands.ts`), in `/help` and `src/standard/help-groups.ts` (a test cross-checks them), and in `REMOTE_COMMANDS` and the bot menu (`src/remote/command-gateway.ts`).
- The `/remote-control` panel (`src/tui/remote-control-surface.ts`) gets a key that posts the history; the sidebar remote line and the status show when it was last posted and how many messages; a transcript notice and an event record each restore (AC14, AC15).

### 4.8 Tables

keryx sends a `table` block (`src/remote/format-rich.ts`, `is_bordered: true`) on purpose: spike S3 (`docs/requirements/keryx-telegram-rendering/spike.md`) requires that model text never reach a parser. helyx sends `rich_message: { markdown }` (`helyx/mcp/tools.ts`) after rewriting bare separator rows so each carries a colon (`helyx/channel/telegram.ts`), because Telegram recognises a Markdown table only then. Which of these Telegram lays out wide and scrollable is not known from the code; the first step is a probe (AC1) of three variants:

- A. the current `table` block (what the operator sees now, narrow and tall);
- B. rich `markdown` as helyx sends it (likely the helyx look; carries the injection risk S3 is about);
- C. an aligned HTML `<pre>` table (Telegram scrolls `<pre>` blocks sideways; safe; loses cell styling).

The chosen variant becomes a pure, pinned builder (AC2), keeps the 395 invariants (AC3), leaves the HTML and plain fallbacks byte-for-byte as they are (AC4), and splits at row boundaries with the header repeated (AC5). The earlier decision of poll 51 (keep the native table, shorten cells with an ellipsis) is superseded by 179814 and remains only as the default D3.

## 5. Acceptance criteria

The numbered list is `.metaproject/flows/399-2026-10-03-topic-history-and-wide-tables/acceptance-criteria.md` (AC1 to AC19). One flow, two PRs (poll 53): PR 1 history (AC6 to AC17, AC19), PR 2 tables (AC2 to AC5, AC18); AC1 is the live probe, done before PR 2. Titles: AC1 table probe; AC2 table builder pinned; AC3 395 invariants hold; AC4 fallbacks unchanged; AC5 split with header repeated; AC6 restore on new topic only; AC7 what counts as a message; AC8 redaction and cap; AC9 order and labels; AC10 pacing and limits; AC11 empty history; AC12 idempotency; AC13 `/history [N]`; AC14 command registries; AC15 panel, sidebar, status, notice; AC16 history docs and CHANGELOG; AC17 live acceptance of the history; AC18 table docs and live acceptance of the table; AC19 PR 1 leaves the table code alone.

## 6. Docs

README, `docs/docs/guides/drive-keryx-remotely.md`, the CLI and command reference, and `CHANGELOG.md`, updated with the code, with a version bump: history in PR 1 (AC16), tables in PR 2 (AC18).

## 7. Live acceptance

AC1 (the probe) is allowed by the operator (poll 53): the three test tables go to the operator's keryx-shell topic, nothing else, no secrets, and the message ids are recorded in the flow's `spike.md`. AC17 (quit, `--continue`, `/remote-control <name>`, ten messages, `/history 3` in both places) and the table half of AC18 still wait for the operator.

## 8. Out of Scope

- Restoring history into a topic that already exists.
- Transports other than Telegram.
- Restoring the Telegram side of the conversation (the topic is deleted on exit and its messages are gone).
- Searching or filtering history.
- Changing when the topic is deleted on exit.
- A history of tool calls or tool output.
- Changing how the HTML and plain-text fallbacks lay out a table.

## 9. Decisions

Answered by the operator (poll 53, 2026-10-03T06:46Z):

- One flow, two PRs: history first (PR 1), tables second (PR 2).
- The restored messages are the operator's messages and the agent's final text per turn: no tool calls, no reasoning, no intermediate narration.
- Ten separate messages with role labels and pacing; no digest.
- Automatic restore only when a resumed session gets a new topic; everything else goes through `/history N`.
- The live probe of three table variants into the operator's keryx-shell topic is allowed (only the three test tables, no secrets, message ids recorded in the spike notes).

## 10. Defaults taken unless the operator objects

These were not answered. Each carries the safest reasonable default; they are visible here on purpose and can be changed before PR 2 or by `keryx flow ac update`.

- D1. Timestamps: none. Role label only. (Time can be added later without breaking anything; it adds length to every message.)
- D2. Limits: `/history N` accepts 1 to 20; each restored item is cut at 1,500 characters with an «…» marker. (Ten separate paced posts per restore; 20 at most keeps a manual request under about a minute at the group rate.)
- D3. The superseded «…» cell shortening (poll 51 b) is not kept as a fallback for tables. Revisit only if the probe shows no variant holds a very wide table.
- D4. Markdown-injection risk of the chosen table variant: if the winning variant carries model text through a parser (variant B), every cell is escaped and AC3 must pass on the property corpus; if that cannot be guaranteed, variant C (HTML `<pre>`) wins instead. Safety beats looks.
- D5. Short and 2-column tables: one layout for every table, no special case, unless the probe shows the narrow layout is fine for them and `spike.md` says why.
- D6. Flow 395's unconfirmed live AC11: this flow does not wait for it. PR 1 does not touch table code (AC19); PR 2 rebases onto whatever 395 has merged.
- D7. The empty topic came from `/remote-control <name>` after `--continue`, as the code reads (resume never re-enables remote control, flow 376 AC4; exit retires the topic). Taken as confirmed; the history restore hangs on topic creation, not on the resume itself.
- D8. Any session versus resumed-only: resumed-only for the automatic restore (settled by the answer on when to restore); `/history N` works for any session.
