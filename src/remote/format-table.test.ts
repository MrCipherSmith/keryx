// Markdown tables on the way to Telegram (flow 395; AC2, AC6): recognised, laid out by display
// width, never sent as raw pipes, and split between rows with the header repeated.

import { describe, expect, test } from "bun:test";
import { formatReply, renderedLength } from "./format";
import { checkTelegramHtml, renderTelegramHtml } from "./format-html";
import { renderPlainText } from "./format-plain";
import { containsTable, renderRichMessage } from "./format-rich";
import { columnWidths, MAX_TABLE_COLUMNS, MAX_TABLE_ROW_COST, plainCell, renderedRowCost, renderTableText, splitRow, tableAt, tableLayout } from "./format-table";
import { visualWidth } from "../lib/md-blocks";

const TABLE = ["| Name | Result | N |", "|:-----|:------:|--:|", "| a | ok | 1 |", "| long name | **failed** | 22 |"].join("\n");

function parse(text: string) {
  const found = tableAt(text.split("\n"), 0);
  if (found === undefined) {
    throw new Error("not a table");
  }
  return found;
}

describe("splitRow", () => {
  test("drops decorative leading and trailing pipes and trims cells", () => {
    expect(splitRow("| a | b |")).toEqual(["a", "b"]);
    expect(splitRow("a | b")).toEqual(["a", "b"]);
  });

  test("an escaped pipe stays inside its cell", () => {
    expect(splitRow("| a \\| b | c |")).toEqual(["a | b", "c"]);
  });

  test("a line with no pipe is not a row", () => {
    expect(splitRow("just text")).toBeUndefined();
  });
});

describe("tableAt", () => {
  test("reads header, alignment and rows, and reports where the table ends", () => {
    const { table, end } = parse(`${TABLE}\n\nafter`);
    expect(table.header).toEqual(["Name", "Result", "N"]);
    expect(table.align).toEqual(["left", "center", "right"]);
    expect(table.rows).toEqual([
      ["a", "ok", "1"],
      ["long name", "**failed**", "22"],
    ]);
    expect(end).toBe(4);
  });

  test("a header without a separator row is not a table", () => {
    expect(tableAt(["| a | b |", "| c | d |"], 0)).toBeUndefined();
  });

  test("a separator with a different number of cells is not a table", () => {
    expect(tableAt(["| a | b |", "|---|---|---|"], 0)).toBeUndefined();
  });

  test("a short body row is padded and a long one cut to the header width", () => {
    const { table } = parse("| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |");
    expect(table.rows).toEqual([
      ["1", ""],
      ["1", "2"],
    ]);
  });

  test("more columns than a rich table takes stays text", () => {
    const cells = Array.from({ length: MAX_TABLE_COLUMNS + 1 }, (_, i) => `c${i}`);
    const header = `| ${cells.join(" | ")} |`;
    const separator = `|${cells.map(() => "---").join("|")}|`;
    expect(tableAt([header, separator, header], 0)).toBeUndefined();
  });

  test("a row too long to pad into aligned columns is still a table, laid out stacked", () => {
    const found = tableAt(["| a |", "|---|", `| ${"x".repeat(2000)} |`], 0);
    expect(found).toBeDefined();
    expect(tableLayout((found as NonNullable<typeof found>).table)).toBe("stacked");
    expect(tableLayout(parse(TABLE).table)).toBe("aligned");
  });
});

describe("aligned layout", () => {
  test("the separator row is dropped and columns line up by display width", () => {
    const text = renderTableText(parse(TABLE).table);
    const lines = text.split("\n");
    expect(lines).toHaveLength(3);
    expect(text).not.toContain("---");
    expect(text).not.toContain("|");
    // Every line puts the column gaps at the same display offsets.
    const offsets = (line: string): number[] => [...line].reduce<number[]>((found, char, index) => (char === "│" ? [...found, visualWidth(line.slice(0, index))] : found), []);
    expect(offsets(lines[0] as string)).toEqual(offsets(lines[1] as string));
    expect(offsets(lines[0] as string)).toEqual(offsets(lines[2] as string));
  });

  test("inline markers are removed from the visible cell and alignment is honoured", () => {
    const lines = renderTableText(parse(TABLE).table).split("\n");
    expect(lines[2]).toBe("long name │ failed │ 22");
    expect(lines[1]).toBe("a         │   ok   │  1");
  });

  test("CJK and emoji count by display width, not by code units", () => {
    const { table } = parse("| 名前 | x |\n|---|---|\n| ab | 😀 |");
    expect(columnWidths(table)).toEqual([4, 2]);
    const lines = renderTableText(table).split("\n");
    // The column gap sits at the same display offset in both rows (trailing space is trimmed).
    const gap = (line: string): number => visualWidth(line.slice(0, line.indexOf("│")));
    expect(gap(lines[0] as string)).toBe(gap(lines[1] as string));
    expect(gap(lines[0] as string)).toBe(5);
  });

  test("emoji of the transport, symbol and skin-tone kinds are two columns, so the gap stays aligned", () => {
    const html = renderTelegramHtml("| s | n |\n|---|---|\n| 🚀 | 1 |\n| ✅ | 2 |\n| ❌ | 3 |\n| 👍🏽 | 4 |\n| ok | 5 |");
    const lines = html.replace(/^<pre>|<\/pre>$/g, "").split("\n");
    // Exact text, not a comparison through visualWidth: each of these is two columns on screen.
    expect(lines).toEqual(["s  │ n", "🚀 │ 1", "✅ │ 2", "❌ │ 3", "👍🏽 │ 4", "ok │ 5"]);
  });

  test("a link cell shows its address so it is not lost", () => {
    expect(plainCell("[docs](https://example.com/a)")).toBe("docs (https://example.com/a)");
  });
});

describe("tables are never sent as raw pipes (AC2)", () => {
  test("HTML mode: an aligned <pre> block that passes the validator", () => {
    const html = renderTelegramHtml(TABLE);
    expect(html.startsWith("<pre>")).toBe(true);
    expect(html.endsWith("</pre>")).toBe(true);
    expect(html).not.toContain("|");
    expect(html).not.toContain("---");
    expect(checkTelegramHtml(html).ok).toBe(true);
  });

  test("HTML mode: markup in a cell is text inside <pre>, escaped, not a tag", () => {
    const html = renderTelegramHtml("| a | b |\n|---|---|\n| <script> | x & y |");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("x &amp; y");
    expect(checkTelegramHtml(html).ok).toBe(true);
  });

  test("plain mode: the same aligned layout without markup", () => {
    expect(renderPlainText(TABLE)).toBe(renderTableText(parse(TABLE).table));
  });

  test("a table inside a fenced block is code, left as written", () => {
    const html = renderTelegramHtml("```\n| a | b |\n|---|---|\n| 1 | 2 |\n```");
    expect(html).toContain("|---|---|");
  });

  test("text around a table keeps its own rendering", () => {
    const html = renderTelegramHtml(`before **bold**\n\n${TABLE}\n\nafter`);
    expect(html.startsWith("before <b>bold</b>")).toBe(true);
    expect(html.endsWith("after")).toBe(true);
    expect(checkTelegramHtml(html).ok).toBe(true);
  });
});

function bigTable(rows: number): string {
  return ["| id | value |", "|---|---|", ...Array.from({ length: rows }, (_, i) => `| row${i} | value number ${i} |`)].join("\n");
}

describe("splitting a table (AC6)", () => {
  const LIMIT = 400;

  test("every part is numbered, within the limit once rendered, and holds whole rows", () => {
    const parts = formatReply(bigTable(120), LIMIT);
    expect(parts.length).toBeGreaterThan(2);
    parts.forEach((part, index) => {
      expect(part.startsWith(`(${index + 1}/${parts.length})\n`)).toBe(true);
      expect(renderedLength(part)).toBeLessThanOrEqual(LIMIT);
      for (const line of part.split("\n").slice(1)) {
        // A row is whole when it has its closing pipe and as many cells as the header.
        expect(line.startsWith("|") && line.endsWith("|")).toBe(true);
        expect(line.split("|")).toHaveLength(4);
      }
    });
  });

  test("the header and separator rows repeat at the top of each following part", () => {
    const parts = formatReply(bigTable(120), LIMIT);
    for (const part of parts) {
      const lines = part.split("\n");
      expect(lines[1]).toBe("| id | value |");
      expect(lines[2]).toBe("|---|---|");
    }
  });

  test("no row is lost or repeated across the parts", () => {
    const parts = formatReply(bigTable(120), LIMIT);
    const rows = parts.flatMap((part) => part.split("\n").slice(3));
    expect(rows).toEqual(Array.from({ length: 120 }, (_, i) => `| row${i} | value number ${i} |`));
  });

  test("each part renders as a table of its own, never raw pipes", () => {
    for (const part of formatReply(bigTable(120), LIMIT)) {
      const html = renderTelegramHtml(part);
      expect(html).toContain("<pre>");
      expect(html).not.toContain("|");
      expect(checkTelegramHtml(html).ok).toBe(true);
    }
  });

  test("wide cells make the aligned layout longer than the source; the splitter charges for it", () => {
    const wide = ["| a | b |", "|---|---|", ...Array.from({ length: 60 }, (_, i) => `| ${i} | ${"w".repeat(i % 2 === 0 ? 3 : 60)} |`)].join("\n");
    for (const part of formatReply(wide, 500)) {
      expect(renderedLength(part)).toBeLessThanOrEqual(500);
    }
  });

  test("a table that fits goes out whole, with no part number", () => {
    expect(formatReply(TABLE)).toEqual([TABLE]);
  });
});

describe("renderedRowCost", () => {
  test("is at least the visible text and counts the newline and the column gaps", () => {
    const { table } = parse(TABLE);
    const widths = columnWidths(table);
    const cost = renderedRowCost(table.rows[1] as string[], widths);
    const rendered = renderTableText(table).split("\n")[2] as string;
    expect(cost).toBeGreaterThanOrEqual(rendered.length + 1);
  });
});

// A wide table: two 800-character cells in a 3-column table, and a 1-column table of one
// 1600-character cell. Padded to its column width every row would pass MAX_TABLE_ROW_COST.
const WIDE_3 = ["| a | b | c |", "|---|---|---|", `| ${"x".repeat(800)} | ${"y".repeat(800)} | z |`, "| 1 | 2 | 3 |"].join("\n");
const WIDE_1 = ["| note |", "|---|", `| ${"w".repeat(1600)} |`, "| short |"].join("\n");

describe("a wide table is never sent as raw pipes", () => {
  for (const [name, source] of [
    ["3 columns, two 800-character cells", WIDE_3],
    ["1 column, a 1600-character cell", WIDE_1],
  ] as const) {
    describe(name, () => {
      test("it is recognised as a table, and a stacked one", () => {
        const found = tableAt(source.split("\n"), 0);
        expect(found).toBeDefined();
        expect(renderedRowCost((found?.table.rows[0] ?? []) as string[], columnWidths((found as NonNullable<typeof found>).table))).toBeGreaterThan(MAX_TABLE_ROW_COST);
        expect(tableLayout((found as NonNullable<typeof found>).table)).toBe("stacked");
        expect(containsTable(source)).toBe(true);
      });

      test("auto mode would send it rich, as a native table block with every cell whole", () => {
        const [table] = renderRichMessage(source).blocks;
        expect(table?.type).toBe("table");
        expect(JSON.stringify(table)).toContain(source.includes("y".repeat(800)) ? "y".repeat(800) : "w".repeat(1600));
      });

      test("HTML mode: stacked key/value text with no pipes, no separator row and valid markup", () => {
        const html = renderTelegramHtml(source);
        expect(html).not.toContain("|");
        expect(html).not.toContain("---");
        expect(html).not.toContain("<pre>");
        expect(html).toMatch(/^(a|note): /);
        expect(html).toContain("\n\n");
        expect(checkTelegramHtml(html).ok).toBe(true);
      });

      test("plain mode: the same stacked lines", () => {
        const plain = renderPlainText(source);
        expect(plain).not.toContain("|");
        expect(plain).toMatch(/^(a|note): /);
      });

      test("splitting charges for the stacked layout, and every part renders with no raw pipes", () => {
        const many = [source, ...source.split("\n").slice(2)].join("\n");
        const parts = formatReply(many, 4096);
        expect(parts.length).toBeGreaterThan(1);
        for (const part of parts) {
          expect(renderedLength(part)).toBeLessThanOrEqual(4096);
          const html = renderTelegramHtml(part);
          expect(html).not.toContain("|");
          expect(html.length).toBeLessThanOrEqual(4096 + 200);
        }
      });
    });
  }

  test("a stacked row with empty cells leaves them out", () => {
    const html = renderTelegramHtml(["| a | b |", "|---|---|", `| ${"x".repeat(2000)} |  |`].join("\n"));
    expect(html).toBe(`a: ${"x".repeat(2000)}`);
  });
});
