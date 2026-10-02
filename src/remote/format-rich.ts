// Telegram rich messages for one message part (flow 395; Bot API 10.3 `sendRichMessage`).
//
// `renderRichMessage` turns ONE already-split part (format.ts) into an `InputRichMessage` made of
// `blocks`: paragraphs, headings, preformatted blocks, dividers, lists, quotations and, above all,
// native tables. It reads the same Markdown-ish text as `renderTelegramHtml` and classifies lines
// with the same patterns (format-blocks.ts), and its inline text is the HTML renderer's own output
// read back into typed `RichText`, so bold, italic, strike, code spans and links mean exactly what
// they mean in HTML mode.
//
// Why `blocks` and not the `markdown` or `html` fields: rich Markdown accepts arbitrary HTML, so
// text from the model could add markup. A block list is data: nothing a model writes becomes a
// block type or an attribute. Text is only ever a string inside a typed node.
//
// Rules the renderer keeps:
//   - It never throws for text; it throws `RichRenderError` only when the part cannot be a rich
//     message under the documented limits (500 blocks, 16 nesting levels). The caller then sends
//     that part as HTML.
//   - A table becomes one `table` block (header cells flagged, alignment from the separator row),
//     never raw pipes.
//   - Ordered lists keep their numbers (`value`), nested lists keep their nesting, task items get a
//     checkbox, `---` is a divider.
//   - Each text line is its own paragraph: the Bot API does not say that a newline inside a
//     paragraph is kept, a paragraph per line is the layout that cannot lose a line break.

import { BULLET, HEADING, ORDERED, QUOTE, RULE, TASK } from "./format-blocks";
import { closesFence, fenceOpening } from "./format";
import { OUTSIDE, renderInline } from "./format-html";
import { tableAt } from "./format-table";
import {
  type InputRichBlock,
  type InputRichBlockListItem,
  type InputRichMessage,
  RICH_LIMITS,
  type RichBlockTableCell,
  type RichText,
} from "./rich-types";

export class RichRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RichRenderError";
  }
}

const LANGUAGE = /^[A-Za-z0-9_+#.-]{1,32}$/;
/** A quote of at least this many lines is collapsed by Telegram until tapped (as in HTML mode). */
const EXPANDABLE_QUOTE_LINES = 8;

// ---- inline text ---------------------------------------------------------------------

function unescape(text: string): string {
  return text.replace(/&(amp|lt|gt|quot);/g, (_all, name: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"' })[name] as string);
}

interface OpenNode {
  type: "bold" | "italic" | "strikethrough" | "code" | "url";
  url?: string;
  children: RichText[];
}

const TAG_TYPES: Record<string, OpenNode["type"]> = { b: "bold", i: "italic", s: "strikethrough", code: "code", a: "url" };

function collapse(children: RichText[]): RichText {
  const merged: RichText[] = [];
  for (const child of children) {
    const last = merged[merged.length - 1];
    if (typeof child === "string" && typeof last === "string") {
      merged[merged.length - 1] = last + child;
    } else {
      merged.push(child);
    }
  }
  if (merged.length === 0) {
    return "";
  }
  return merged.length === 1 ? (merged[0] as RichText) : merged;
}

/**
 * Read the HTML `renderInline` wrote (b, i, s, code, a, escaped text; nothing else) into `RichText`.
 * The renderer balances every tag it opens, so the stack is empty at the end.
 */
export function htmlToRichText(html: string): RichText {
  const root: OpenNode = { type: "bold", children: [] };
  const stack: OpenNode[] = [root];
  const token = /<(\/?)(b|i|s|code|a)(?: href="([^"]*)")?>|([^<]+)/g;
  for (let match = token.exec(html); match !== null; match = token.exec(html)) {
    const top = stack[stack.length - 1] as OpenNode;
    if (match[4] !== undefined) {
      top.children.push(unescape(match[4]));
    } else if (match[1] === "/") {
      const closed = stack.pop() as OpenNode;
      const text = collapse(closed.children);
      const node: RichText = closed.type === "url" ? { type: "url", text, url: closed.url as string } : { type: closed.type, text };
      (stack[stack.length - 1] as OpenNode).children.push(node);
    } else {
      stack.push({ type: TAG_TYPES[match[2] as string] as OpenNode["type"], ...(match[3] === undefined ? {} : { url: unescape(match[3]) }), children: [] });
    }
  }
  return collapse(root.children);
}

function inline(text: string): RichText {
  return htmlToRichText(renderInline(text, OUTSIDE));
}

function isEmpty(text: RichText): boolean {
  return text === "" || (Array.isArray(text) && text.length === 0);
}

// ---- lists ---------------------------------------------------------------------------

interface ListEntry {
  indent: number;
  ordered: boolean;
  number?: number;
  checkbox?: "open" | "done";
  text: string;
}

function indentOf(whitespace: string): number {
  return whitespace.replace(/\t/g, "    ").length;
}

function listEntry(line: string): ListEntry | undefined {
  const bullet = BULLET.exec(line);
  if (bullet !== null) {
    const task = TASK.exec(bullet[2] as string);
    return {
      indent: indentOf(bullet[1] as string),
      ordered: false,
      ...(task === null ? {} : { checkbox: task[1] === " " ? ("open" as const) : ("done" as const) }),
      text: task === null ? (bullet[2] as string) : (task[2] ?? ""),
    };
  }
  const ordered = ORDERED.exec(line);
  if (ordered !== null) {
    return { indent: indentOf(ordered[1] as string), ordered: true, number: Number.parseInt(ordered[2] as string, 10), text: ordered[4] as string };
  }
  return undefined;
}

function listItem(entry: ListEntry): InputRichBlockListItem {
  const text = inline(entry.text);
  return {
    blocks: [{ type: "paragraph", text: isEmpty(text) ? " " : text }],
    ...(entry.checkbox === undefined ? {} : { has_checkbox: true as const, ...(entry.checkbox === "done" ? { is_checked: true as const } : {}) }),
    ...(entry.ordered ? { value: entry.number as number, type: "1" as const } : {}),
  };
}

interface Frame {
  indent: number;
  ordered: boolean;
  items: InputRichBlockListItem[];
  parent: InputRichBlock[];
}

/** Lists from consecutive entries: deeper indentation nests under the item above. */
function buildLists(entries: readonly ListEntry[]): InputRichBlock[] {
  const root: InputRichBlock[] = [];
  const stack: Frame[] = [];
  for (const entry of entries) {
    while (stack.length > 0 && (stack[stack.length - 1] as Frame).indent > entry.indent) {
      stack.pop();
    }
    let top = stack[stack.length - 1];
    let parent: InputRichBlock[] | undefined;
    if (top !== undefined && top.indent === entry.indent && top.ordered !== entry.ordered) {
      // The kind of list changed at this level: a new list beside the old one.
      parent = top.parent;
      stack.pop();
      top = stack[stack.length - 1];
    }
    if (top === undefined || top.indent < entry.indent || parent !== undefined) {
      const holder = parent ?? (top === undefined ? root : (top.items[top.items.length - 1] as InputRichBlockListItem).blocks);
      const frame: Frame = { indent: entry.indent, ordered: entry.ordered, items: [], parent: holder };
      holder.push({ type: "list", items: frame.items });
      stack.push(frame);
      top = frame;
    }
    top.items.push(listItem(entry));
  }
  return root;
}

// ---- limits --------------------------------------------------------------------------

function countBlocks(blocks: readonly InputRichBlock[], depth: number): { count: number; depth: number } {
  let count = 0;
  let deepest = depth;
  for (const block of blocks) {
    count += 1;
    if (block.type === "list") {
      for (const item of block.items) {
        count += 1;
        const inner = countBlocks(item.blocks, depth + 2);
        count += inner.count;
        deepest = Math.max(deepest, inner.depth);
      }
    } else if (block.type === "blockquote") {
      const inner = countBlocks(block.blocks, depth + 1);
      count += inner.count;
      deepest = Math.max(deepest, inner.depth);
    } else if (block.type === "table") {
      count += block.cells.length;
    }
  }
  return { count, depth: deepest };
}

// ---- the part ------------------------------------------------------------------------

/** Whether `part` holds a Markdown table outside a fenced block: what `auto` mode sends as a rich message. */
export function containsTable(part: string): boolean {
  const lines = part.replace(/\r\n?/g, "\n").split("\n");
  let fence: ReturnType<typeof fenceOpening>;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (fence !== undefined) {
      if (closesFence(line, fence)) {
        fence = undefined;
      }
      continue;
    }
    fence = fenceOpening(line);
    if (fence === undefined && tableAt(lines, index) !== undefined) {
      return true;
    }
  }
  return false;
}

function tableBlock(table: { header: string[]; align: ("left" | "center" | "right")[]; rows: string[][] }): InputRichBlock {
  const cell = (text: string, column: number, header: boolean): RichBlockTableCell => {
    // A line break in a cell is a space, as in the HTML and plain layouts.
    const content = inline(text.replace(/<br\s*\/?>/gi, " ").trim());
    return {
      ...(isEmpty(content) ? {} : { text: content }),
      ...(header ? { is_header: true as const } : {}),
      align: table.align[column] as "left" | "center" | "right",
      valign: "top",
    };
  };
  return {
    type: "table",
    is_bordered: true,
    cells: [table.header.map((text, column) => cell(text, column, true)), ...table.rows.map((row) => row.map((text, column) => cell(text, column, false)))],
  };
}

/**
 * The rich message for one part. Throws `RichRenderError` only when the part exceeds a documented
 * limit of rich messages; the caller sends the part as HTML then.
 */
export function renderRichMessage(part: string): InputRichMessage {
  const lines = part.replace(/\r\n?/g, "\n").split("\n");
  const blocks: InputRichBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] as string;

    const fence = fenceOpening(line);
    if (fence !== undefined) {
      const body: string[] = [];
      let cursor = index + 1;
      while (cursor < lines.length && !closesFence(lines[cursor] as string, fence)) {
        body.push(lines[cursor] as string);
        cursor += 1;
      }
      const closed = cursor < lines.length;
      const code = body.join("\n");
      if (code.trim().length === 0) {
        for (const raw of lines.slice(index, closed ? cursor + 1 : cursor)) {
          blocks.push({ type: "paragraph", text: raw });
        }
      } else {
        const language = fence.info.split(/\s+/)[0] as string;
        blocks.push({ type: "pre", text: code, ...(LANGUAGE.test(language) ? { language } : {}) });
      }
      index = closed ? cursor + 1 : cursor;
      continue;
    }

    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      const start = index;
      while (index < lines.length) {
        const next = QUOTE.exec(lines[index] as string);
        if (next === null) {
          break;
        }
        quoted.push(next[1] ?? "");
        index += 1;
      }
      if (quoted.every((entry) => entry.trim().length === 0)) {
        for (const raw of lines.slice(start, index)) {
          blocks.push({ type: "paragraph", text: raw });
        }
      } else if (quoted.length >= EXPANDABLE_QUOTE_LINES) {
        const text: RichText[] = [];
        quoted.forEach((entry, position) => {
          if (position > 0) {
            text.push("\n");
          }
          text.push(inline(entry));
        });
        blocks.push({ type: "expandable_blockquote", text });
      } else {
        blocks.push({
          type: "blockquote",
          blocks: quoted.flatMap((entry): InputRichBlock[] => {
            const text = inline(entry);
            return isEmpty(text) ? [] : [{ type: "paragraph", text }];
          }),
        });
      }
      continue;
    }

    const found = tableAt(lines, index);
    if (found !== undefined) {
      blocks.push(tableBlock(found.table));
      index = found.end;
      continue;
    }

    if (listEntry(line) !== undefined && !RULE.test(line)) {
      const entries: ListEntry[] = [];
      while (index < lines.length) {
        const entry = listEntry(lines[index] as string);
        if (entry === undefined || RULE.test(lines[index] as string)) {
          break;
        }
        entries.push(entry);
        index += 1;
      }
      blocks.push(...buildLists(entries));
      continue;
    }

    index += 1;
    if (RULE.test(line)) {
      blocks.push({ type: "divider" });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading !== null && (heading[1] as string).trim().length > 0) {
      const level = (line.trimStart().match(/^#+/) as RegExpMatchArray)[0].length;
      blocks.push({ type: "heading", text: inline(heading[1] as string), size: Math.min(level + 1, 6) });
      continue;
    }
    const text = inline(line);
    if (!isEmpty(text) && line.trim().length > 0) {
      blocks.push({ type: "paragraph", text });
    }
  }

  const measured = countBlocks(blocks, 1);
  if (blocks.length === 0) {
    throw new RichRenderError("nothing to send as a rich message");
  }
  if (measured.count > RICH_LIMITS.blocks) {
    throw new RichRenderError(`${measured.count} blocks, over the limit of ${RICH_LIMITS.blocks}`);
  }
  if (measured.depth > RICH_LIMITS.nesting) {
    throw new RichRenderError(`${measured.depth} nesting levels, over the limit of ${RICH_LIMITS.nesting}`);
  }
  return { blocks };
}
