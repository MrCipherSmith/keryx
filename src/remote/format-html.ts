// Telegram HTML for one message (flow 376; the Bot API 10.3 `parse_mode: "HTML"`).
//
// `formatReply` (format.ts) splits a reply on the plain Markdown-ish text a model
// writes. `renderTelegramHtml` then turns ONE already-split part into the HTML
// Telegram renders: bold, italic, strike, inline code, fenced blocks, quotes and
// https links. It is a pure function and the only place a tag is ever written.
//
// Rules the renderer keeps:
//   - Text outside the tags it generates is escaped: `&`, `<` and `>` become
//     `&amp;`, `&lt;` and `&gt;`. A tag that was not generated here cannot appear,
//     whatever the model wrote.
//   - Every tag is emitted together with its closing tag by the construct that
//     opened it, so the output is balanced by construction. Markup that does not
//     close, or that is ambiguous (`snake_case_name`, `a*b*c`, `5 * 3 * 2`, a
//     `**` with no partner), stays as escaped literal text.
//   - Nesting follows the Bot API: b, i, s and a nest (never the same tag inside
//     itself); `code` and `pre` hold only text; a link holds no code; a quote is
//     never nested.
//   - Telegram counts the 4096-unit limit AFTER it parses the entities. Markup
//     characters are only ever removed (`**`, a fence line, `# `) or swapped for
//     one character (`- ` becomes `• `), so a rendered part never parses to more
//     text than the plain part it came from. Two constructs lengthen their line:
//     a horizontal rule (`---` becomes a line of RULE_LENGTH glyphs) and a table
//     (cells are padded into columns). The splitter charges both at their rendered
//     length (format.ts), so a part from `formatReply` still fits after parsing.
//   - A link whose label reads as a web address for ANOTHER host gets that host written after it,
//     ` (→ evil.example)`, so the label cannot pass for the target (format-link.ts). Every other
//     link is exactly `<a href>label</a>`. Rich messages are built from this output, so they agree.
//   - A Markdown table becomes an aligned `<pre>` block (format-table.ts): HTML has
//     no table tag, so a monospace block is the only way the columns line up.
//     Task items (`- [ ]`, `- [x]`) show a box and a ticked box; a rule shows as a line.
//
// `sendHtml` is the one way a keryx text reaches `sendMessage`: it sends the
// rendered part with `parse_mode` HTML and, if Telegram answers 400 "can't parse
// entities", sends the original part once as plain text.

import { closesFence, fenceOpening } from "./format";
import { BULLET, CHECKED_BOX, HEADING, QUOTE, RULE, RULE_GLYPH, RULE_LENGTH, TASK, UNCHECKED_BOX } from "./format-blocks";
import { hostMarker } from "./format-link";
import { renderPlainText } from "./format-plain";
import { renderTableLines, tableAt, tableLayout } from "./format-table";
import { type BotApi, type InlineKeyboard, isBotApiError, type SendMessageParams } from "./types";

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttribute(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;");
}

export interface Context {
  bold: boolean;
  italic: boolean;
  strike: boolean;
  link: boolean;
}

export const OUTSIDE: Context = { bold: false, italic: false, strike: false, link: false };

const WORD = /[\p{L}\p{N}_]/u;
const ALNUM = /[\p{L}\p{N}]/u;
const SPACE = /\s/;
/** A single `*` or `_` does not open before these: `*.ts`, `_)`. */
const SINGLE_OPEN_BAD = /[.,;:!?)\]}/\\|]/;
/** A single `*` or `_` does not close after these: `lib/*`, `(*`. */
const SINGLE_CLOSE_BAD = /[([{/\\|]/;
const HTTP_URL = /^https?:\/\/[^\s<>"'`]+$/i;
const LANGUAGE = /^[A-Za-z0-9_+#.-]{1,32}$/;
/** A quote of at least this many lines is collapsed by Telegram until tapped. */
const EXPANDABLE_QUOTE_LINES = 8;

function isWord(char: string | undefined): boolean {
  return char !== undefined && WORD.test(char);
}

function isAlnum(char: string | undefined): boolean {
  return char !== undefined && ALNUM.test(char);
}

function isSpace(char: string | undefined): boolean {
  return char !== undefined && SPACE.test(char);
}

/** An inline code span starting at `start`: a backtick run closed by a run of the same length. */
function codeSpan(text: string, start: number): { content: string; end: number } | undefined {
  const run = backtickRun(text, start);
  let index = start + run;
  while (index < text.length) {
    if (text[index] === "`") {
      const next = backtickRun(text, index);
      if (next === run) {
        let content = text.slice(start + run, index);
        if (content.length > 2 && content.startsWith(" ") && content.endsWith(" ") && content.trim().length > 0) {
          content = content.slice(1, -1);
        }
        return content.length === 0 ? undefined : { content, end: index + run };
      }
      index += next;
    } else {
      index += 1;
    }
  }
  return undefined;
}

function backtickRun(text: string, start: number): number {
  let end = start;
  while (text[end] === "`") {
    end += 1;
  }
  return end - start;
}

function opens(text: string, index: number, marker: string): boolean {
  const next = text[index + marker.length];
  const prev = text[index - 1];
  if (next === undefined || isSpace(next) || prev === "/" || prev === "\\") {
    return false;
  }
  const char = marker[0] as string;
  if (marker.length === 1) {
    if (next === char || SINGLE_OPEN_BAD.test(next)) {
      return false;
    }
    return char === "*" ? !isAlnum(prev) : !isWord(prev);
  }
  return char === "_" ? !isWord(prev) : true;
}

function closes(text: string, index: number, marker: string): boolean {
  const prev = text[index - 1];
  const after = text[index + marker.length];
  const char = marker[0] as string;
  if (prev === undefined || isSpace(prev) || after === char) {
    return false;
  }
  if (marker.length === 1) {
    if (prev === char || SINGLE_CLOSE_BAD.test(prev)) {
      return false;
    }
    return char === "*" ? !isAlnum(after) : !isWord(after);
  }
  return char === "_" ? !isWord(after) : true;
}

/** The first position at or after `from` where `marker` closes, skipping code spans. -1 when none. */
function findCloser(text: string, from: number, marker: string): number {
  let index = from;
  while (index < text.length) {
    if (text[index] === "`") {
      const span = codeSpan(text, index);
      index = span === undefined ? index + backtickRun(text, index) : span.end;
      continue;
    }
    if (text.startsWith(marker, index) && closes(text, index, marker)) {
      return index;
    }
    index += 1;
  }
  return -1;
}

type Flag = "bold" | "italic" | "strike";
const TAGS: Record<Flag, string> = { bold: "b", italic: "i", strike: "s" };

function delimited(text: string, index: number, marker: string, flag: Flag, context: Context): { html: string; end: number } | undefined {
  if (!opens(text, index, marker)) {
    return undefined;
  }
  const close = findCloser(text, index + marker.length + 1, marker);
  if (close < 0) {
    return undefined;
  }
  const content = text.slice(index + marker.length, close);
  // `__init__` and `__name__` are identifiers, not emphasis: `__` needs more than one word.
  if (content.trim().length === 0 || (marker === "__" && !/\s/.test(content.trim()))) {
    return undefined;
  }
  const inner = renderInline(content, { ...context, [flag]: true });
  // Already inside this style (a heading is bold): the marker is dropped, the tag is not repeated.
  const html = context[flag] ? inner : `<${TAGS[flag]}>${inner}</${TAGS[flag]}>`;
  return { html, end: close + marker.length };
}

function link(text: string, index: number, context: Context): { html: string; end: number } | undefined {
  if (context.link) {
    return undefined;
  }
  const middle = text.indexOf("](", index + 1);
  if (middle < 0) {
    return undefined;
  }
  const label = text.slice(index + 1, middle);
  if (label.trim().length === 0 || label.includes("]")) {
    return undefined;
  }
  let depth = 1;
  let end = middle + 2;
  while (end < text.length && depth > 0) {
    if (text[end] === "(") {
      depth += 1;
    } else if (text[end] === ")") {
      depth -= 1;
    }
    end += 1;
  }
  if (depth !== 0) {
    return undefined;
  }
  const url = text.slice(middle + 2, end - 1);
  if (!HTTP_URL.test(url)) {
    return undefined;
  }
  // A label that reads as an address for a different host shows that host after the link (format-link.ts).
  const marker = escapeHtml(hostMarker(label, url));
  return { html: `<a href="${escapeAttribute(url)}">${renderInline(label, { ...context, link: true })}</a>${marker}`, end };
}

/** One line (or quote line) of running text. */
export function renderInline(text: string, context: Context): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index] as string;
    if (char === "`") {
      const span = context.link ? undefined : codeSpan(text, index);
      if (span === undefined) {
        const run = backtickRun(text, index);
        out += text.slice(index, index + run);
        index += run;
      } else {
        // Telegram forbids code inside b, i, s and a: inside emphasis the span is shown as plain text.
        out += context.bold || context.italic || context.strike ? escapeHtml(span.content) : `<code>${escapeHtml(span.content)}</code>`;
        index = span.end;
      }
      continue;
    }
    if (char === "[") {
      const found = link(text, index, context);
      if (found !== undefined) {
        out += found.html;
        index = found.end;
        continue;
      }
    } else if (text.startsWith("**", index) || text.startsWith("__", index) || text.startsWith("~~", index)) {
      const marker = text.slice(index, index + 2);
      const found = delimited(text, index, marker, marker === "~~" ? "strike" : "bold", context);
      if (found === undefined) {
        out += marker;
        index += 2;
      } else {
        out += found.html;
        index = found.end;
      }
      continue;
    } else if (char === "*" || char === "_") {
      const found = delimited(text, index, char, "italic", context);
      if (found !== undefined) {
        out += found.html;
        index = found.end;
        continue;
      }
    }
    out += escapeHtml(char);
    index += 1;
  }
  return out;
}


/**
 * The Telegram HTML for one message. Never throws; text with no markup comes back
 * escaped and otherwise unchanged.
 */
export function renderTelegramHtml(part: string): string {
  const lines = part.replace(/\r\n?/g, "\n").split("\n");
  let out = "";
  let first = true;
  let afterBlock = false;
  // Telegram starts a block entity (pre, quote) on its own line and ends the line with it,
  // so the newline that follows one in the source is not repeated.
  const push = (html: string, block: boolean): void => {
    if (!first && !afterBlock) {
      out += "\n";
    }
    out += html;
    first = false;
    afterBlock = block;
  };

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
        push(escapeHtml(lines.slice(index, closed ? cursor + 1 : cursor).join("\n")), false);
      } else {
        const language = fence.info.split(/\s+/)[0] as string;
        const open = LANGUAGE.test(language) ? `<pre><code class="language-${escapeAttribute(language)}">` : "<pre><code>";
        push(`${open}${escapeHtml(code)}</code></pre>`, true);
      }
      index = closed ? cursor + 1 : cursor;
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote !== null) {
      const quoted: string[] = [];
      while (index < lines.length) {
        const next = QUOTE.exec(lines[index] as string);
        if (next === null) {
          break;
        }
        quoted.push(next[1] ?? "");
        index += 1;
      }
      if (quoted.every((entry) => entry.trim().length === 0)) {
        push(escapeHtml(lines.slice(index - quoted.length, index).join("\n")), false);
      } else {
        const tag = quoted.length >= EXPANDABLE_QUOTE_LINES ? "blockquote expandable" : "blockquote";
        push(`<${tag}>${quoted.map((entry) => renderInline(entry, OUTSIDE)).join("\n")}</blockquote>`, true);
      }
      continue;
    }

    const found = tableAt(lines, index);
    if (found !== undefined) {
      // Aligned columns need a monospace block; a stacked table is running text and wraps as such.
      const text = escapeHtml(renderTableLines(found.table).join("\n"));
      push(tableLayout(found.table) === "aligned" ? `<pre>${text}</pre>` : text, true);
      index = found.end;
      continue;
    }

    index += 1;
    if (RULE.test(line)) {
      push(RULE_GLYPH.repeat(RULE_LENGTH), false);
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading !== null && (heading[1] as string).trim().length > 0) {
      push(`<b>${renderInline(heading[1] as string, { ...OUTSIDE, bold: true })}</b>`, false);
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet !== null) {
      const task = TASK.exec(bullet[2] as string);
      if (task !== null) {
        const box = task[1] === " " ? UNCHECKED_BOX : CHECKED_BOX;
        const label = renderInline(task[2] ?? "", OUTSIDE);
        push(`${bullet[1] as string}${box}${label.length > 0 ? ` ${label}` : ""}`, false);
        continue;
      }
      push(`${bullet[1] as string}• ${renderInline(bullet[2] as string, OUTSIDE)}`, false);
      continue;
    }
    push(renderInline(line, OUTSIDE), false);
  }
  return out;
}

// ---- checking Telegram HTML (the fake Bot API, and tests) ---------------------

export type HtmlCheck = { ok: true; text: string } | { ok: false; reason: string };

const SIMPLE_TAGS = new Set(["b", "strong", "i", "em", "u", "ins", "s", "strike", "del"]);
const TAG = /^<(\/?)([a-z][a-z-]*)((?:\s+[a-z-]+(?:="[^"<>]*")?)*)\s*>/i;
const ENTITY = /^&(?:amp|lt|gt|quot|#\d{1,7}|#x[0-9a-f]{1,6});/i;

function unescapeEntities(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|#\d{1,7}|#x[0-9a-f]{1,6});/gi, (_all, name: string) => {
    switch (name.toLowerCase()) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      default:
        return String.fromCodePoint(name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10));
    }
  });
}

/**
 * Parse `html` the way Telegram's `parse_mode: "HTML"` does, but strictly: only the
 * documented tags and attributes, balanced and correctly nested, `&` `<` `>` escaped.
 * On success `text` is what Telegram would show (the text its 4096 limit counts).
 */
export function checkTelegramHtml(html: string): HtmlCheck {
  const stack: { name: string }[] = [];
  let text = "";
  let index = 0;
  const fail = (reason: string): HtmlCheck => ({ ok: false, reason: `can't parse entities: ${reason} at byte offset ${index}` });
  while (index < html.length) {
    const char = html[index] as string;
    if (char === "&") {
      const entity = ENTITY.exec(html.slice(index, index + 12));
      if (entity === null) {
        return fail("unescaped &");
      }
      text += unescapeEntities(entity[0]);
      index += entity[0].length;
      continue;
    }
    if (char === ">") {
      return fail("unescaped >");
    }
    if (char !== "<") {
      text += char;
      index += 1;
      continue;
    }
    const match = TAG.exec(html.slice(index));
    if (match === null) {
      return fail("unsupported start tag");
    }
    const closing = match[1] === "/";
    const name = (match[2] as string).toLowerCase();
    const attributes = (match[3] as string).trim();
    const top = stack[stack.length - 1];
    if (closing) {
      if (attributes.length > 0 || top === undefined || top.name !== name) {
        return fail(`can't find start tag for </${name}>`);
      }
      stack.pop();
      index += match[0].length;
      continue;
    }
    const known = SIMPLE_TAGS.has(name) || ["a", "code", "pre", "span", "blockquote"].includes(name);
    if (!known) {
      return fail(`unsupported start tag "${name}"`);
    }
    if (stack.some((entry) => entry.name === "code") || (top?.name === "pre" && name !== "code")) {
      return fail(`<${name}> inside code or pre`);
    }
    if (name === "code" || name === "pre") {
      // Only a quote may hold code or pre, and a code directly in a pre.
      const holder = stack.find((entry) => entry.name !== "blockquote" && !(name === "code" && entry === top && entry.name === "pre"));
      if (holder !== undefined) {
        return fail(`<${name}> inside <${holder.name}>`);
      }
    }
    if (name === "pre" && stack.some((entry) => entry.name !== "blockquote")) {
      return fail("pre inside another entity");
    }
    if ((name === "blockquote" && stack.some((entry) => entry.name === "blockquote")) || (name === "a" && stack.some((entry) => entry.name === "a"))) {
      return fail(`<${name}> nested in itself`);
    }
    const attributeOk =
      (SIMPLE_TAGS.has(name) || name === "pre") ? attributes.length === 0
      : name === "a" ? /^href="[^"<>]+"$/.test(attributes)
      : name === "code" ? attributes.length === 0 || /^class="language-[A-Za-z0-9_+#.-]+"$/.test(attributes)
      : name === "span" ? attributes === 'class="tg-spoiler"'
      : attributes.length === 0 || attributes === "expandable";
    if (!attributeOk) {
      return fail(`bad attributes on <${name}>`);
    }
    stack.push({ name });
    index += match[0].length;
  }
  if (stack.length > 0) {
    return fail(`can't find end tag for <${(stack[stack.length - 1] as { name: string }).name}>`);
  }
  return { ok: true, text };
}

// ---- sending ---------------------------------------------------------------------

/** True for Telegram's refusal of the markup: 400 "Bad Request: can't parse entities ...". */
export function isEntityParseError(error: unknown): boolean {
  return isBotApiError(error) && error.kind === "rejected" && error.status === 400 && /can't parse entities/i.test(error.message);
}

/**
 * Send `params.text` (plain Markdown-ish text) as Telegram HTML. If Telegram
 * refuses the markup, `onFallback` is told and the original text goes out once
 * more with no parse mode (a table written as aligned lines, any other text as it is). Any other
 * failure is thrown as it is.
 */
export async function sendHtml(
  api: BotApi,
  params: SendMessageParams,
  onFallback?: (error: unknown) => void,
): Promise<{ message_id: number }> {
  const { parseMode: _ignored, ...plain } = params;
  try {
    return await api.sendMessage({ ...plain, text: renderTelegramHtml(params.text), parseMode: "HTML" });
  } catch (error) {
    if (!isEntityParseError(error)) {
      throw error;
    }
    try {
      onFallback?.(error);
    } catch {
      // A throwing observer must never cost the operator the message.
    }
    return api.sendMessage({ ...plain, text: renderPlainText(plain.text) });
  }
}

/**
 * Replace the text of a message the bot sent with `params.text` (plain Markdown-ish text)
 * rendered as Telegram HTML. No `inlineKeyboard` removes the buttons. If Telegram refuses the
 * markup, `onFallback` is told and the text is edited in once more with no parse mode. Any other
 * failure (including "message is not modified") is thrown as it is.
 */
export async function editHtml(
  api: BotApi,
  params: { chatId: number; messageId: number; text: string; inlineKeyboard?: InlineKeyboard },
  onFallback?: (error: unknown) => void,
): Promise<void> {
  try {
    await api.editMessageText({ ...params, text: renderTelegramHtml(params.text), parseMode: "HTML" });
  } catch (error) {
    if (!isEntityParseError(error)) {
      throw error;
    }
    try {
      onFallback?.(error);
    } catch {
      // A throwing observer must never cost the operator the edit.
    }
    await api.editMessageText({ ...params, text: renderPlainText(params.text) });
  }
}

/** Telegram refuses an edit that changes nothing; for a settle that is the state we wanted. */
export function isNotModified(error: unknown): boolean {
  return isBotApiError(error) && error.kind === "rejected" && /message is not modified/i.test(error.message);
}
