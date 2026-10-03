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
//        4096 characters and within the rich limits (500 blocks for the whole part: a table row, a
//        paragraph, a list item each count); a row that cannot share a part with the header is stacked
//        as "Header: value" lines, and only a single cell larger than a message is cut.

import { describe, expect, test } from "bun:test";
import { checkRichMessage, FakeBotApi } from "./fake-bot-api";
import { formatReply, renderedLength } from "./format";
import { renderTelegramHtml } from "./format-html";
import { renderPlainText } from "./format-plain";
import { containsTable, renderRichMessage } from "./format-rich";
import { MAX_TABLE_COLUMNS, MAX_TABLE_ROW_COST, tableAt, tableLayout } from "./format-table";
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

  test("the stacking threshold, pinned at 1,499, 1,500 and 1,501 units of the widest aligned row", () => {
    // `| a | b |` over `| <L x> | y |`: the aligned row is L + 5 units, header included.
    const source = (length: number): string => `| a | b |\n|---|---|\n| ${"x".repeat(length)} | y |`;
    const layoutOf = (text: string) => tableLayout((tableAt(text.split("\n"), 0) as NonNullable<ReturnType<typeof tableAt>>).table);
    expect(MAX_TABLE_ROW_COST).toBe(1500);
    for (const [length, layout] of [
      [MAX_TABLE_ROW_COST - 6, "aligned"],
      [MAX_TABLE_ROW_COST - 5, "aligned"],
      [MAX_TABLE_ROW_COST - 4, "stacked"],
    ] as const) {
      const text = source(length);
      expect(layoutOf(text)).toBe(layout);
      const html = renderTelegramHtml(text);
      const plain = renderPlainText(text);
      if (layout === "aligned") {
        expect(html.startsWith("<pre>a")).toBe(true);
        expect(html).toContain(" │ y</pre>");
        expect(plain).toContain(" │ y");
        expect(plain).not.toContain("a: ");
      } else {
        expect(html).toBe(`a: ${"x".repeat(length)}\nb: y`);
        expect(plain).toBe(`a: ${"x".repeat(length)}\nb: y`);
      }
    }
  });

  test("a body row with more cells than the header drops the extras, a shorter row is padded, in every mode (GFM)", () => {
    const source = "| a | b |\n|---|---|\n| 1 | 2 | 3 | 4 |\n| 5 |";
    const block = tableOf(source);
    expect(block.cells.map((row) => row.map((one) => one.text))).toEqual([["a", "b"], ["1", "2"], ["5", undefined]]);
    expect(renderTelegramHtml(source)).toBe("<pre>a │ b\n1 │ 2\n5 │</pre>");
    expect(renderPlainText(source)).toBe("a │ b\n1 │ 2\n5 │");
    for (const text of [renderTelegramHtml(source), renderPlainText(source)]) {
      expect(text).not.toContain("3");
      expect(text).not.toContain("4");
    }
    // The splitter keeps the source as written: the drop happens when a part is rendered.
    expect(formatReply(source)).toEqual([source]);
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

  /** Rich limit for a part, less the label paragraph and the closing marker the splitter keeps free. */
  const ROWS_PER_PART = RICH_LIMITS.blocks - 4;
  /** Every part is within the characters and the rich limits as the fake checks them. */
  const expectNative = (parts: readonly string[]): void => {
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(4096);
      expect(checkRichMessage(renderRichMessage(part))).toBeUndefined();
    }
  };
  const rowsIn = (parts: readonly string[], pattern: RegExp): string[] => parts.flatMap((part) => part.split("\n").filter((line) => pattern.test(line)));

  test("a tall, narrow table splits by rows, not only by characters: 500 blocks is a limit of the rich message too", () => {
    const rows = 1500;
    const source = columnSource(rows);
    // As rendered it fits one message, so only the block budget can split it.
    expect(renderedLength(source)).toBeLessThan(4096);
    const parts = formatReply(source);
    expect(parts).toHaveLength(Math.ceil(rows / ROWS_PER_PART));
    const seen: string[] = [];
    for (const part of parts) {
      expect(bodyOf(part).length).toBeLessThanOrEqual(ROWS_PER_PART);
      seen.push(...bodyOf(part));
    }
    expectNative(parts);
    expect(seen).toHaveLength(rows);
    expect(seen).toEqual(Array.from({ length: rows }, (_, index) => columnRow(index)));
  });

  test("the boundary: the header and 496 rows are one message of 498 blocks, one row more is two parts", () => {
    const fits = columnSource(ROWS_PER_PART);
    expect(formatReply(fits)).toEqual([fits]);
    expect(renderRichMessage(fits).blocks).toHaveLength(1);
    expectNative([fits]);
    const parts = formatReply(columnSource(ROWS_PER_PART + 1));
    expect(parts).toHaveLength(2);
    expect(bodyOf(parts[1] as string)).toHaveLength(1);
    expect(parts[1]?.split("\n").slice(1, 3)).toEqual(["| n |", "|---|"]);
    expectNative(parts);
  });

  test("paragraphs around a table count against the same 500 blocks: 150 paragraphs and a 399-row table", () => {
    const paragraphs = Array.from({ length: 150 }, (_, index) => `p${index}`).join("\n\n");
    const source = `${paragraphs}\n\n${columnSource(399)}`;
    // One part would be 551 blocks: the renderer refuses it.
    expect(() => renderRichMessage(source)).toThrow("551 blocks");
    const parts = formatReply(source);
    expect(parts.length).toBeGreaterThan(1);
    expectNative(parts);
    expect(rowsIn(parts, /^p\d+$/)).toEqual(Array.from({ length: 150 }, (_, index) => `p${index}`));
    expect(rowsIn(parts, /^\| \d \|$/)).toHaveLength(399);
  });

  test("list items cost two blocks: 100 bullets and a 399-row table", () => {
    const bullets = Array.from({ length: 100 }, (_, index) => `- item ${index}`).join("\n");
    const source = `${bullets}\n\n${columnSource(399)}`;
    expect(() => renderRichMessage(source)).toThrow("602 blocks");
    const parts = formatReply(source);
    expect(parts.length).toBeGreaterThan(1);
    expectNative(parts);
    expect(rowsIn(parts, /^- item \d+$/)).toHaveLength(100);
    expect(rowsIn(parts, /^\| \d \|$/)).toHaveLength(399);
  });

  test("ordered and nested lists, a quote and a fenced block count too, and a split fence stays balanced", () => {
    const lists = Array.from({ length: 70 }, (_, index) => `${index + 1}. step ${index}\n   - detail ${index}`).join("\n");
    const quote = Array.from({ length: 6 }, (_, index) => `> quoted ${index}`).join("\n");
    const code = ["```ts", ...Array.from({ length: 30 }, (_, index) => `const v${index} = ${index};`), "```"].join("\n");
    const source = [lists, quote, code, columnSource(399), "tail"].join("\n\n");
    expect(() => renderRichMessage(source)).toThrow("blocks, over the limit");
    const parts = formatReply(source);
    expect(parts.length).toBeGreaterThan(1);
    expectNative(parts);
    expect(rowsIn(parts, /^\| \d \|$/)).toHaveLength(399);
    expect(rowsIn(parts, /^\d+\. step \d+$/)).toHaveLength(70);
    expect(rowsIn(parts, /^const v\d+ = \d+;$/)).toHaveLength(30);
    for (const part of parts) {
      expect(part.split("\n").filter((line) => line.startsWith("```")).length % 2).toBe(0);
    }
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
  describe("a row larger than a message", () => {
    const wide = (cell: string): string => `| a | b |\n|---|---|\n| ${cell} | y |`;
    const bodies = (parts: readonly string[]): string[] => parts.map((part) => part.slice(part.indexOf("\n") + 1));

    for (const length of [4100, 5000, 9000]) {
      test(`a ${length}-character cell: stacked as "a: ..." lines, no header-only part, no character lost, nothing over 4096`, () => {
        const parts = formatReply(wide("x".repeat(length)));
        expect(parts.length).toBeGreaterThan(1);
        for (const part of parts) {
          expect(part.length).toBeLessThanOrEqual(4096);
          expect(renderedLength(part)).toBeLessThanOrEqual(4096);
          // The header row of the table is not a part of its own, nor repeated for the oversized row.
          expect(part).not.toContain("| a | b |");
          expect(part).not.toContain("|---|");
        }
        expect(parts[0]?.startsWith(`(1/${parts.length})\na: xxx`)).toBe(true);
        const text = bodies(parts).join("");
        expect(text.split("x").length - 1).toBe(length);
        expect(text.startsWith("a: ")).toBe(true);
        expect(text.endsWith("\nb: y")).toBe(true);
        // Only the one cell is cut: the last part holds the end of it and the next cell's line.
        expect(parts[parts.length - 1]?.endsWith("\nb: y")).toBe(true);
      });
    }

    test("a cell of words is cut at a space in the second half of the part, so no word is split", () => {
      const words = Array.from({ length: 900 }, (_, index) => `w${index}`);
      const parts = formatReply(wide(words.join(" ")));
      expect(parts.length).toBeGreaterThan(1);
      for (const part of parts) {
        expect(part.length).toBeLessThanOrEqual(4096);
      }
      const seen = bodies(parts)
        .join(" ")
        .split(/\s+/)
        .filter((word) => /^w\d+$/.test(word));
      expect(seen).toEqual(words);
    });

    test("rows around it stay a table: the header comes back for the next row that fits, and every part is a valid rich message", () => {
      const source = ["| a | b |", "|---|---|", "| 1 | one |", `| ${"z".repeat(5000)} | big |`, "| 2 | two |", "| 3 | three |"].join("\n");
      const parts = formatReply(source);
      expectNative(parts);
      const all = bodies(parts).join("\n");
      // The header is repeated for each run of rows that fit; rows are charged at the stacked layout's cost.
      expect(all.split("| a | b |").length - 1).toBeGreaterThanOrEqual(2);
      expect(rowsIn(parts, /^\| \d \| \w+ \|$/)).toEqual(["| 1 | one |", "| 2 | two |", "| 3 | three |"]);
      expect(all).toContain("b: big");
      expect(all.split("z").length - 1).toBe(5000);
      // The first table part holds the header and the row before it.
      expect(parts[0]?.startsWith("(1/")).toBe(true);
      expect(parts[0]).toContain("| 1 | one |");
      for (const part of parts) {
        expect(containsTable(part) || !part.includes("|")).toBe(true);
      }
    });

    test("a row that fits a message alone but not with the header is one stacked message, not a header with a cut row", () => {
      const note = "k".repeat(2900);
      const source = `| a | b |\n|---|---|\n| 1 | ${note} |`;
      // The header costs up to 1,500 units on top of the row, so 2,912 + 1,500 does not fit 4,096.
      const parts = formatReply(source);
      expect(parts).toEqual([`a: 1\nb: ${note}`]);
      expect(checkRichMessage(renderRichMessage(parts[0] as string))).toBeUndefined();
    });
  });
});
