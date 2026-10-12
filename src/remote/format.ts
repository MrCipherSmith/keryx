// Telegram reply formatting (flow 376, block 4; AC13).
//
// One pure function, `formatReply`, turns a reply or a status text into the list
// of messages to send. The outbound queue calls it for every message, so nothing
// reaches the Bot API unsplit.
//
// Parse mode: HTML, applied AFTER splitting. This file works on the plain
// Markdown-ish text a model writes and never emits a tag; `renderTelegramHtml`
// (`format-html.ts`) turns each part into Telegram HTML at send time, and the
// outbound queue resends a part as plain text if Telegram refuses the markup.
// Telegram counts the 4096-unit limit after it has parsed the entities, so a
// rendered part is never longer than the plain part measured here. A fenced
// code block is kept whole (or closed and reopened) so each part holds balanced
// fences and renders as its own `<pre>`; a literal backtick run that is not a
// fence stays plain text and is escaped, never rendered as a half-open tag.
//
// Rules:
//   - A text that fits in one message is sent as is, with no part number.
//   - A longer text is cut at line breaks first, at a space inside a line next,
//     and only then (one unbroken run longer than a message) at the limit.
//   - A split inside a fenced block closes the fence at the end of the part and
//     reopens it, with its info string, at the start of the next.
//   - Parts are numbered "(1/3)" on their own first line, and only when split.
//   - Lengths are UTF-16 code units, which is what Telegram counts for the
//     limit; a surrogate pair (an emoji) is never cut in the middle. A multi-
//     codepoint emoji sequence inside one 4000-character unbroken run can still
//     be cut between its codepoints; ordinary text does not reach that path.
//   - Empty or whitespace-only input produces no message at all.
//   - A Markdown table is kept whole (flow 395): a split falls between rows, never inside
//     one (except a single cell larger than a message, see below), and the header and separator
//     rows are repeated at the top of the next part. Length
//     is counted as the text will be RENDERED, not as written: the aligned `<pre>` layout pads
//     every cell and a horizontal rule is drawn longer than `---`, so those are charged at their
//     rendered length and a part still fits the limit once Telegram has parsed it. The same
//     parts serve every rendering mode (the rich table block is never longer than the padded one).
//     A part that holds a table also stays within the 500 blocks of a rich message, counted for the
//     whole part (a table row is one block, a paragraph one, a list item two or three; see `Piece.blocks`),
//     so a tall table, or a table with text around it, is never refused as a native table.
//     A row that cannot share a part with the header (its rendered length, plus the header's, is over a
//     part) is written as stacked "Header: value" lines, the same form the text modes use for a long row,
//     and the header is not repeated for it; the next row that fits starts a table again. Only one
//     cell, or one stacked line, longer than a whole part is cut: at a space in the second half of the
//     part when there is one, at the limit otherwise. Neither cut is made where the rest of the line
//     would start with block syntax (`# `, `- `, `1. `, `>`, a fence), so a cell never turns into a
//     heading or a list item in the next part.

import { BULLET, ORDERED, QUOTE, RULE, RULE_LENGTH } from "./format-blocks";
import { stackedRowLines, type TableMatch, tableAt, tableCosts } from "./format-table";
import { RICH_LIMITS } from "./rich-types";
import { TELEGRAM_MAX_TEXT } from "./types";

/** Smallest limit the splitter accepts: room for a label, a fence and some text. */
const MIN_LIMIT = 64;
/** A fence marker longer than this is ordinary text, not a fence. */
const MAX_FENCE_MARKER = 16;
/** An info string longer than this is not repeated on the reopened fence. */
const MAX_FENCE_INFO = 40;
/**
 * Blocks one part may hold when it carries a table: the rich limit, less the "(i/n)" label paragraph
 * and the closing marker a split fence gets. Above it Telegram refuses the native table.
 */
const BLOCK_BUDGET = RICH_LIMITS.blocks - 2;

interface Fence {
  /** The backtick or tilde run, e.g. "```". */
  marker: string;
  /** The line written at the top of a part that continues the block. */
  header: string;
}

/** A table that is split across parts: what is repeated at the top of each continuation. */
interface TableRun {
  /** The header and separator source lines, newline kept. */
  headerSource: string;
  /** Rendered length of the header row. */
  headerCost: number;
}

interface Piece {
  text: string;
  /** The fence in force after this piece, if a block is open. */
  fence: Fence | undefined;
  /** Length once rendered; the text's own length unless it is a table row or a rule. */
  cost: number;
  /** Set on every piece of a table. */
  table?: TableRun;
  /**
   * Blocks of a rich message the piece adds, an upper bound (format-rich.ts counts them): a paragraph,
   * heading or divider is 1, a quote line 2, a list line 2 (3 when it may open a list), a table row 1,
   * the table with its header and first row 3, a fence 1 on its opening and closing lines, a blank line 0.
   */
  blocks: number;
}

const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** The marker and info string of a line that opens a fenced block, if it is one. */
export function fenceOpening(line: string): { marker: string; info: string } | undefined {
  const match = FENCE_LINE.exec(line);
  if (match === null) {
    return undefined;
  }
  const marker = match[1] as string;
  const info = (match[2] as string).trim();
  if (marker.length > MAX_FENCE_MARKER || (marker.startsWith("`") && info.includes("`"))) {
    return undefined;
  }
  return { marker, info };
}

function openingFence(line: string): Fence | undefined {
  const opening = fenceOpening(line);
  if (opening === undefined) {
    return undefined;
  }
  const { marker, info } = opening;
  return { marker, header: info.length > 0 && info.length <= MAX_FENCE_INFO ? `${marker}${info}` : marker };
}

/** Whether `line` closes the block opened with `fence` (same character, at least as long, nothing else). */
export function closesFence(line: string, fence: Pick<Fence, "marker">): boolean {
  const match = FENCE_LINE.exec(line);
  if (match === null) {
    return false;
  }
  const run = match[1] as string;
  return run[0] === fence.marker[0] && run.length >= fence.marker.length && (match[2] as string).trim().length === 0;
}

/** Characters a part spends on closing and on reopening the given fence. */
function fenceOverhead(fence: Fence | undefined): number {
  return fence === undefined ? 0 : fence.header.length + 1 + (fence.marker.length + 1);
}

// What opens a block when it is the first thing of a line: a heading, a list item, a quote, a fence, a rule.
const BLOCK_START = /[ \t]*(?:#{1,6}[ \t]|[-*][ \t]|\d{1,9}[.)][ \t]|>|`{3}|~{3}|-{3})/y;

/** Whether the text from `at` on opens a block (sticky: nothing is copied, a long line is not sliced per candidate cut). */
function startsBlock(text: string, at: number): boolean {
  BLOCK_START.lastIndex = at;
  return BLOCK_START.test(text);
}

/**
 * Cut `text` to at most `max` units, preferring the last space, never inside a surrogate pair. A space
 * at or before `minCut` is ignored, so a line that starts with a short label ("a: ...") is not cut
 * right after it. The rest of the line becomes the first line of the next part, so a cut is never made
 * where the rest would start with block syntax ("# ", "- ", "1. ", ">", a fence): a long cell or
 * paragraph that happens to carry ` # tail` must not turn into a heading in the second part.
 */
function cutAt(text: string, max: number, minCut = 0): number {
  if (text.length <= max) {
    return text.length;
  }
  for (let index = max; index > minCut; index -= 1) {
    const ch = text[index - 1] as string;
    if ((ch === " " || ch === "\t") && !startsBlock(text, index)) {
      return index;
    }
  }
  let cut = max;
  for (; cut > 1; cut -= 1) {
    const code = text.charCodeAt(cut - 1);
    const splitsPair = code >= 0xd800 && code <= 0xdbff;
    if (!splitsPair && !startsBlock(text, cut)) {
      break;
    }
  }
  return cut;
}

/** Pieces of one line, cut so that each fits `capacity`; `blocks` is what the first piece adds. */
function pushLine(
  pieces: Piece[],
  raw: string,
  line: string,
  before: Fence | undefined,
  fence: Fence | undefined,
  capacity: number,
  blocks: number,
  stacked = false,
): void {
  // The overhead of the fence the piece sits in (before) or opens (after).
  const room = Math.max(8, capacity - Math.max(fenceOverhead(before), fenceOverhead(fence)));
  const minCut = stacked ? Math.floor(room / 2) : 0;
  const inFence = before !== undefined || fence !== undefined;
  let weight = blocks;
  let rest = raw;
  while (rest.length > room) {
    const cut = cutAt(rest, room, minCut);
    pieces.push({ text: rest.slice(0, cut), fence: before ?? fence, cost: cut, blocks: weight });
    // A later piece of the line opens a part of its own: a paragraph, outside a fence.
    weight = inFence ? 0 : 1;
    rest = rest.slice(cut);
  }
  if (rest.length > 0) {
    const rule = before === undefined && fence === undefined && RULE.test(line);
    pieces.push({ text: rest, fence, cost: rule ? Math.max(rest.length, RULE_LENGTH + (rest.endsWith("\n") ? 1 : 0)) : rest.length, blocks: weight });
  }
}

const BLANK: Piece = { text: "\n", fence: undefined, cost: 1, blocks: 0 };

/**
 * The pieces of the table at `raws[at]`, or undefined when its header alone cannot fit a part (the
 * lines are then cut as plain text). A row whose rendered length plus the header's is over a part is
 * written as stacked "Header: value" lines instead: a table is never a header with a row cut in half.
 */
function tablePieces(found: TableMatch, raws: readonly string[], at: number, capacity: number): Piece[] | undefined {
  const { table } = found;
  const costs = tableCosts(table);
  const headerCost = costs.header;
  if (headerCost > capacity) {
    return undefined;
  }
  const headerSource = `${raws[at] as string}${raws[at + 1] as string}`;
  const run: TableRun = { headerSource, headerCost };
  if (table.rows.length === 0) {
    return [{ text: headerSource, fence: undefined, cost: headerCost, table: run, blocks: 2 }];
  }
  const pieces: Piece[] = [];
  let last: "table" | "stacked" | undefined;
  table.rows.forEach((cells, index) => {
    const source = raws[at + 2 + index] as string;
    const cost = costs.rows[index] as number;
    if (headerCost + cost <= capacity) {
      if (last === "table") {
        pieces.push({ text: source, fence: undefined, cost, table: run, blocks: 1 });
      } else {
        // The header, the separator and the row go together: a part is never only a header.
        if (last === "stacked") {
          pieces.push(BLANK);
        }
        pieces.push({ text: `${headerSource}${source}`, fence: undefined, cost: headerCost + cost, table: run, blocks: 3 });
      }
      last = "table";
      return;
    }
    if (last !== undefined) {
      pieces.push(BLANK);
    }
    for (const line of stackedRowLines(table, cells)) {
      pushLine(pieces, `${line}\n`, line, undefined, undefined, capacity, 1, true);
    }
    last = "stacked";
  });
  return pieces;
}

/** What a line outside a fence and a table adds to a rich message, and the list it belongs to. */
function lineBlocks(line: string, list: { indent: number; ordered: boolean } | undefined): { blocks: number; list: { indent: number; ordered: boolean } | undefined } {
  if (line.trim().length === 0) {
    return { blocks: 0, list: undefined };
  }
  if (QUOTE.test(line)) {
    return { blocks: 2, list: undefined };
  }
  if (!RULE.test(line)) {
    const bullet = BULLET.exec(line);
    const ordered = bullet === null ? ORDERED.exec(line) : null;
    const lead = bullet ?? ordered;
    if (lead !== null) {
      const entry = { indent: (lead[1] as string).replace(/\t/g, "    ").length, ordered: ordered !== null };
      // An item is 2 blocks (the item and its paragraph); the first of a run, or one that changes the
      // indentation or the kind of list, may open a list block as well.
      const same = list !== undefined && list.indent === entry.indent && list.ordered === entry.ordered;
      return { blocks: same ? 2 : 3, list: entry };
    }
  }
  return { blocks: 1, list: undefined };
}

/** Break the text into lines (newline kept) and break any line that cannot fit in one part. */
function toPieces(text: string, capacity: number): Piece[] {
  const pieces: Piece[] = [];
  const raws = text.split(/(?<=\n)/);
  const bare = raws.map((raw) => (raw.endsWith("\n") ? raw.slice(0, -1) : raw));
  let fence: Fence | undefined;
  let list: { indent: number; ordered: boolean } | undefined;
  for (let at = 0; at < raws.length; at += 1) {
    const raw = raws[at] as string;
    const line = bare[at] as string;
    const before = fence;
    if (fence === undefined) {
      fence = openingFence(line);
      if (fence === undefined) {
        const found = tableAt(bare, at);
        if (found !== undefined) {
          const tabled = tablePieces(found, raws, at, capacity);
          if (tabled !== undefined) {
            pieces.push(...tabled);
            list = undefined;
            at = found.end - 1;
            continue;
          }
        }
      }
    } else if (closesFence(line, fence)) {
      fence = undefined;
    }
    let blocks: number;
    if (before !== undefined || fence !== undefined) {
      // A fence is one block; the lines of a fence with nothing in it are a paragraph each.
      blocks = before === undefined || fence === undefined ? 1 : line.trim().length === 0 ? 1 : 0;
      list = undefined;
    } else {
      ({ blocks, list } = lineBlocks(line, list));
    }
    pushLine(pieces, raw, line, before, fence, capacity, blocks);
  }
  return pieces;
}

/**
 * The length of `text` as it will be rendered, counting a table row at its padded width and a
 * rule at its drawn width. Equal to `text.length` when the text has neither.
 */
export function renderedLength(text: string): number {
  return toPieces(text.replace(/\r\n?/g, "\n"), Number.POSITIVE_INFINITY).reduce((sum, piece) => sum + piece.cost, 0);
}

/** Whether `text` fits one part: short enough once rendered, and, with a table in it, few enough blocks for a rich message. */
function fitsOnePart(text: string, limit: number): boolean {
  let length = 0;
  let blocks = 0;
  let tabled = false;
  for (const piece of toPieces(text, Number.POSITIVE_INFINITY)) {
    length += piece.cost;
    blocks += piece.blocks;
    tabled ||= piece.table !== undefined;
  }
  return length <= limit && (!tabled || blocks <= BLOCK_BUDGET);
}

function pack(text: string, capacity: number): string[] {
  const parts: string[] = [];
  let current = "";
  let used = 0;
  let hasContent = false;
  let open: Fence | undefined;
  let lastTable: TableRun | undefined;
  /** Blocks of a rich message in the current part (see `Piece.blocks`), the repeated header and fence included. */
  let blocks = 0;
  /** Whether the current part holds a table, so that it may go out as a rich message. */
  let tabled = false;

  const finish = (next?: Piece): void => {
    let body = current.trimEnd();
    if (!hasContent || body.length === 0) {
      current = "";
      used = 0;
      blocks = 0;
      tabled = false;
      hasContent = false;
      return;
    }
    if (open !== undefined) {
      body += `\n${open.marker}`;
    }
    parts.push(body);
    current = open === undefined ? "" : `${open.header}\n`;
    used = open === undefined ? 0 : open.header.length + 1;
    // A reopened fence is a block of the next part.
    blocks = open === undefined ? 0 : 1;
    tabled = false;
    // A table that goes on in the next part starts it with its header again.
    if (open === undefined && next?.table !== undefined && next.table === lastTable) {
      current = next.table.headerSource;
      used = next.table.headerCost;
      blocks = 2;
      tabled = true;
    }
    hasContent = false;
  };

  for (const piece of toPieces(text, capacity)) {
    if (!hasContent && piece.text.trim().length === 0) {
      continue;
    }
    const closing = piece.fence === undefined ? 0 : piece.fence.marker.length + 1;
    if (hasContent && (used + piece.cost + closing > capacity || ((tabled || piece.table !== undefined) && blocks + piece.blocks > BLOCK_BUDGET))) {
      finish(piece);
      if (piece.text.trim().length === 0) {
        continue;
      }
    }
    current += piece.text;
    used += piece.cost;
    blocks += piece.blocks;
    tabled ||= piece.table !== undefined;
    hasContent = true;
    open = piece.fence;
    lastTable = piece.table;
  }
  finish();
  return parts;
}

/**
 * Split `text` into the messages to send. `[]` for blank input, one untouched
 * message when it fits, otherwise numbered parts that each fit in `limit`.
 */
export function formatReply(text: string, limit: number = TELEGRAM_MAX_TEXT): string[] {
  if (limit < MIN_LIMIT) {
    throw new RangeError(`formatReply: limit must be at least ${MIN_LIMIT}`);
  }
  // One line ending for the splitter and the renderer: fences are recognised on "\n" lines only.
  text = text.replace(/\r\n?/g, "\n");
  if (text.trim().length === 0) {
    return [];
  }
  if (fitsOnePart(text, limit)) {
    return [text];
  }
  // The label "(i/n)\n" takes 2d+4 units for d-digit numbers; try d = 1, 2, 3 until the count fits.
  for (let digits = 1; digits <= 3; digits += 1) {
    const labelLength = 2 * digits + 4;
    const parts = pack(text, limit - labelLength);
    if (String(parts.length).length > digits) {
      continue;
    }
    if (parts.length <= 1) {
      return parts;
    }
    return parts.map((part, index) => `(${index + 1}/${parts.length})\n${part}`);
  }
  // Beyond 999 parts: the queue's own bound would drop most of them anyway.
  const parts = pack(text, limit - 12).slice(0, 999);
  return parts.map((part, index) => `(${index + 1}/${parts.length})\n${part}`);
}
