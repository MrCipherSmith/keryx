# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: A spike note `docs/requirements/keryx-telegram-rendering/spike.md` records, for Bot API 10.3, the `sendRichMessage` and `InputRichMessage` input shape (markdown, html, blocks), its limits (characters, blocks, table size), whether an ordinary bot may use it without a setting, and how `editMessageText` with `rich_message` behaves. Each fact names the source anchor, and one live probe (one message sent to the operator chat, its message id) confirms the rich path or records why it was refused. [verify: exec `bun test src/remote/rendering-spike.test.ts`]
- AC2: A Markdown table in a reply is never sent as raw pipes. In HTML mode it becomes an aligned `<pre>` block (column widths by display width, so CJK and emoji do not break the alignment, separator row dropped); in rich mode it becomes a native table block. [verify: exec `bun test src/remote/format-table.test.ts`]
- AC3: Ordered lists keep their numbers, nested bullets keep their indentation, task items `- [ ]` and `- [x]` show as a box and a ticked box, and a horizontal rule shows as a line, in HTML mode and in rich mode. [verify: exec `bun test src/remote/format-html.test.ts src/remote/format-rich.test.ts`]
- AC4: Every invariant of the HTML renderer holds for the new constructs: text from the model cannot add a tag, output is balanced and passes `checkTelegramHtml`, and the part is never longer after parsing than before. A generated corpus of at least 200 inputs mixing tables, lists, code, quotes, links and stray markup proves it. [verify: exec `bun test src/remote/format-html.test.ts src/remote/format-property.test.ts`]
- AC5: In `auto` mode a reply with a table goes out through `sendRichMessage` and its later edit through `editMessageText` with `rich_message`; a reply without one stays HTML. On any refusal (400, unsupported method, bot not allowed) the same text goes out once as HTML and, if that is refused too, once as plain text; a message is never dropped, and each fallback is recorded with its reason. [verify: exec `bun test src/remote/outbound-rich.test.ts src/remote/outbound-html.test.ts`]
- AC6: Splitting still produces numbered `(i/n)` parts within the limit in every mode, and a table is never cut inside a row: a split falls between rows and the header row is repeated at the top of the next part. [verify: exec `bun test src/remote/format.test.ts src/remote/format-table.test.ts`]
- AC7: The setting `remote.rendering` takes `auto`, `rich`, `html` or `plain` (default `auto`), is read from the remote config and rejects any other value with a message naming the valid ones. [verify: exec `bun test src/remote/config.test.ts`]
- AC8: The shell shows it: the `/settings` modal has a "Telegram rendering" row that reads and changes the mode, the `/channels` modal shows the mode in effect and the last fallback (step, reason, time), and `keryx remote format-sample` prints the fixed sample reply in every mode with no network. [verify: exec `bun test src/tui src/remote/format-sample.test.ts`]
- AC9: Text without a table, a numbered or nested list, a task item or a rule renders byte-for-byte as it does in 0.3.63, except one case: a link whose visible label reads as a web address (starts with http:// or https://, or www., or is a host with a dot) for a different host than its target gets the target host written after it, as ' (→ host)'; every other link is unchanged. The existing format, HTML and outbound tests pass unchanged. [verify: invariant `bun test src/remote/format.test.ts src/remote/format-html.test.ts src/remote/outbound-html.test.ts`]
- AC10: The guide `drive-keryx-remotely.md`, the README remote section and the CHANGELOG describe the modes, the table and list rendering and the fallback chain, and `mkdocs build --strict` passes. [verify: exec `bun test src/remote/rendering-docs.test.ts`]
- AC11: Live acceptance by the operator: the fixed sample reply (table, nested list, checklist, code with a language, quote, a long text that splits) arrives in Telegram in `rich` and in `html` mode, and the operator judges each as laid out correctly and better than the 0.3.63 output. [verify: judged]
