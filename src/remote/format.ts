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
//     one, and the header and separator rows are repeated at the top of the next part. Length
//     is counted as the text will be RENDERED, not as written: the aligned `<pre>` layout pads
//     every cell and a horizontal rule is drawn longer than `---`, so those are charged at their
//     rendered length and a part still fits the limit once Telegram has parsed it. The same
//     parts serve every rendering mode (the rich table block is never longer than the padded one).

import { RULE, RULE_LENGTH } from "./format-blocks";
import { tableAt, tableCosts } from "./format-table";
import { TELEGRAM_MAX_TEXT } from "./types";

/** Smallest limit the splitter accepts: room for a label, a fence and some text. */
const MIN_LIMIT = 64;
/** A fence marker longer than this is ordinary text, not a fence. */
const MAX_FENCE_MARKER = 16;
/** An info string longer than this is not repeated on the reopened fence. */
const MAX_FENCE_INFO = 40;

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

/** Cut `text` to at most `max` units, preferring the last space, never inside a surrogate pair. */
function cutAt(text: string, max: number): number {
  if (text.length <= max) {
    return text.length;
  }
  for (let index = max; index > 0; index -= 1) {
    const ch = text[index - 1] as string;
    if (ch === " " || ch === "\t") {
      return index;
    }
  }
  const code = text.charCodeAt(max - 1);
  return code >= 0xd800 && code <= 0xdbff ? max - 1 : max;
}

/** Break the text into lines (newline kept) and break any line that cannot fit in one part. */
function toPieces(text: string, capacity: number): Piece[] {
  const pieces: Piece[] = [];
  const raws = text.split(/(?<=\n)/);
  const bare = raws.map((raw) => (raw.endsWith("\n") ? raw.slice(0, -1) : raw));
  let fence: Fence | undefined;
  for (let at = 0; at < raws.length; at += 1) {
    const raw = raws[at] as string;
    const line = bare[at] as string;
    const before = fence;
    if (fence === undefined) {
      fence = openingFence(line);
      if (fence === undefined) {
        const found = tableAt(bare, at);
        if (found !== undefined) {
          const costs = tableCosts(found.table);
          const headerCost = costs.header;
          const widest = Math.max(...costs.rows, 0);
          if (headerCost + widest <= capacity) {
            const run: TableRun = { headerSource: `${raw}${raws[at + 1] as string}`, headerCost };
            // The header, the separator and the first row go together: a part is never only a header.
            const rows = found.table.rows;
            const leadEnd = at + 2 + (rows.length > 0 ? 1 : 0);
            pieces.push({
              text: raws.slice(at, leadEnd).join(""),
              fence: undefined,
              cost: headerCost + (costs.rows[0] ?? 0),
              table: run,
            });
            for (let row = leadEnd; row < found.end; row += 1) {
              pieces.push({ text: raws[row] as string, fence: undefined, cost: costs.rows[row - at - 2] as number, table: run });
            }
            at = found.end - 1;
            continue;
          }
        }
      }
    } else if (closesFence(line, fence)) {
      fence = undefined;
    }
    // The overhead of the fence the piece sits in (before) or opens (after).
    const room = Math.max(8, capacity - Math.max(fenceOverhead(before), fenceOverhead(fence)));
    let rest = raw;
    while (rest.length > room) {
      const cut = cutAt(rest, room);
      pieces.push({ text: rest.slice(0, cut), fence: before ?? fence, cost: cut });
      rest = rest.slice(cut);
    }
    if (rest.length > 0) {
      const rule = before === undefined && fence === undefined && RULE.test(line);
      pieces.push({ text: rest, fence, cost: rule ? Math.max(rest.length, RULE_LENGTH + (rest.endsWith("\n") ? 1 : 0)) : rest.length });
    }
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

function pack(text: string, capacity: number): string[] {
  const parts: string[] = [];
  let current = "";
  let used = 0;
  let hasContent = false;
  let open: Fence | undefined;
  let lastTable: TableRun | undefined;

  const finish = (next?: Piece): void => {
    let body = current.trimEnd();
    if (!hasContent || body.length === 0) {
      current = "";
      used = 0;
      hasContent = false;
      return;
    }
    if (open !== undefined) {
      body += `\n${open.marker}`;
    }
    parts.push(body);
    current = open === undefined ? "" : `${open.header}\n`;
    used = open === undefined ? 0 : open.header.length + 1;
    // A table that goes on in the next part starts it with its header again.
    if (open === undefined && next?.table !== undefined && next.table === lastTable) {
      current = next.table.headerSource;
      used = next.table.headerCost;
    }
    hasContent = false;
  };

  for (const piece of toPieces(text, capacity)) {
    if (!hasContent && piece.text.trim().length === 0) {
      continue;
    }
    const closing = piece.fence === undefined ? 0 : piece.fence.marker.length + 1;
    if (hasContent && used + piece.cost + closing > capacity) {
      finish(piece);
      if (piece.text.trim().length === 0) {
        continue;
      }
    }
    current += piece.text;
    used += piece.cost;
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
  if (renderedLength(text) <= limit) {
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
