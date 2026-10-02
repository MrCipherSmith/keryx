# Telegram rendering via the current Bot API

Status: draft
Source: user description (origin: human-request, channel message 177577)

## Problem

Since 0.3.56 keryx sends Telegram replies as `parse_mode: "HTML"` (flow 376), with plain-text fallback and `(i/n)` splitting. The operator accepted the splitting and readability (AC13 of flow 376) and asked for a nicer rendering built on the current Bot API. The renderer in `src/remote/format-html.ts` covers bold, italic, strike, inline code, fenced code with a language, quotes (expandable from 8 lines), https links, headings and `-` bullets. It does not handle Markdown tables (the pipes arrive as raw text), ordered and nested lists, task items or horizontal rules. Bot API 10.1 to 10.3 (June to August 2026) added rich messages: `sendRichMessage`, `InputRichMessage`, `editMessageText` with `rich_message`, and blocks for tables, lists, section headings, expandable quotations and details. keryx does not use them.

## Expected Outcome

A reply that contains a table, an ordered or nested list, task items or a rule reads as a table, a list, a checklist and a divider in Telegram, whatever the mode. Where the Bot API's rich messages are available to the bot, tables and lists go out natively; everywhere else, and on any refusal, the same text goes out as HTML and, last, as plain text, so no message is lost. The rendering mode is a setting the operator can see and change in the shell. Everything the HTML renderer guarantees today (escaping, balanced tags, the 4096 limit after parsing, splitting with numbered parts) keeps holding for the new constructs.

## Outcome criteria

- Запрос (дословно): «Ответ на АС13 : читаемы, есть разбиение Ок. Но создан отдельно или добавлено во фло сделать рендеринг красивым на основании свежего апи телеграмма» (the operator, channel message 177577, 2026-10-02 06:08 UTC).
- Эффект (формализация агента): the operator reads a keryx reply with a table, a nested list, a checklist, code and a quote in Telegram and finds each of them laid out as such, with no raw pipes, no stray markers and no lost message, in the rich mode and in the HTML fallback.
- Как наблюдать (предложение агента): the judged AC at the end of the criteria: the operator receives the fixed sample reply in each mode and compares it with the 0.3.63 output; and the `/settings` row and the `/channels` line name the mode in effect and the last fallback.

## Design notes

- The spike comes first (AC1): the Bot API reference page was truncated for the `sendRichMessage` signature, so the input shape (markdown, html or blocks), the limits and whether an ordinary bot may use it are unknown until probed against the real API.
- Mode `auto` (default) uses rich messages for replies that contain a table or a list the HTML cannot express well, and HTML for the rest. `rich`, `html` and `plain` force a mode.
- Fallback chain on a refusal: rich, then HTML, then plain. Each step is recorded with its reason.

## Out of Scope

Streaming a reply as it is written (`sendMessageDraft`, `sendRichMessageDraft`), media, polls, buttons and live photos in rich messages, custom emoji, changing how a reply is split into parts apart from keeping a table whole, and inbound formatting (what the operator types).
