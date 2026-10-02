// The rich renderer (flow 395; AC2, AC3): one message part to an `InputRichMessage` of typed
// blocks. Nothing a model writes becomes a block type or an attribute.

import { describe, expect, test } from "bun:test";
import { checkRichMessage } from "./fake-bot-api";
import { containsTable, htmlToRichText, renderRichMessage, RichRenderError } from "./format-rich";
import { RICH_LIMITS, type InputRichBlock } from "./rich-types";

function blocks(text: string): InputRichBlock[] {
  return renderRichMessage(text).blocks;
}

describe("renderRichMessage: tables (AC2)", () => {
  const TABLE = "| Name | Result | N |\n|:--|:-:|--:|\n| a | `ok` | 1 |\n| **b** | fail | 22 |";

  test("a table is one native table block, never raw pipes", () => {
    const [table] = blocks(TABLE);
    expect(table?.type).toBe("table");
    expect(JSON.stringify(table)).not.toContain("|");
    expect(blocks(TABLE)).toHaveLength(1);
  });

  test("the first row is the header and alignment comes from the separator row", () => {
    const table = blocks(TABLE)[0];
    if (table?.type !== "table") {
      throw new Error("not a table");
    }
    expect(table.is_bordered).toBe(true);
    expect(table.cells).toHaveLength(3);
    expect(table.cells[0]?.every((cell) => cell.is_header === true)).toBe(true);
    expect(table.cells[1]?.some((cell) => cell.is_header === true)).toBe(false);
    expect(table.cells[0]?.map((cell) => cell.align)).toEqual(["left", "center", "right"]);
  });

  test("inline markup in a cell becomes typed text", () => {
    const table = blocks(TABLE)[0];
    if (table?.type !== "table") {
      throw new Error("not a table");
    }
    expect(table.cells[1]?.[1]?.text).toEqual({ type: "code", text: "ok" });
    expect(table.cells[2]?.[0]?.text).toEqual({ type: "bold", text: "b" });
  });

  test("an empty cell has no text rather than an empty string", () => {
    const table = blocks("| a | b |\n|---|---|\n| 1 | |")[0];
    if (table?.type !== "table") {
      throw new Error("not a table");
    }
    expect(table.cells[1]?.[1]).not.toHaveProperty("text");
  });

  test("text around a table stays in its own blocks, in order", () => {
    const result = blocks(`before\n\n${TABLE}\n\nafter`);
    expect(result.map((block) => block.type)).toEqual(["paragraph", "table", "paragraph"]);
  });

  test("a table inside a fence is code, not a table", () => {
    const result = blocks("```\n| a | b |\n|---|---|\n| 1 | 2 |\n```");
    expect(result).toEqual([{ type: "pre", text: "| a | b |\n|---|---|\n| 1 | 2 |" }]);
    expect(containsTable("```\n| a | b |\n|---|---|\n```")).toBe(false);
  });

  test("containsTable decides what `auto` sends as rich", () => {
    expect(containsTable(TABLE)).toBe(true);
    expect(containsTable("a | b\nc | d")).toBe(false);
    expect(containsTable("plain text")).toBe(false);
  });
});

describe("renderRichMessage: lists, tasks and rules (AC3)", () => {
  test("an ordered list keeps its numbers", () => {
    const [list] = blocks("3. three\n4. four");
    expect(list).toEqual({
      type: "list",
      items: [
        { blocks: [{ type: "paragraph", text: "three" }], value: 3, type: "1" },
        { blocks: [{ type: "paragraph", text: "four" }], value: 4, type: "1" },
      ],
    });
  });

  test("a nested bullet nests under the item above it", () => {
    const [list] = blocks("1. one\n   - inner\n     - deeper\n2. two");
    if (list?.type !== "list") {
      throw new Error("not a list");
    }
    expect(list.items).toHaveLength(2);
    const nested = list.items[0]?.blocks[1];
    expect(nested?.type).toBe("list");
    if (nested?.type === "list") {
      expect(nested.items[0]?.blocks[0]).toEqual({ type: "paragraph", text: "inner" });
      expect(nested.items[0]?.blocks[1]?.type).toBe("list");
    }
  });

  test("task items carry a checkbox, ticked or not", () => {
    const [list] = blocks("- [ ] open\n- [x] done\n- [X] also done");
    if (list?.type !== "list") {
      throw new Error("not a list");
    }
    expect(list.items.map((item) => [item.has_checkbox, item.is_checked])).toEqual([
      [true, undefined],
      [true, true],
      [true, true],
    ]);
  });

  test("--- is a divider and a list entry that is a rule is not a bullet", () => {
    expect(blocks("above\n\n---\n\nbelow").map((block) => block.type)).toEqual(["paragraph", "divider", "paragraph"]);
    expect(blocks("- a\n---\n- b").map((block) => block.type)).toEqual(["list", "divider", "list"]);
  });

  test("a heading and a quote become blocks of their own", () => {
    expect(blocks("## Title")).toEqual([{ type: "heading", text: "Title", size: 3 }]);
    expect(blocks("> quoted")).toEqual([{ type: "blockquote", blocks: [{ type: "paragraph", text: "quoted" }] }]);
  });

  test("a long quote is collapsed, as in HTML mode", () => {
    const quote = Array.from({ length: 9 }, (_, i) => `> line ${i}`).join("\n");
    expect(blocks(quote)[0]?.type).toBe("expandable_blockquote");
  });

  test("a fenced block with a language is a pre block with that language", () => {
    expect(blocks("```ts\nconst a = 1;\n```")).toEqual([{ type: "pre", text: "const a = 1;", language: "ts" }]);
  });
});

describe("renderRichMessage: nothing the model writes becomes markup", () => {
  test("hostile text stays a string inside a typed node", () => {
    const [paragraph] = blocks('<script>alert(1)</script> <a href="x">y</a>');
    expect(paragraph).toEqual({ type: "paragraph", text: '<script>alert(1)</script> <a href="x">y</a>' });
  });

  test("inline markup maps to typed text, links only for https", () => {
    expect(htmlToRichText("a <b>b</b> <i>c</i> <s>d</s> <code>e</code>")).toEqual(["a ", { type: "bold", text: "b" }, " ", { type: "italic", text: "c" }, " ", { type: "strikethrough", text: "d" }, " ", { type: "code", text: "e" }]);
    expect(blocks("[docs](https://example.com/a?b=1&c=2)")[0]).toEqual({ type: "paragraph", text: { type: "url", text: "docs", url: "https://example.com/a?b=1&c=2" } });
    expect(blocks("[x](javascript:alert(1))")[0]).toEqual({ type: "paragraph", text: "[x](javascript:alert(1))" });
  });

  test("the message holds exactly one input field, blocks", () => {
    expect(Object.keys(renderRichMessage("# a\n\ntext"))).toEqual(["blocks"]);
  });

  test("what it renders passes the Bot API limits as the fake checks them", () => {
    const message = renderRichMessage("# t\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n1. x\n   - y\n\n- [x] z\n\n---\n\n> q");
    expect(checkRichMessage(message)).toBeUndefined();
  });
});

describe("renderRichMessage: limits", () => {
  test("nothing to send is an error the caller turns into HTML", () => {
    expect(() => renderRichMessage("\n\n")).toThrow(RichRenderError);
  });

  test("more than 500 blocks is refused here, not by Telegram", () => {
    const many = Array.from({ length: RICH_LIMITS.blocks + 1 }, (_, i) => `line ${i}`).join("\n");
    expect(() => renderRichMessage(many)).toThrow(RichRenderError);
    expect(renderRichMessage(Array.from({ length: RICH_LIMITS.blocks }, (_, i) => `line ${i}`).join("\n")).blocks).toHaveLength(RICH_LIMITS.blocks);
  });

  test("nesting beyond the documented levels is refused", () => {
    const deep = Array.from({ length: 12 }, (_, i) => `${"  ".repeat(i)}- level ${i}`).join("\n");
    expect(() => renderRichMessage(deep)).toThrow(RichRenderError);
  });
});
