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

`Hub.register` answers `reused: false` when it created a topic and `reused: true` when a live or kept topic held the name. The bridge learns it from `RemoteClient.start()` in `RemoteBridge.enable()` (`src/remote/shell-bridge.ts`). Restore fires on `reused: false` for a session with qualifying messages (Q5), once. It never fires on `reused: true`, on a reconnect, on a heartbeat, or on an outbound retry (AC12).

### 4.2 What counts as a message

Included: the operator's turns (`isOperatorMessage`) and the agent's reply text. Excluded, always: tool calls, tool output, injected or provenance-marked content (memory, hooks, slate), reasoning. Whether the agent's intermediate narration between tool calls counts is Q2. Every message passes `composeReply`, the same redaction and cap as a live reply (AC8).

### 4.3 Order and labels

Oldest first. Each item carries a role label in text ("Вы" or "Агент", wording to be fixed with the operator) and, if Q7 says so, a time. The default N is 10 and counts both roles together, not 10 of each.

### 4.4 Telegram limits

An ordinary message is capped at 4096 characters; a group tolerates about 1 message per second and 20 per minute; a 429 pauses the outbound queue, which is at-least-once. One message per item (10 messages) fits the limits but is a burst into a fresh topic; a single digest message is cheaper but must be split when it is over 4096 characters. This is Q3. Either way no message exceeds the cap and the order survives a pause (AC10).

### 4.5 Empty history

Nothing is posted automatically. `/history` replies with one line saying the history is empty (AC11).

### 4.6 `/history [N]`

No argument: 10. N from 1 to the cap (Q6, proposed 50); anything else, including a non-number, gets a one-line usage message and posts nothing. Repeatable on purpose. No collision exists: `/history` is not in `AGENT_SLASH_COMMANDS`, `HELP_GROUPS`, or `REMOTE_COMMANDS`; `/rewind` takes a `history` argument only (AC13).

### 4.7 TUI visibility (a rule, not a nicety)

- `/history` is in the shell command registry (`src/commands/agent-commands.ts`), in `/help` and `src/standard/help-groups.ts` (a test cross-checks them), and in `REMOTE_COMMANDS` and the bot menu (`src/remote/command-gateway.ts`).
- The `/remote-control` panel (`src/tui/remote-control-surface.ts`) gets a key that posts the history; the sidebar remote line and the status show when it was last posted and how many messages; a transcript notice and an event record each restore (AC14, AC15).

### 4.8 Tables

keryx sends a `table` block (`src/remote/format-rich.ts`, `is_bordered: true`) on purpose: spike S3 (`docs/requirements/keryx-telegram-rendering/spike.md`) requires that model text never reach a parser. helyx sends `rich_message: { markdown }` (`helyx/mcp/tools.ts`) after rewriting bare separator rows so each carries a colon (`helyx/channel/telegram.ts`), because Telegram recognises a Markdown table only then. Which of these Telegram lays out wide and scrollable is not known from the code; the first step is a probe (AC1) of three variants:

- A. the current `table` block (what the operator sees now, narrow and tall);
- B. rich `markdown` as helyx sends it (likely the helyx look; carries the injection risk S3 is about);
- C. an aligned HTML `<pre>` table (Telegram scrolls `<pre>` blocks sideways; safe; loses cell styling).

The chosen variant becomes a pure, pinned builder (AC2), keeps the 395 invariants (AC3), leaves the HTML and plain fallbacks byte-for-byte as they are (AC4), and splits at row boundaries with the header repeated (AC5). The earlier decision of poll 51 (keep the native table, shorten cells with an ellipsis) is superseded by 179814 and remains only as Q8.

## 5. Acceptance criteria

The numbered list is `.metaproject/flows/399-2026-10-03-topic-history-and-wide-tables/acceptance-criteria.md` (AC1 to AC17). Titles: AC1 table probe; AC2 table builder pinned; AC3 395 invariants hold; AC4 fallbacks unchanged; AC5 split with header repeated; AC6 restore on new topic only; AC7 what counts as a message; AC8 redaction and cap; AC9 order and labels; AC10 pacing and limits; AC11 empty history; AC12 idempotency; AC13 `/history [N]`; AC14 command registries; AC15 panel, sidebar, status, notice; AC16 docs and CHANGELOG; AC17 live acceptance.

## 6. Docs

README, `docs/docs/guides/drive-keryx-remotely.md`, the CLI and command reference, and `CHANGELOG.md`, updated with the code, with a version bump (AC16).

## 7. Live acceptance

Needs the operator's OK, because it uses a live Telegram session and a scratch topic. Steps: AC1 (probe) and AC17 (quit, `--continue`, `/remote-control <name>`, ten messages, `/history 3` in both places, a wide table).

## 8. Out of Scope

- Restoring history into a topic that already exists.
- Transports other than Telegram.
- Restoring the Telegram side of the conversation (the topic is deleted on exit and its messages are gone).
- Searching or filtering history.
- Changing when the topic is deleted on exit.
- A history of tool calls or tool output.
- Changing how the HTML and plain-text fallbacks lay out a table.

## 9. Open questions

Each with options; the first is the proposal.

- Q1. One flow or two? (a) One flow, probe first. (b) Two flows, history and tables, since they share nothing but the transport.
- Q2. Does the agent's narration between tool calls count? (a) Only the final reply of each turn. (b) Every assistant text block.
- Q3. Digest or per item? (a) One digest message, split at 4096. (b) One message per item (10 posts). (c) Digest by default, per item when N is 3 or fewer.
- Q4. Restore after `/resume` or `/new` inside a live topic? (a) No, the topic is not new. (b) Yes, after `/resume`.
- Q5. Which sessions restore? (a) Any session with qualifying messages. (b) Only a session resumed with `-r` or `-c`.
- Q6. Cap on N and per-item length? (a) N up to 50, an item cut at 1,500 characters with a marker. (b) N up to 20, an item at 800. (c) N up to 50, no per-item cut beyond `composeReply`.
- Q7. Time on each item? (a) Yes, HH:MM, with the date when it changes. (b) No.
- Q8. Keep the superseded ellipsis shortening as a fallback for any table the chosen layout cannot hold? (a) No. (b) Yes, for cells over a limit, with the full text one tap away.
- Q9. Table variant after the probe? (a) B if it is wide and scrolls and the injection risk is closed by escaping cells. (b) C if B fails or cannot be made safe. (c) A with a wider layout, if Telegram offers one.
- Q10. May short tables and 2-column tables stay as they are? (a) Yes, only if the probe shows they look fine in the narrow layout; list the justification in `probe.md`. (b) No, one layout for every table.
- Q11. May the probe and the live acceptance send to Telegram? (a) Yes, to a scratch topic, by the supervisor's OK per run. (b) No, offline fixtures only, AC1 and AC17 stay open.
- Q12. Flow 395 has an unconfirmed live AC11 on the same code. (a) Do this flow after 395 closes. (b) Work in parallel and merge by rebase.
- Q13. Assumption to confirm: the empty topic came from `/remote-control <name>` after `--continue`, not from something that re-enabled remote control by itself. (a) Confirmed. (b) Not so: the trigger needs another look.
