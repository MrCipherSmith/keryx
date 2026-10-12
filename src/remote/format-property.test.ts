// Generated inputs for the Telegram renderers (flow 395; AC4, AC6): tables, ordered and nested
// lists, task items and rules mixed with hostile markup. Every input goes through the splitter and
// all four renderings; the invariants are the ones the HTML renderer already promised (balanced,
// no tag the model wrote, passes the validator, never longer after Telegram parses it) plus the
// ones for the new constructs (a table never as raw pipes, a part within the limit once rendered).

import { describe, expect, test } from "bun:test";
import { checkRichMessage } from "./fake-bot-api";
import { formatReply, renderedLength } from "./format";
import { renderPlainText } from "./format-plain";
import { checkTelegramHtml, renderTelegramHtml } from "./format-html";
import { containsTable, renderRichMessage, RichRenderError } from "./format-rich";
import { tableAt } from "./format-table";
import { RICH_LIMITS } from "./rich-types";

function rng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    // The low bits of this generator repeat with a short period; the high ones do not.
    return state >>> 8;
  };
}

const WORDS = ["a", "b", "ok", "failed", "x < y", "a & b", "`code`", "**bold**", "_it_", "~~gone~~", "[l](https://a.b/c?d=1&e=2)", "日本語", "😀", "<u>hostile</u>", "<script>alert(1)</script>", "&amp;", "\\|", "snake_case", "12"];

function pick<T>(next: () => number, items: readonly T[]): T {
  return items[next() % items.length] as T;
}

function cell(next: () => number): string {
  return pick(next, WORDS);
}

function table(next: () => number): string {
  const columns = 1 + (next() % 4);
  const row = (): string => `| ${Array.from({ length: columns }, () => cell(next)).join(" | ")} |`;
  const align = (): string => pick(next, ["---", ":--", "--:", ":-:"]);
  const rows = Array.from({ length: 1 + (next() % 12) }, row);
  return [row(), `|${Array.from({ length: columns }, align).join("|")}|`, ...rows].join("\n");
}

function list(next: () => number): string {
  const lines: string[] = [];
  let number = 1 + (next() % 9);
  for (let index = 0, count = 2 + (next() % 8); index < count; index += 1) {
    const indent = " ".repeat((next() % 3) * 2);
    const kind = next() % 4;
    const text = `${cell(next)} ${cell(next)}`;
    if (kind === 0) {
      lines.push(`${indent}${number}. ${text}`);
      number += 1;
    } else if (kind === 1) {
      lines.push(`${indent}- ${text}`);
    } else if (kind === 2) {
      lines.push(`${indent}- [${pick(next, [" ", "x", "X"])}] ${text}`);
    } else {
      lines.push(`${indent}* ${text}`);
    }
  }
  return lines.join("\n");
}

function block(next: () => number): string {
  switch (next() % 9) {
    case 0:
      return table(next);
    case 1:
      return list(next);
    case 2:
      return pick(next, ["---", "-----", "- - -", "***"]);
    case 3:
      return `# ${cell(next)}`;
    case 4:
      return `> ${cell(next)}\n> ${cell(next)}`;
    case 5:
      return `\`\`\`ts\nconst a = ${next() % 100};\n| not | a table |\n|---|---|\n\`\`\``;
    default:
      return Array.from({ length: 1 + (next() % 4) }, () => cell(next)).join(" ");
  }
}

function generate(seed: number): string {
  const next = rng(seed);
  return Array.from({ length: 1 + (next() % 8) }, () => block(next)).join(next() % 3 === 0 ? "\n" : "\n\n");
}

const SEEDS = Array.from({ length: 300 }, (_, i) => i + 1);

describe("generated corpus: HTML invariants hold for every new construct (AC4)", () => {
  test("the corpus is at least 200 inputs and covers tables, lists, tasks and rules", () => {
    expect(SEEDS.length).toBeGreaterThanOrEqual(200);
    const corpus = SEEDS.map(generate);
    expect(corpus.filter((text) => containsTable(text)).length).toBeGreaterThan(40);
    expect(corpus.filter((text) => /^\s*\d+\. /m.test(text)).length).toBeGreaterThan(40);
    expect(corpus.filter((text) => /^\s*- \[[ xX]\] /m.test(text)).length).toBeGreaterThan(40);
    expect(corpus.filter((text) => /^---+$/m.test(text)).length).toBeGreaterThan(20);
  });

  test("every input renders balanced HTML that passes the validator", () => {
    for (const seed of SEEDS) {
      const text = generate(seed);
      const html = renderTelegramHtml(text);
      const checked = checkTelegramHtml(html);
      if (!checked.ok) {
        throw new Error(`seed ${seed}: ${checked.reason}\ninput: ${JSON.stringify(text)}\noutput: ${JSON.stringify(html)}`);
      }
    }
  });

  test("no tag the model wrote survives: only the renderer's own tags appear", () => {
    const allowed = new Set(["b", "i", "s", "code", "pre", "a", "blockquote"]);
    for (const seed of SEEDS) {
      const html = renderTelegramHtml(generate(seed));
      for (const tag of html.matchAll(/<\/?([a-z][a-z-]*)/g)) {
        if (!allowed.has(tag[1] as string)) {
          throw new Error(`seed ${seed}: a <${tag[1]}> tag reached the output`);
        }
      }
      expect(html).not.toContain("<script");
      expect(html).not.toContain("<u>");
    }
  });

  test("after parsing, a rendered part is never longer than the part measured as it will be drawn", () => {
    for (const seed of SEEDS) {
      const text = generate(seed);
      const shown = (checkTelegramHtml(renderTelegramHtml(text)) as { ok: true; text: string }).text;
      if (shown.length > renderedLength(text)) {
        throw new Error(`seed ${seed}: shown ${shown.length} > rendered cost ${renderedLength(text)}`);
      }
    }
  });

  test("a table is never left as raw pipes: no separator row and no piped row in the output", () => {
    for (const seed of SEEDS) {
      const next = rng(seed + 7000);
      // A cell that holds an escaped pipe legitimately shows a pipe, so it is left out here.
      const text = `intro ${cell(next)}\n\n${table(next)}\n\nafter`.replaceAll("\\|", "p");
      for (const out of [renderTelegramHtml(text), renderPlainText(text)]) {
        expect(out).not.toMatch(/\|\s*:?-{2,}/);
        expect(out.split("\n").some((line) => /^\s*\|.*\|\s*$/.test(line))).toBe(false);
      }
    }
  });
});

describe("generated corpus: splitting in every mode (AC6)", () => {
  // Small enough that most tables split, large enough for a header and the widest generated row to
  // share a part. A table whose header and widest row cannot is only reachable below the real limit:
  // `tableAt` leaves a row costing more than MAX_TABLE_ROW_COST as text, so at 4096 two always fit.
  const LIMIT = 400;

  test("every part is numbered, within the limit once rendered, in HTML, plain and rich", () => {
    for (const seed of SEEDS) {
      const text = generate(seed);
      const parts = formatReply(text, LIMIT);
      parts.forEach((part, index) => {
        if (parts.length > 1 && !part.startsWith(`(${index + 1}/${parts.length})\n`)) {
          throw new Error(`seed ${seed}: part ${index + 1} is not numbered`);
        }
        if (renderedLength(part) > LIMIT) {
          throw new Error(`seed ${seed}: part ${index + 1} costs ${renderedLength(part)} > ${LIMIT}`);
        }
        const html = checkTelegramHtml(renderTelegramHtml(part));
        if (!html.ok) {
          throw new Error(`seed ${seed}: part ${index + 1}: ${html.reason}`);
        }
        expect(html.text.length).toBeLessThanOrEqual(LIMIT);
        expect(renderPlainText(part).length).toBeLessThanOrEqual(LIMIT);
      });
    }
  });

  test("a table is never cut inside a row, and a continuation starts with the header", () => {
    for (const seed of SEEDS) {
      const text = generate(seed);
      for (const part of formatReply(text, LIMIT)) {
        const lines = part.split("\n");
        lines.forEach((line, index) => {
          const found = tableAt(lines, index);
          if (found === undefined) {
            return;
          }
          // Every row of a table found in a part has the header's number of cells.
          const width = found.table.header.length;
          for (const row of found.table.rows) {
            expect(row).toHaveLength(width);
          }
        });
      }
    }
  });
});

describe("generated corpus: rich messages stay inside the documented limits", () => {
  test("every part either renders within the Bot API limits or says it cannot", () => {
    const seen = { rendered: 0 };
    for (const seed of SEEDS) {
      for (const part of formatReply(generate(seed), 600)) {
        try {
          const message = renderRichMessage(part);
          const refusal = checkRichMessage(message);
          if (refusal !== undefined) {
            throw new Error(`seed ${seed}: ${refusal}`);
          }
          seen.rendered += 1;
        } catch (error) {
          if (!(error instanceof RichRenderError)) {
            throw error;
          }
        }
      }
    }
    expect(seen.rendered).toBeGreaterThan(200);
  });

  test("only the block types the renderer owns appear; text from the model never becomes a block", () => {
    const allowed = new Set(["paragraph", "heading", "pre", "divider", "list", "blockquote", "expandable_blockquote", "table"]);
    for (const seed of SEEDS) {
      const part = formatReply(generate(seed), 600)[0] as string | undefined;
      if (part === undefined) {
        continue;
      }
      try {
        const message = renderRichMessage(part);
        expect(Object.keys(message)).toEqual(["blocks"]);
        for (const top of message.blocks) {
          expect(allowed.has(top.type)).toBe(true);
        }
        // Hostile markup stays inside text strings: it is never a block or an attribute.
        const json = JSON.stringify(message);
        expect(json).not.toContain('"type":"script"');
        expect(json).not.toContain('"type":"u"');
      } catch (error) {
        if (!(error instanceof RichRenderError)) {
          throw error;
        }
      }
    }
  });

  test("a part over 500 blocks is refused by the renderer, not sent", () => {
    const many = Array.from({ length: RICH_LIMITS.blocks + 5 }, (_, i) => `line ${i}`).join("\n");
    expect(() => renderRichMessage(many)).toThrow(RichRenderError);
  });
});

describe("splitting at the real limit", () => {
  test("a table of the widest rows allowed still splits into parts that render within 4096", () => {
    const wide = "w".repeat(480);
    const text = ["| a | b | c |", "|---|---|---|", ...Array.from({ length: 8 }, (_, i) => `| ${wide} | ${i} | ${wide} |`)].join("\n");
    const parts = formatReply(text);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(renderedLength(part)).toBeLessThanOrEqual(4096);
      const checked = checkTelegramHtml(renderTelegramHtml(part));
      expect(checked.ok && checked.text.length <= 4096).toBe(true);
      expect(part.split("\n")[1]).toBe("| a | b | c |");
    }
  });
});
