// Telegram reply formatting (flow 376, block 4; AC13).
//
// One pure function, `formatReply`, turns a reply or a status text into the list
// of messages to send. The outbound queue calls it for every message, so nothing
// reaches the Bot API unsplit.
//
// Parse mode: NONE. The Bot API client (`bot-api-http.ts`) sends no `parse_mode`,
// so Telegram shows the text exactly as written and there is nothing to escape:
// a stray `_`, `*` or `<` in a model reply cannot make Telegram refuse the
// message. A fenced code block therefore shows its backticks literally; it is
// still kept whole (or closed and reopened) so a block never starts in one
// message and silently ends in the next.
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

interface Piece {
  text: string;
  /** The fence in force after this piece, if a block is open. */
  fence: Fence | undefined;
}

const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

function openingFence(line: string): Fence | undefined {
  const match = FENCE_LINE.exec(line);
  if (match === null) {
    return undefined;
  }
  const marker = match[1] as string;
  const info = (match[2] as string).trim();
  if (marker.length > MAX_FENCE_MARKER || (marker.startsWith("`") && info.includes("`"))) {
    return undefined;
  }
  return { marker, header: info.length > 0 && info.length <= MAX_FENCE_INFO ? `${marker}${info}` : marker };
}

function closesFence(line: string, fence: Fence): boolean {
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
  let fence: Fence | undefined;
  for (const raw of text.split(/(?<=\n)/)) {
    const line = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
    const before = fence;
    if (fence === undefined) {
      fence = openingFence(line);
    } else if (closesFence(line, fence)) {
      fence = undefined;
    }
    // The overhead of the fence the piece sits in (before) or opens (after).
    const room = Math.max(8, capacity - Math.max(fenceOverhead(before), fenceOverhead(fence)));
    let rest = raw;
    while (rest.length > room) {
      const cut = cutAt(rest, room);
      pieces.push({ text: rest.slice(0, cut), fence: before ?? fence });
      rest = rest.slice(cut);
    }
    if (rest.length > 0) {
      pieces.push({ text: rest, fence });
    }
  }
  return pieces;
}

function pack(text: string, capacity: number): string[] {
  const parts: string[] = [];
  let current = "";
  let hasContent = false;
  let open: Fence | undefined;

  const finish = (): void => {
    let body = current.trimEnd();
    if (!hasContent || body.length === 0) {
      current = "";
      hasContent = false;
      return;
    }
    if (open !== undefined) {
      body += `\n${open.marker}`;
    }
    parts.push(body);
    current = open === undefined ? "" : `${open.header}\n`;
    hasContent = false;
  };

  for (const piece of toPieces(text, capacity)) {
    if (!hasContent && piece.text.trim().length === 0) {
      continue;
    }
    const closing = piece.fence === undefined ? 0 : piece.fence.marker.length + 1;
    if (hasContent && current.length + piece.text.length + closing > capacity) {
      finish();
      if (piece.text.trim().length === 0) {
        continue;
      }
    }
    current += piece.text;
    hasContent = true;
    open = piece.fence;
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
  if (text.trim().length === 0) {
    return [];
  }
  if (text.length <= limit) {
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
