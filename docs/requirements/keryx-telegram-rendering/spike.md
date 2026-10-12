# Spike: Telegram rich messages (Bot API 10.3)

Flow 395, acceptance criterion AC1. This note records what the Telegram Bot API reference says
about rich messages, so the renderer, the fake Bot API and the fallback chain are built against
the documented shape and not against memory.

Source: the Bot API reference at <https://core.telegram.org/bots/api>, read as of the
changelog entry "August 24, 2026 / Bot API 10.3" (the newest entry on the page when the spike
was written, 2026-10-02). Every fact below names its source anchor, the `#anchor` of the section
of that page it comes from. A fact that the reference does not state is marked **not stated**,
never filled in from guesswork.

`src/remote/rendering-spike.test.ts` checks this file: every fact row carries an anchor from the
list at the end, the numbers in the limits rows equal `RICH_LIMITS` in `src/remote/rich-types.ts`,
and the live probe section is either a message id or a recorded reason.

## Version history

| # | Fact | Source anchor |
|---|------|---------------|
| V1 | Rich messages arrived in Bot API 10.1 (June 11, 2026): `InputRichMessage`, `InputRichMessageContent`, the method `sendRichMessage`, the method `sendRichMessageDraft`, and the parameter `rich_message` on `editMessageText`. | `#june-11-2026` |
| V2 | Bot API 10.2 (July 14, 2026) added the field `blocks` to `InputRichMessage` ("allowing bots to specify rich message formatting via block entities") and the field `media`. | `#july-14-2026` |
| V3 | Bot API 10.3 (August 24, 2026) added `ephemeral_message_parameters` to `sendRichMessage` and `RichMessageButton`. keryx uses neither. | `#august-24-2026` |

## Input shape

| # | Fact | Source anchor |
|---|------|---------------|
| S1 | `InputRichMessage` describes a rich message to be sent. Exactly one of the fields `html`, `markdown` or `blocks` must be used. | `#inputrichmessage` |
| S2 | `blocks` is an "Array of InputRichBlock", the content described as a list of blocks. `html` and `markdown` are strings with HTML-style and Markdown-style formatting. `media`, `is_rtl` and `skip_entity_detection` are optional. | `#inputrichmessage` |
| S3 | **Decision:** keryx sends `blocks` only. A block list is data: text from the model is a string inside a typed node and cannot add a tag, an attribute or a block, which is the guarantee the HTML renderer gives by escaping. `markdown` and `html` would put the model's text back in front of a parser. | `#inputrichmessage` |
| S4 | `sendRichMessage` takes `chat_id` (required), `message_thread_id` (optional, forum supergroups), `rich_message` (required, an `InputRichMessage`) and `reply_markup` (optional, an inline keyboard among others). On success the sent `Message` is returned. | `#sendrichmessage` |
| S5 | `InputRichBlockTable` is `type: "table"` with `cells` (an array of rows of `RichBlockTableCell`) and optional `is_bordered`, `is_striped`, `is_compact` and `caption`. | `#inputrichblocktable` |
| S6 | `RichBlockTableCell` has `text` (optional; "if omitted, then the cell is invisible"), `is_header`, `colspan`, `rowspan`, and `align` and `valign`, which carry no "Optional" mark. `align` is one of left, center, right; `valign` is one of top, middle, bottom. keryx always writes both. | `#richblocktablecell` |
| S7 | `InputRichBlockList` is `type: "list"` with `items`. `InputRichBlockListItem` has `blocks`, optional `has_checkbox`, optional `is_checked`, and for ordered lists `value` (the numeric label) and `type` (`"1"` is decimal numbers). A nested list is a list block inside an item's `blocks`. | `#inputrichblocklist`, `#inputrichblocklistitem` |
| S8 | `InputRichBlockSectionHeading` is `type: "heading"` with `text` and `size`, 1 to 6, 1 the largest. | `#inputrichblocksectionheading` |
| S9 | `InputRichBlockPreformatted` is `type: "pre"` with `text` and an optional `language`. | `#inputrichblockpreformatted` |
| S10 | There are also block types `paragraph`, `divider`, `blockquote` and `expandable_blockquote`, the other types keryx writes. | `#inputrichblockparagraph`, `#inputrichblockdivider`, `#inputrichblockblockquotation`, `#inputrichblockexpandableblockquotation` |
| S11 | `RichText` is a string, an array of `RichText`, or a typed object (`bold`, `italic`, `strikethrough`, `code`, `url`, ...). | `#richtext` |

## Limits

| # | Fact | Source anchor |
|---|------|---------------|
| L1 | Up to **32768** UTF-8 characters in the rich message text. | `#rich-message-limits` |
| L2 | Up to **500** blocks, "including nested blocks, list items, ordered list items, table rows, quotation blocks, and details blocks". A list item and a table row each count as a block. | `#rich-message-limits` |
| L3 | Up to **16** levels of nested formatting and blocks. | `#rich-message-limits` |
| L4 | Up to **20** columns in a table. | `#rich-message-limits` |
| L5 | Table size has no stated row limit of its own: rows count against the 500 blocks (L2) and cell text against the 32768 characters (L1). | `#rich-message-limits` |
| L6 | The ordinary text limit is a separate one: `editMessageText` with `text` still takes "1-4096 characters after entity parsing". keryx's 4096 splitter keeps governing the HTML and plain paths. | `#editmessagetext` |

## Who may send them

| # | Fact | Source anchor |
|---|------|---------------|
| A1 | The reference states **no** bot setting, BotFather switch, chat type or permission that an ordinary bot needs for `sendRichMessage` in a chat. The only restriction written is for business accounts: a bot can send rich messages on behalf of a business account only if the corresponding user can send rich messages. | `#sendrichmessage` |
| A2 | The same method says that if the message contains a block with a media element, the bot must have the right to send that media to the chat. keryx sends no media blocks. | `#sendrichmessage` |
| A3 | **Consequence:** an unstated requirement is not a guarantee. A server that predates 10.1, a bot Telegram does not allow, or a chat type that rejects the method will answer with an error. The implementation therefore feature-detects: any 4xx on a rich call is a refusal, and the same text is sent once as HTML, then once as plain (flow 395, AC5). A 403, 404 or 405 also pauses rich for ten minutes, so a bot that cannot use it does not pay a failed call for every message. | `#sendrichmessage` |

## Editing

| # | Fact | Source anchor |
|---|------|---------------|
| E1 | `editMessageText` is documented as "edit text, rich and game messages". | `#editmessagetext` |
| E2 | Its parameter `rich_message` (`InputRichMessage`) is "new rich content of the message; required if text isn't specified". `text` is in turn "required if rich_message isn't specified". So an edit carries one of the two. | `#editmessagetext` |
| E3 | The method returns the edited `Message` (or `True` for an inline message). Edits of an unchanged message are answered by Telegram with a 400 "message is not modified" for text edits; the reference does not state this for `rich_message`, so keryx treats an identical rich edit the same way as a text one: the state wanted already holds, nothing is resent. **Not stated** for rich; the live probe below does not cover it. | `#editmessagetext` |
| E4 | `reply_markup` on `editMessageText` is an `InlineKeyboardMarkup`. keryx sends an empty keyboard unless one is given, as it does for text edits. | `#editmessagetext` |
| E5 | Direct upload of new files in an edit is not supported for inline messages. keryx edits chat messages and uploads nothing. | `#editmessagetext` |

## Live probe

One message to the operator chat through the rich path, labelled as a test, with its message id.

- **Status: PENDING operator live acceptance.**
- **Why it was not run:** this machine has no keryx bot token configured (`keryx remote` is not
  set up here), and the rule for this flow is that a probe is sent only when a local token exists
  and sending is safe. The token is never read from anywhere else, never logged and never echoed.
- **What stands in for it:** the shape (S1 to S11) and the limits (L1 to L6) are taken from the
  reference; `FakeBotApi` enforces the limits from the block list alone; and every refusal path is
  tested (`src/remote/outbound-rich.test.ts`). If Telegram refuses the real message for a reason
  the reference does not state, the fallback chain sends it as HTML, so the operator still
  receives the reply, and `/channels` shows the step and the reason.
- **How the operator closes it:** run `keryx remote format-sample`, then in the shell set
  `/rendering rich` and send the sample reply to a Telegram topic (this is also the AC11 judgement).
  The first message that arrives as a native table is the probe: record its message id here.

Message id: _not yet recorded_

## Anchors used

`#june-11-2026`, `#july-14-2026`, `#august-24-2026`, `#inputrichmessage`, `#sendrichmessage`,
`#inputrichblocktable`, `#richblocktablecell`, `#inputrichblocklist`, `#inputrichblocklistitem`,
`#inputrichblocksectionheading`, `#inputrichblockpreformatted`, `#inputrichblockparagraph`,
`#inputrichblockdivider`, `#inputrichblockblockquotation`, `#inputrichblockexpandableblockquotation`,
`#richtext`, `#rich-message-limits`, `#editmessagetext`.
