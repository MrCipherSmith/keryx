# Telegram topic history restore and wide tables

Status: draft (PRD and acceptance criteria for the operator's review; not frozen)
Source: user description (origin: human-request, channel message 179104; a second message, 179814, on tables)
PRD: `docs/requirements/keryx-topic-history/prd.md`

## Problem

Two things the operator met in one session of `keryx shell` driven from Telegram.

1. Leaving `keryx shell` turns remote control off, which deletes the Telegram topic. Starting the shell again with `--continue` picks the session up, but remote control starts only on `/remote-control <name>`, and that creates a new, empty topic. The session still holds the conversation; the topic shows none of it, so the operator cannot see where the work stood without going back to the terminal.
2. A Markdown table in a reply arrives in Telegram as a native rich table in a narrow bubble: the long column wraps to 8 to 10 lines and the rows grow very tall. The same table in the keryx shell is compact. In helyx the same kind of table is wide and scrolls sideways when it does not fit.

## Expected Outcome

When a topic is created for a session that already has a conversation, the topic receives the last 10 messages of that conversation (the operator's and the agent's, oldest first, labelled) without being asked, and `/history [N]` posts the last N on demand, from the shell and from the topic. A table in a reply reaches Telegram in the layout helyx gives it: wide, with horizontal scroll when it does not fit, not a narrow column wrapped over many lines. Both are visible in the shell (command, help, remote-control panel, sidebar) and documented.

## Outcome criteria

- Запрос (дословно): «1. Как только я вышел из keryx shell топик убился, когда я запустил с продолжением keryx shell подхватил сессию, но топик создался новый и пустой. Это правильно, но нудна команда восстановить историю, и по ней присылать в топик 10 последних сообщений(и мои и агента)
    2 смотри скриншоты. 1 это что пришло, 2 это как в keryx shell» (source: channel message 179104, 2026-10-02T20:11:19Z). Second message, on tables: «Про таблицы в телеграм, в helyx они широкие и если не вылазят, есть горизонтальный скрол» (source: channel message 179814, 2026-10-03T06:26:31Z).
- Эффект (формализация агента): after the operator leaves the shell, comes back with `--continue` and turns remote control on again, the new topic opens with the last 10 turns of the conversation (theirs and the agent's), so they can pick up where it stopped, and `/history N` brings back more at any time; a table the agent sends reads in Telegram as one wide table that scrolls sideways, not as a tall, narrow one.
- Как наблюдать (предложение агента): the judged criteria at the end: the operator quits the shell, runs `keryx shell --continue`, runs `/remote-control <name>`, and sees the 10 messages arrive in the new topic, in order and labelled; types `/history 3` in the topic and in the shell and sees three; asks for a table and compares it with the helyx layout. In the shell, the `/remote-control` panel and the sidebar show when the history was last posted and how many messages.

## Design notes

- Where the topic is created: `Hub.register` (`src/remote/hub.ts`) answers `reused: false` when it made a new topic and `reused: true` when a live or kept topic held the name. The shell learns it from `RemoteClient.start()` through `RemoteBridge.enable()` (`src/remote/shell-bridge.ts`). Resuming a session never turns remote control on (flow 376, AC4), so the restore is tied to topic creation, not to the resume.
- Where the messages are: the session store (`src/session/store.ts`): `loadArchive` (the full history, falling back to `context.jsonl`) and `isOperatorMessage` (`src/session/compact.ts`), which tells the operator's turns from injected ones.
- Tables: keryx sends a `table` block (`src/remote/format-rich.ts`, `is_bordered: true`) on purpose, not rich Markdown (spike S3 in `docs/requirements/keryx-telegram-rendering/spike.md`). helyx sends the reply as `rich_message: { markdown }` (`helyx/mcp/tools.ts:443`) after rewriting bare separator rows so each carries a colon (`helyx/channel/telegram.ts:232`). Whether Telegram lays the markdown form out as a wide, scrollable table is not established by any code or note; the first table criterion is a probe that settles it before anything is built.
- The earlier decision of poll 51 on tables (keep the native table, shorten long cells with an ellipsis) is superseded by message 179814 and survives only as an open question (Q8 in the PRD).

## Out of Scope

See the PRD: restoring history into a topic that already exists, transports other than Telegram, restoring the Telegram side of the conversation (the topic is deleted for good), searching history, changing how the topic is deleted on exit, a history of tool calls, and any change to how the HTML and plain fallbacks lay out a table.
