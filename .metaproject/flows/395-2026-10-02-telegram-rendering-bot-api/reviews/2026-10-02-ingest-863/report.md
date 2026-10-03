Review of PR #863 at 25e6fb45 (logic): no high-severity defect survived verification; five findings R-1..R-5. A 20,000-input fuzz over the formatters found no unbalanced HTML, no part over its limit and no lost row. Checked and sound: splitting at 4096, header repetition, the (i/n) labels, escape handling, empty input, CRLF, mode auto per part and the edit path.

```json keryx:findings
[
  {
    "id": "R-1",
    "severity": "minor",
    "problem": "[reported severity: medium] `visualWidth` omits U+1F680-1F6FF, U+1FA00+, U+2705 and U+274C, so these count as width 1; skin-tone sequences are over-counted instead (visualWidth of a thumbs-up with skin tone is 4).",
    "impact": "Input `| s | n |\\n|---|---|\\n| rocket | a |\\n| ok | b |` with the rocket emoji: the row in the `<pre>` is padded as if the glyph were one cell wide, so its separator sits one column off from the `ok` row. Breaks the AC2 claim that emoji do not break alignment; status tables full of check and cross marks are common.",
    "suggested_fix": "Widen the wide-range table to the emoji-presentation ranges and treat skin-tone modifiers and joiner sequences as one glyph.",
    "evidence": "Confirmed by running visualWidth: rocket=1, check mark=1, thumbs-up with skin tone=4. 20,000-input fuzz over formatReply, renderTelegramHtml, checkTelegramHtml, renderPlainText and renderRichMessage found no unbalanced HTML, no part over its limit, no lost or duplicated row.",
    "confidence": "medium",
    "reviewer": "flow395-pr863-review-logic",
    "file": "src/lib/md-blocks.ts",
    "quote": "[0x1f300, 0x1f64f], // emoji"
  },
  {
    "id": "R-2",
    "severity": "minor",
    "problem": "[reported severity: medium] `tableAt` rejects any table where `renderedRowCost` > 1500 (rows are padded to the sum of the column widths), used from src/remote/format-table.ts.",
    "impact": "Input: a 3-column findings table whose two long columns hold 800-character cells, or one column with a 1600-character cell. `containsTable` is false, so `auto` mode sends HTML with raw pipes where rich could have drawn it natively. Violates AC2 (never raw pipes). The cap exists only for the padded `<pre>` layout.",
    "suggested_fix": "Apply the cost cap only to the aligned layout; keep such a table a table (rich draws it natively, text modes stack it).",
    "evidence": "Reproduced with the input described; containsTable returned false.",
    "confidence": "medium",
    "reviewer": "flow395-pr863-review-logic",
    "file": "src/remote/format-table.ts",
    "quote": "if ([header, ...rows].some((cells) => renderedRowCost(cells, widths) > MAX_TABLE_ROW_COST)) {"
  },
  {
    "id": "R-3",
    "severity": "minor",
    "problem": "[reported severity: low] The HTML and plain paths turn `<br>` in a table cell into a space (src/remote/format-table.ts), but the rich path (src/remote/format-rich.ts tableBlock) does not.",
    "impact": "Input `| a |\\n|---|\\n| x<br>y |`: HTML shows `x y`, the rich cell text is the literal `x<br>y`. LLMs often write `<br>` in table cells.",
    "suggested_fix": "Replace `<br>` with a space in the rich cell text too.",
    "evidence": "Reproduced with the input described.",
    "confidence": "medium",
    "reviewer": "flow395-pr863-review-logic",
    "file": "src/remote/format-rich.ts",
    "quote": "const cell = (text: string, column: number, header: boolean): RichBlockTableCell => {"
  },
  {
    "id": "R-4",
    "severity": "minor",
    "problem": "[reported severity: low] A 403 or 404 on one rich call calls `pauseRich` for 10 minutes for every chat and topic, and records the fall as a rich refusal (src/remote/rendering.ts isStanding and handleRichFailure).",
    "impact": "sendRichMessage returns 403 'bot was kicked from the group chat' for topic A: all table replies to healthy topic B go to HTML for 10 minutes and `/channels` shows a rich fallback caused by an unrelated chat error. A 400 'message thread not found' is likewise logged as a rich refusal.",
    "suggested_fix": "Pause rich only for a refusal of the method itself; treat chat or topic scoped errors as not a refusal of rich.",
    "evidence": "Traced through isStanding and handleRichFailure with the status codes described.",
    "confidence": "medium",
    "reviewer": "flow395-pr863-review-logic",
    "file": "src/remote/rendering.ts",
    "quote": "return isBotApiError(error) && error.kind === \"rejected\" && (error.status === 403 || error.status === 404 || error.status === 405);"
  },
  {
    "id": "R-5",
    "severity": "minor",
    "problem": "[reported severity: low] A persistent 5xx on `sendRichMessage` is rethrown and `isRetryable` (src/remote/types.ts) returns true, so the queue retries rich forever and never falls back to HTML. Only 4xx counts as a refusal in `isRefusal`.",
    "impact": "A gateway that returns 502 for the new method: the head entry of the outbound queue is never acked and every message behind it stalls.",
    "suggested_fix": "Bound the retries of rich for one message, then send it once as HTML.",
    "evidence": "Traced through handleRichFailure, isRefusal and isRetryable.",
    "confidence": "medium",
    "reviewer": "flow395-pr863-review-logic",
    "file": "src/remote/rendering.ts",
    "quote": "  if (!isRefusal(error)) {\n    throw error;\n  }"
  }
]
```
