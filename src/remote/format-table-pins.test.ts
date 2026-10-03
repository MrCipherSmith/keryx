// How a table reaches Telegram, pinned (flow 399, PR 2; AC2 to AC5).
//
// The operator read the three probe messages and chose variant A, the native `table` block that
// keryx already sends (flow 395): it is wide and scrolls sideways, like helyx. So there is no new
// renderer here. These tests pin what exists, with literal expectations, so a change that makes a
// table narrower (a shortened cell, a cell turned into markup), drops a row, or sends a part Telegram
// would refuse fails:
//
//   AC2  the native block for a corpus of tables, every cell whole, nothing shortened;
//        more than 20 columns is not a table;
//   AC3  a cell is always a cell: markdown and block syntax in it stays text;
//   AC4  the HTML and plain fallbacks (aligned, stacked) and the order refusals fall in;
//   AC5  a table too large for one message splits between rows with the header repeated, within
//        4096 characters and within the rich limits (500 blocks, a table row is a block).

import { describe, expect, test } from "bun:test";
import { checkRichMessage, FakeBotApi } from "./fake-bot-api";
import { formatReply, renderedLength } from "./format";
import { renderTelegramHtml } from "./format-html";
import { renderPlainText } from "./format-plain";
import { containsTable, renderRichMessage } from "./format-rich";
import { MAX_TABLE_COLUMNS, MAX_TABLE_ROW_COST, MAX_TABLE_ROWS_PER_PART } from "./format-table";
import { firstStep, type RenderFallback, RenderingState, sendRendered } from "./rendering";
import { type InputRichBlock, RICH_LIMITS, type RichBlockTableCell, type RichText } from "./rich-types";
import { BotApiError } from "./types";

function tableOf(text: string): Extract<InputRichBlock, { type: "table" }> {
  const block = renderRichMessage(text).blocks.find((candidate) => candidate.type === "table");
  if (block === undefined || block.type !== "table") {
    throw new Error("no table block");
  }
  return block;
}

const cell = (text: RichText | undefined, align: "left" | "center" | "right", header = false): RichBlockTableCell => ({
  ...(text === undefined ? {} : { text }),
  ...(header ? { is_header: true as const } : {}),
  align,
  valign: "top",
});

describe("AC2: the native table block, every cell whole", () => {
  test("a corpus row set with Cyrillic, emoji, an escaped pipe, inline markup, an empty cell and a 300-character cell", () => {
    const long = "я".repeat(300);
    const source = [
      "| Шаг | Команда | Итог |",
      "|:---|---:|:---:|",
      "| сборка 🚀 | `bun run build` \\| tee | **ok** |",
      "|  | [docs](https://example.com/a) | <u>x</u> & y |",
      `| ${long} | b | c |`,
    ].join("\n");
    expect(renderRichMessage(source)).toEqual({
      blocks: [
        {
          type: "table",
          is_bordered: true,
          cells: [
            [cell("Шаг", "left", true), cell("Команда", "right", true), cell("Итог", "center", true)],
            [cell("сборка 🚀", "left"), cell([{ type: "code", text: "bun run build" }, " | tee"], "right"), cell({ type: "bold", text: "ok" }, "center")],
            [cell(undefined, "left"), cell({ type: "url", text: "docs", url: "https://example.com/a" }, "right"), cell("<u>x</u> & y", "center")],
            [cell(long, "left"), cell("b", "right"), cell("c", "center")],
          ],
        },
      ],
    });
  });

  test("2, 3, 6 and 20 columns are each one table block with all their cells", () => {
    for (const columns of [2, 3, 6, MAX_TABLE_COLUMNS]) {
      const header = Array.from({ length: columns }, (_, index) => `h${index}`);
      const body = Array.from({ length: columns }, (_, index) => `v${index}`);
      const source = [`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`, `| ${body.join(" | ")} |`].join("\n");
      const block = tableOf(source);
      expect(block.cells).toHaveLength(2);
      expect(block.cells.map((row) => row.map((one) => one.text))).toEqual([header, body]);
    }
  });

  test("a table of more than 20 columns is not a table: it stays ordinary text and goes the HTML way", () => {
    const names = Array.from({ length: MAX_TABLE_COLUMNS + 1 }, (_, index) => `c${index}`);
    const source = [`| ${names.join(" | ")} |`, `|${names.map(() => "---").join("|")}|`, `| ${names.join(" | ")} |`].join("\n");
    expect(containsTable(source)).toBe(false);
    expect(firstStep("auto", source)).toBe("html");
    expect(renderRichMessage(source).blocks.some((block) => block.type === "table")).toBe(false);
    const html = renderTelegramHtml(source);
    expect(html).not.toContain("<pre>");
    expect(html).toContain(names.join(" | "));
    expect(RICH_LIMITS.tableColumns).toBe(MAX_TABLE_COLUMNS);
  });

  test("no cell is shortened in any mode: rich, HTML and plain keep a 300-character and a 1,400-character cell whole", () => {
    for (const length of [300, 1400]) {
      const word = "ж".repeat(length);
      const source = `| a | b |\n|---|---|\n| ${word} | z |`;
      expect(tableOf(source).cells[1]?.[0]?.text).toBe(word);
      const html = renderTelegramHtml(source);
      const plain = renderPlainText(source);
      for (const text of [html, plain]) {
        expect(text).toContain(word);
        expect(text).not.toContain("…");
        expect(text).not.toContain("...");
      }
    }
  });

  test("a cell past the stacking threshold is still whole: rich draws it natively, the text modes stack it, none shortens it", () => {
    const word = "w".repeat(MAX_TABLE_ROW_COST + 500);
    const source = `| note | n |\n|---|---|\n| ${word} | 1 |`;
    expect(tableOf(source).cells[1]?.[0]?.text).toBe(word);
    expect(renderTelegramHtml(source)).toBe(`note: ${word}\nn: 1`);
    expect(renderPlainText(source)).toBe(`note: ${word}\nn: 1`);
    expect(formatReply(source, 4096)).toEqual([source]);
  });

  test("short and 2-column tables use the same native block, with no special case (D5)", () => {
    expect(tableOf("| a |\n|---|\n| 1 |").cells).toEqual([[cell("a", "left", true)], [cell("1", "left")]]);
    expect(tableOf("| a | b |\n|---|---|\n| 1 | 2 |").cells).toEqual([
      [cell("a", "left", true), cell("b", "left", true)],
      [cell("1", "left"), cell("2", "left")],
    ]);
  });
});

describe("AC3: a cell is a cell, whatever the model wrote in it", () => {
  const HOSTILE = ["# heading", "- item", "> quote", "```", "<script>alert(1)</script>", "[x](javascript:alert(1))", "1. one", "---"];

  test("markdown and block syntax in a cell stays text inside the one table block", () => {
    const source = ["| a |", "|---|", ...HOSTILE.map((text) => `| ${text} |`)].join("\n");
    const message = renderRichMessage(source);
    expect(message.blocks).toHaveLength(1);
    const block = tableOf(source);
    expect(block.cells.slice(1).map((row) => row[0]?.text)).toEqual(HOSTILE);
    expect(checkRichMessage(message)).toBeUndefined();
  });

  test("HTML mode escapes the same cells inside <pre>, so none opens a tag", () => {
    const html = renderTelegramHtml(["| a |", "|---|", "| <script>alert(1)</script> |", "| <b>x</b> & y |"].join("\n"));
    expect(html).toBe("<pre>a\n&lt;script&gt;alert(1)&lt;/script&gt;\n&lt;b&gt;x&lt;/b&gt; &amp; y</pre>");
  });

  test("what the corpus renders passes the documented rich limits as the fake checks them", () => {
    const source = ["| a | b |", "|:--|--:|", ...Array.from({ length: 120 }, (_, row) => `| r${row} | **v${row}** |`)].join("\n");
    expect(checkRichMessage(renderRichMessage(source))).toBeUndefined();
  });
});

describe("AC4: the HTML and plain fallbacks of a table", () => {
  const SOURCE = "| Name | N |\n|:--|--:|\n| a | 1 |\n| long name | 22 |";
  const ALIGNED = "Name      │  N\na         │  1\nlong name │ 22";

  test("the aligned layout, exactly", () => {
    expect(renderPlainText(SOURCE)).toBe(ALIGNED);
    expect(renderTelegramHtml(SOURCE)).toBe(`<pre>${ALIGNED}</pre>`);
  });

  test("the stacked layout for a row too long to align, exactly", () => {
    const source = `| a | b |\n|---|---|\n| ${"x".repeat(2000)} | y |\n| 1 | 2 |`;
    const expected = `a: ${"x".repeat(2000)}\nb: y\n\na: 1\nb: 2`;
    expect(renderPlainText(source)).toBe(expected);
    expect(renderTelegramHtml(source)).toBe(expected);
  });

  test("a refused rich send falls to HTML, a refused HTML send falls to plain text, in that order, with the same table", async () => {
    const api = new FakeBotApi({ chatId: 1 });
    const state = new RenderingState({ now: () => 1_000, mode: () => "auto" });
    const seen: RenderFallback[] = [];
    api.failNext("sendRichMessage", new BotApiError("rejected", "sendRichMessage: 400 Bad Request: rich_message is invalid", { status: 400 }));
    api.failNext("sendMessage", new BotApiError("rejected", "sendMessage: 400 Bad Request: can't parse entities", { status: 400 }));
    await sendRendered(api, { chatId: 1, text: SOURCE }, { state, onFallback: (fallback) => seen.push(fallback) });
    expect(seen.map((fallback) => fallback.step)).toEqual(["rich-to-html", "html-to-plain"]);
    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]?.parseMode).toBeUndefined();
    expect(api.sent[0]?.text).toBe(ALIGNED);
  });
});

describe("AC5: a table too large for one message", () => {
  const rowText = (index: number): string => `| row${index} | ${"note ".repeat(12).trim()} ${index} |`;
  const tableSource = (rows: number, row: (index: number) => string = rowText): string => ["| id | note |", "|---|---|", ...Array.from({ length: rows }, (_, index) => row(index))].join("\n");

  /** The body rows of a part, label and header dropped. */
  const bodyOf = (part: string): string[] => part.split("\n").slice(3);
  /** One narrow column: 1,500 rows are about 3,000 characters aligned, so only the row cap can split it. */
  const columnSource = (rows: number): string => ["| n |", "|---|", ...Array.from({ length: rows }, (_, index) => `| ${index % 10} |`)].join("\n");
  const columnRow = (index: number): string => `| ${index % 10} |`;

  test("at the real 4096 limit: whole rows, header repeated, in order, nothing lost, every part within the limit", () => {
    const source = tableSource(160);
    const parts = formatReply(source);
    expect(parts.length).toBeGreaterThan(2);
    parts.forEach((part, index) => {
      expect(part.startsWith(`(${index + 1}/${parts.length})\n| id | note |\n|---|---|\n`)).toBe(true);
      // Counted as rendered: the aligned layout of a part can be shorter than its source text.
      expect(renderedLength(part)).toBeLessThanOrEqual(4096);
    });
    expect(parts.flatMap(bodyOf)).toEqual(Array.from({ length: 160 }, (_, index) => rowText(index)));
  });

  test("every part of that split is a native table within the rich limits", () => {
    for (const part of formatReply(tableSource(160))) {
      const message = renderRichMessage(part);
      expect(checkRichMessage(message)).toBeUndefined();
      expect(tableOf(part).cells[0]?.map((one) => one.text)).toEqual(["id", "note"]);
    }
  });

  test("a tall, narrow table splits by rows, not only by characters: 500 blocks is a limit of the rich message too", () => {
    const rows = 1500;
    const source = columnSource(rows);
    // As rendered it fits one message, so only the row cap can split it.
    expect(renderedLength(source)).toBeLessThan(4096);
    const parts = formatReply(source);
    expect(parts).toHaveLength(Math.ceil(rows / (MAX_TABLE_ROWS_PER_PART - 1)));
    const seen: string[] = [];
    for (const part of parts) {
      expect(bodyOf(part).length + 1).toBeLessThanOrEqual(MAX_TABLE_ROWS_PER_PART);
      expect(checkRichMessage(renderRichMessage(part))).toBeUndefined();
      seen.push(...bodyOf(part));
    }
    expect(seen).toHaveLength(rows);
    expect(seen).toEqual(Array.from({ length: rows }, (_, index) => columnRow(index)));
  });

  test("the boundary: a table with MAX_TABLE_ROWS_PER_PART rows including the header is one part, one row more is two", () => {
    const fits = columnSource(MAX_TABLE_ROWS_PER_PART - 1);
    expect(formatReply(fits)).toEqual([fits]);
    const parts = formatReply(columnSource(MAX_TABLE_ROWS_PER_PART));
    expect(parts).toHaveLength(2);
    expect(bodyOf(parts[1] as string)).toHaveLength(1);
    expect(parts[1]?.split("\n").slice(1, 3)).toEqual(["| n |", "|---|"]);
  });

  test("the cap leaves room under the 500 blocks for the part label and the text around the table", () => {
    expect(MAX_TABLE_ROWS_PER_PART).toBeLessThan(RICH_LIMITS.blocks);
    expect(RICH_LIMITS.blocks - MAX_TABLE_ROWS_PER_PART).toBeGreaterThanOrEqual(50);
  });

  test("sent part by part, a tall table stays a native table: no fallback to HTML, no refusal", async () => {
    const api = new FakeBotApi({ chatId: 1 });
    const state = new RenderingState({ now: () => 1_000, mode: () => "auto" });
    const seen: RenderFallback[] = [];
    const parts = formatReply(columnSource(1500));
    for (const part of parts) {
      await sendRendered(api, { chatId: 1, text: part }, { state, onFallback: (fallback) => seen.push(fallback) });
    }
    expect(seen).toEqual([]);
    expect(api.callCount("sendRichMessage")).toBe(parts.length);
    expect(api.callCount("sendMessage")).toBe(0);
  });

  test("a table with text before and after it keeps the text and still splits between rows", () => {
    const source = `before\n\n${tableSource(160)}\n\nafter`;
    const parts = formatReply(source);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0]).toContain("before\n");
    expect(parts[parts.length - 1]?.endsWith("after")).toBe(true);
    for (const part of parts) {
      expect(renderedLength(part)).toBeLessThanOrEqual(4096);
    }
  });
});
