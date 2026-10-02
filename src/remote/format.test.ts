// Reply formatting for Telegram (flow 376, block 4; AC13). Pure function, no network.

import { describe, expect, test } from "bun:test";
import { formatReply, renderedLength } from "./format";
import { renderPlainText } from "./format-plain";
import { checkTelegramHtml, renderTelegramHtml } from "./format-html";
import { renderRichMessage } from "./format-rich";
import { OutboundQueue } from "./outbound-queue";
import { FakeBotApi } from "./fake-bot-api";
import { makeRemoteDir } from "./remote.test-helpers";
import { rmSync } from "node:fs";
import { TELEGRAM_MAX_TEXT } from "./types";

const LIMIT = TELEGRAM_MAX_TEXT;

/** Strip the "(i/n)\n" label from each part and join what is left. */
function body(parts: string[], joiner = ""): string {
  return parts.map((p) => p.replace(/^\(\d+\/\d+\)\n/, "")).join(joiner);
}

/** No lone surrogate: every high surrogate is followed by a low one and vice versa. */
function wellFormed(text: string): boolean {
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
}

function fenceBalanced(part: string): boolean {
  const text = part.replace(/^\(\d+\/\d+\)\n/, "");
  const fences = text.split("\n").filter((line) => /^ {0,3}(`{3,}|~{3,})/.test(line)).length;
  return fences % 2 === 0;
}

describe("formatReply: when nothing is split", () => {
  test("empty and whitespace-only input produce no message", () => {
    expect(formatReply("")).toEqual([]);
    expect(formatReply("   \n\t \n")).toEqual([]);
  });

  test("text that fits is returned untouched, with no part number", () => {
    expect(formatReply("hello")).toEqual(["hello"]);
    const exact = "a".repeat(LIMIT);
    expect(formatReply(exact)).toEqual([exact]);
  });

  test("markup characters are left alone: no parse mode, nothing to escape", () => {
    const text = "snake_case *star* <tag> [link](x) `tick` & \\back";
    expect(formatReply(text)).toEqual([text]);
  });

  test("a limit too small to hold a label is refused", () => {
    expect(() => formatReply("x", 10)).toThrow(RangeError);
  });
});

describe("formatReply: long text", () => {
  test("splits at line breaks, numbers the parts and loses nothing", () => {
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i} ${"w".repeat(30)}`);
    const text = lines.join("\n");
    const parts = formatReply(text);
    expect(parts.length).toBeGreaterThan(1);
    parts.forEach((part, i) => {
      expect(part.startsWith(`(${i + 1}/${parts.length})\n`)).toBe(true);
      expect(part.length).toBeLessThanOrEqual(LIMIT);
      expect(part.trim().length).toBeGreaterThan(0);
    });
    // Every line survives whole, in order: a cut falls between lines.
    const rebuilt = body(parts, "\n").split("\n").filter((l) => l.length > 0);
    expect(rebuilt).toEqual(lines);
  });

  test("a long paragraph is cut at a space, never inside a word", () => {
    const words = Array.from({ length: 1200 }, (_, i) => `word${i}`);
    const parts = formatReply(words.join(" "));
    expect(parts.length).toBeGreaterThan(1);
    const rebuilt = body(parts, " ").split(/\s+/).filter((w) => w.length > 0);
    expect(rebuilt).toEqual(words);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(LIMIT);
    }
  });

  test("one 5000-character word is cut at the limit and every part fits", () => {
    const word = "z".repeat(5000);
    const parts = formatReply(word);
    expect(parts.length).toBe(2);
    expect(parts[0]?.startsWith("(1/2)\n")).toBe(true);
    expect(parts[1]?.startsWith("(2/2)\n")).toBe(true);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(LIMIT);
    }
    expect(body(parts)).toBe(word);
  });

  test("the part count grows to two digits and the label still fits", () => {
    const text = "q".repeat(LIMIT * 12);
    const parts = formatReply(text);
    expect(parts.length).toBeGreaterThanOrEqual(12);
    expect(parts[0]?.startsWith(`(1/${parts.length})\n`)).toBe(true);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(LIMIT);
    }
    expect(body(parts)).toBe(text);
  });

  test("a trailing blank run after the cut does not make an empty part", () => {
    const text = `${"a".repeat(LIMIT - 20)}\n${" \n".repeat(50)}`;
    const parts = formatReply(text);
    for (const part of parts) {
      expect(part.replace(/^\(\d+\/\d+\)\n/, "").trim().length).toBeGreaterThan(0);
    }
  });
});

describe("formatReply: code fences", () => {
  test("a block that crosses the limit is closed and reopened with its language", () => {
    const code = Array.from({ length: 300 }, (_, i) => `const value${i} = ${i};`);
    const text = `Here is the change:\n\n\`\`\`ts\n${code.join("\n")}\n\`\`\`\n\nThat is all.`;
    const parts = formatReply(text);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(LIMIT);
      expect(fenceBalanced(part)).toBe(true);
    }
    // The second part continues the block: it opens with the same fence.
    expect(parts[1]?.startsWith(`(2/${parts.length})\n\`\`\`ts\n`)).toBe(true);
    // The first part ends by closing the block it left open.
    expect(parts[0]?.endsWith("\n```")).toBe(true);
    // All the code lines are present, in order, none cut.
    const codeBack = parts.join("\n").split("\n").filter((l) => l.startsWith("const value"));
    expect(codeBack).toEqual(code);
    // The prose after the block is in the last part, outside any fence.
    expect(parts.at(-1)?.endsWith("That is all.")).toBe(true);
  });

  test("a block that fits inside one part is not touched", () => {
    const filler = "p".repeat(3000);
    const text = `${filler}\n\n\`\`\`sh\nls -la\n\`\`\`\n${"t ".repeat(600)}`;
    const parts = formatReply(text);
    for (const part of parts) {
      expect(fenceBalanced(part)).toBe(true);
    }
    expect(parts.join("\n")).toContain("```sh\nls -la\n```");
  });

  test("tilde fences and a longer backtick fence are tracked by their own marker", () => {
    const code = Array.from({ length: 400 }, (_, i) => `row ${i} ${"d".repeat(10)}`);
    const text = `\`\`\`\`md\n${code.join("\n")}\n\`\`\`\`\n`;
    const parts = formatReply(text);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts[1]?.includes("````md\n")).toBe(true);
    expect(parts[0]?.endsWith("\n````")).toBe(true);
    const tilde = formatReply(`~~~\n${code.join("\n")}\n~~~`);
    expect(tilde[1]?.includes("~~~\n")).toBe(true);
    expect(tilde[0]?.endsWith("\n~~~")).toBe(true);
  });

  test("a single line inside a fence that is longer than a part is cut and still fenced", () => {
    const text = `\`\`\`json\n${"k".repeat(9000)}\n\`\`\``;
    const parts = formatReply(text);
    expect(parts.length).toBeGreaterThanOrEqual(3);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(LIMIT);
      expect(fenceBalanced(part)).toBe(true);
    }
  });

  test("an unclosed fence is closed at the end of each part and the last part is left as written", () => {
    const text = `\`\`\`py\n${"x = 1\n".repeat(1500)}`;
    const parts = formatReply(text);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts.slice(0, -1)) {
      expect(part.endsWith("\n```")).toBe(true);
    }
  });
});

describe("formatReply: unicode", () => {
  test("lengths are UTF-16 code units: emoji count twice and are never cut in half", () => {
    // 3000 emoji = 6000 code units, no spaces, so the hard cut falls inside the run.
    const text = "😀".repeat(3000);
    const parts = formatReply(text);
    expect(parts.length).toBeGreaterThanOrEqual(2);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(LIMIT);
      const content = part.replace(/^\(\d+\/\d+\)\n/, "");
      // No lone surrogate: every code unit pairs up.
      expect(wellFormed(content)).toBe(true);
    }
    expect(body(parts)).toBe(text);
  });

  test("an emoji straddling the exact boundary moves whole to the next part", () => {
    // Label "(1/2)\n" is 6 units, so a part holds 4090. Fill 4089 units, then an emoji, then more.
    const text = `${"a".repeat(4089)}😀${"b".repeat(100)}`;
    const parts = formatReply(text);
    expect(parts.length).toBe(2);
    expect(parts[0]?.length).toBeLessThanOrEqual(LIMIT);
    for (const part of parts) {
      expect(wellFormed(part)).toBe(true);
    }
    expect(body(parts)).toBe(text);
    expect(parts[1]?.replace(/^\(\d+\/\d+\)\n/, "").startsWith("😀")).toBe(true);
  });

  test("text of exactly the limit in code units is one message even when it holds emoji", () => {
    const text = `${"😀".repeat(100)}${"a".repeat(LIMIT - 200)}`;
    expect(text.length).toBe(LIMIT);
    expect(formatReply(text)).toEqual([text]);
  });

  test("non-Latin text splits at spaces like any other", () => {
    const words = Array.from({ length: 1500 }, (_, i) => `слово${i}`);
    const parts = formatReply(words.join(" "));
    expect(body(parts, " ").split(/\s+/).filter((w) => w.length > 0)).toEqual(words);
  });
});

describe("the outbound queue sends what formatReply produces (the single outbound path)", () => {
  test("a long message becomes numbered entries, in order, with the keyboard on the last", () => {
    const dir = makeRemoteDir();
    try {
      const queue = new OutboundQueue({ api: new FakeBotApi(), dir, now: () => 1 });
      queue.load();
      const keyboard = [[{ text: "Yes", callback_data: "y" }]];
      const entries = queue.enqueue({ chatId: 1, threadId: 2, text: "w ".repeat(5000), keyboard });
      expect(entries.length).toBeGreaterThan(1);
      expect(entries.slice(0, -1).every((e) => e.keyboard === undefined)).toBe(true);
      expect(entries.at(-1)?.keyboard).toEqual(keyboard);
      expect(queue.pending().map((e) => e.id)).toEqual(entries.map((e) => e.id));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("blank text is never queued", () => {
    const dir = makeRemoteDir();
    try {
      const queue = new OutboundQueue({ api: new FakeBotApi(), dir, now: () => 1 });
      queue.load();
      expect(queue.enqueue({ chatId: 1, text: "  \n " })).toEqual([]);
      expect(queue.size).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("formatReply: tables and rules (flow 395, AC6)", () => {
  const table = (rows: number): string => ["| step | result |", "|:--|--:|", ...Array.from({ length: rows }, (_, i) => `| step ${i} | ${i % 2 === 0 ? "ok" : "failed"} |`)].join("\n");

  test("a table that fits goes out whole with no part number", () => {
    expect(formatReply(table(3))).toEqual([table(3)]);
  });

  test("a long table is numbered, falls between rows and repeats its header in every part", () => {
    const parts = formatReply(table(80), 300);
    expect(parts.length).toBeGreaterThan(2);
    parts.forEach((part, index) => {
      const lines = part.split("\n");
      expect(lines[0]).toBe(`(${index + 1}/${parts.length})`);
      expect(lines.slice(1, 3)).toEqual(["| step | result |", "|:--|--:|"]);
      for (const row of lines.slice(3)) {
        expect(row).toMatch(/^\| step \d+ \| (ok|failed) \|$/);
      }
    });
    expect(parts.flatMap((part) => part.split("\n").slice(3))).toHaveLength(80);
  });

  test("every part fits the limit once rendered, in HTML, plain text and rich mode", () => {
    for (const part of formatReply(table(80), 300)) {
      expect(renderedLength(part)).toBeLessThanOrEqual(300);
      const html = checkTelegramHtml(renderTelegramHtml(part));
      expect(html.ok && html.text.length <= 300).toBe(true);
      expect(renderPlainText(part).length).toBeLessThanOrEqual(300);
      expect(renderRichMessage(part).blocks.some((block) => block.type === "table")).toBe(true);
    }
  });

  test("a rule is charged at its drawn width so a part of rules still fits", () => {
    const rules = Array.from({ length: 200 }, () => "---").join("\n");
    const parts = formatReply(rules, 200);
    expect(parts.length).toBeGreaterThan(5);
    for (const part of parts) {
      expect(renderedLength(part)).toBeLessThanOrEqual(200);
      const html = checkTelegramHtml(renderTelegramHtml(part));
      expect(html.ok && html.text.length <= 200).toBe(true);
    }
  });

  test("the cost of text without a table or a rule is its own length", () => {
    expect(renderedLength("plain **text**\n- a\n1. b")).toBe("plain **text**\n- a\n1. b".length);
  });

  test("a fenced block that looks like a table is not split as one", () => {
    const code = ["```", "| a | b |", "|---|---|", ...Array.from({ length: 60 }, (_, i) => `| ${i} | x |`), "```"].join("\n");
    for (const part of formatReply(code, 200)) {
      expect(part.split("\n").filter((line) => line === "|---|---|").length).toBeLessThanOrEqual(1);
      expect(part.includes("```")).toBe(true);
    }
  });
});
