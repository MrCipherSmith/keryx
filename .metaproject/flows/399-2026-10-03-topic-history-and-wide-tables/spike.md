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

## Choice (provisional, pending the operator's reading of 61 to 63)

Variant C, the aligned `<pre>` block, under D4 and D5:

- A `<pre>` block keeps every column on one line per row, which is the "wide, with a
  horizontal scroll when it does not fit" the operator described for helyx; Telegram clients
  scroll a code block sideways. It is also the form keryx already builds and already pins in
  golden files (format-table.ts), so AC4 stays untouched.
- Safety beats looks (D4): in C the model text is escaped HTML inside `<pre>`, so a cell cannot
  add a tag, an attribute or a block. Variant B passes model text through a Markdown parser, and
  the probe row with `<u>`, `**` and a link is exactly what that parser would act on; B would
  need every cell escaped, with AC3 passing the whole property corpus, to be safe at all.
- Variant A is safe (typed `blocks`, flow 395, spike S3) but is the layout the operator
  reported as narrow and tall.
- D5: one layout for every table; nothing in the probe argues for a special case, and the
  probe did not include a short or 2-column table, so D5 stands unchanged.

If the operator reads 62 (B) as clearly better looking and wide with scroll, the fallback is
B with every cell escaped (D4), and PR 2 must then prove it on the property corpus. If 63 (C)
is not wide or does not scroll on the operator's client, the choice reopens.
