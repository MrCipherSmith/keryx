# Spike notes: wide tables in the Telegram topic (AC1)

Date: 2026-10-03. Sent by the flow agent through the project's own Bot API client
(`createHttpBotApi`, the bot token read from the local store and never printed), into the
operator's keryx-shell topic (chat -1003956371747, thread 57), as poll 53 allowed. Only the
three test tables below were sent, with no secrets, 2.5 s apart.

## The test table

Six columns, three rows, wide enough to overflow a phone bubble. The last cell of the third row
carries markup on purpose (`<u>tag</u>`, `**stars**`, `[link](https://example.com)`) to show what
each variant does with model text.

| Step | Command | Duration | Result | Owner | Notes |
|:-----|:--------|---------:|:------:|:------|:------|
| build | bun run build --target bun --external web-tree-sitter | 41s | ok | ci-runner-1 | cold cache, rebuilt every package from scratch |
| unit tests | bun test src/remote src/tui src/commands | 2m 08s | ok | ci-runner-2 | 1,204 tests, none skipped |
| smoke | keryx shell --headless --script smoke.txt | 12s | failed | ci-runner-3 | markup probe: <u>tag</u> and **stars** and [link](https://example.com) |

AC1 asks for a 3-column table; this one has 6 so that it overflows. The "helyx separator
rewrite" in the first wording of AC1 is not available to this repository, so B is the same
Markdown sent as is (AC1 was reworded to say so).

## Variants and message ids

| Variant | How it is sent | Message id | Telegram accepted it |
|:--------|:---------------|:----------:|:--------------------:|
| A | `sendRichMessage`, `blocks` with a `table` block (`renderRichMessage`, today's behaviour) | 61 | yes |
| B | `sendRichMessage`, `rich_message.markdown` with the table as Markdown | 62 | yes |
| C | `sendMessage`, `parse_mode: HTML`, the aligned `<pre>` block (`renderTelegramHtml`) | 63 | yes |

All three were accepted (HTTP ok, a message id each), including the `markdown` field, so B is
a live, working form of the API, not only a documented one.

## What this agent could and could not observe

The bot API returns ids, not pixels. This agent cannot see the rendered bubbles, and reading
them back through `getUpdates` would fight the running poller. So "wide", "scrolls sideways"
and "rendered height" are NOT recorded as observed. The operator reads messages 61, 62 and 63
in the topic and answers per variant: wide yes/no, scrolls sideways yes/no, how tall.

## Operator reading (2026-10-03, live, from their Telegram client)

| Variant | Message | Operator's answer |
|:--------|:-------:|:------------------|
| A | 61 | wide, scrolls sideways like helyx: chosen |
| B | 62 | not chosen |
| C | 63 | not chosen |

The operator's wording: variant A, the native `table` block, is today's behaviour and is the one
that is wide and scrolls sideways like helyx. "How tall it renders" was not given per variant.
The three variants are no longer a choice: A wins, so no new renderer is written.

## Choice

Variant A, the native table block (`renderRichMessage`, `tableBlock` in format-rich.ts). This
replaces the earlier provisional pick of C, which was made before the operator looked at 61 to
63 and is withdrawn. The reasoning that stays true:

- A is safe by construction (typed `blocks`, flow 395, spike S3): a cell is a cell, model text
  never reaches a parser (D4).
- The C and B arguments below are kept only as the record of why they were not needed.
- D5: one layout for every table; the probe had no short or 2-column table, so D5 is unchanged.

What PR 2 may still have to change, given A wins, is a code reading and not a rendering change:
see the journal entry for 2026-10-03 (cell width, the HTML and plain fallbacks).

### Provisional pick before the reading (superseded)

Variant C, the aligned `<pre>` block, under D4 and D5. A `<pre>` block keeps every column on one
line per row and Telegram clients scroll a code block sideways; it is the form already pinned in
golden files (AC4). In C the model text is escaped HTML inside `<pre>`; B passes model text
through a Markdown parser and would need every cell escaped (AC3). A was then thought to be the
layout the operator had reported as narrow and tall; the operator's reading shows it is not.
