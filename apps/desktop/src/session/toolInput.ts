// What a tool call acts on, made faithful for display: the approval dialog and the transcript row
// both read a call's input through these helpers, so neither can show it differently.

/**
 * Characters that reorder, hide or blank out text: every control (Cc) and format (Cf) character —
 * bidi embeddings, overrides, isolates and marks, zero-width characters, soft hyphen, the tag
 * characters of the supplementary plane — plus line/paragraph separators, variation selectors and
 * the blank-rendering Hangul fillers. \n and \t stay real (they are let through by `escape`).
 */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u115F\u1160\u3164\uFFA0\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/gu;

/**
 * In prose (a question, an option, a title) ZWNJ and ZWJ shape ordinary Persian, Urdu and Indic
 * spelling and emoji sequences, and VS15/VS16 pick emoji presentation; none of them reorders text.
 */
const PROSE_KEEP = new Set(["\u200C", "\u200D", "\uFE0E", "\uFE0F"]);

function escapeChar(ch: string): string {
  return `⟨U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}⟩`;
}

/** Make every invisible or reordering character visible as an escape such as ⟨U+202E⟩. For what a call acts on. */
export function visibleText(s: string): string {
  return s.replace(HIDDEN, (ch) => (ch === "\n" || ch === "\t" ? ch : escapeChar(ch)));
}

/** A code block's text with hidden characters shown as escapes; `changed` says whether any were found (Trojan Source). */
export function revealHidden(s: string): { text: string; changed: boolean } {
  const text = visibleText(s);
  return { text, changed: text !== s };
}

/** visibleText for prose: also keeps the joiners and emoji selectors that change no order. */
export function visibleProse(s: string): string {
  return s.replace(HIDDEN, (ch) => (ch === "\n" || ch === "\t" || PROSE_KEEP.has(ch) ? ch : escapeChar(ch)));
}

/** Lines in a displayed value, for the "N lines" warning. */
export function lineCount(s: string): number {
  return s === "" ? 0 : s.split("\n").length;
}

/** An argv rendered so word boundaries survive: bare words stay bare, anything else is JSON-quoted. */
export function quoteArgv(argv: readonly string[]): string {
  return argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : JSON.stringify(a))).join(" ");
}

const PRIMARY_KEYS: Array<[string, string]> = [
  ["command", "Command"],
  ["cmd", "Command"],
  ["path", "Path"],
  ["file_path", "Path"],
  ["url", "URL"],
  ["query", "Query"],
  ["pattern", "Pattern"],
];

export interface PrimaryInput {
  label: string;
  /** Display-safe: hidden characters are escaped. */
  value: string;
  /** The field it came from; absent when the whole input is one string. */
  key?: string;
}

/** The field the headline comes from, without rendering anything. */
function primaryKey(o: Record<string, unknown>): [string, string] | null {
  for (const entry of PRIMARY_KEYS) {
    const v = o[entry[0]];
    if (typeof v === "string") return entry;
    if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string")) return entry;
  }
  return null;
}

/** The one thing a call acts on: a command, path, URL or query. */
export function primaryInput(raw: unknown): PrimaryInput | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "string") return { label: "Input", value: visibleText(raw) };
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const found = primaryKey(o);
  if (!found) return null;
  const [k, label] = found;
  const v = o[k];
  return { label, value: visibleText(typeof v === "string" ? v : quoteArgv(v as string[])), key: k };
}

export interface InputArg {
  /** Unique within one call's arguments (positional); an id for React keys and unread tracking, never shown. */
  id: string;
  /** The argument's name, display-safe; "" when the input is not an object. Two raw names may escape alike. */
  name: string;
  /** Display-safe text: a string argument verbatim (real newlines), anything else as JSON. */
  text: string;
}

function toJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2) ?? String(v);
  } catch {
    return String(v);
  }
}

function arg(index: number, name: string, v: unknown): InputArg {
  return { id: `arg-${index}`, name: visibleText(name), text: visibleText(typeof v === "string" ? v : toJson(v)) };
}

/** Every argument the headline does not show, one per key; empty when the headline covers the whole input. */
export function restArgs(raw: unknown): InputArg[] {
  if (raw === undefined || raw === null || typeof raw === "string") return [];
  if (typeof raw !== "object" || Array.isArray(raw)) return [arg(0, "", raw)];
  const o = raw as Record<string, unknown>;
  const shown = primaryKey(o)?.[0];
  return Object.entries(o)
    .filter(([k]) => k !== shown)
    .map(([k, v], i) => arg(i, k, v));
}

/** Whether restArgs would return anything, without serialising a single argument. */
export function hasRestArgs(raw: unknown): boolean {
  if (raw === undefined || raw === null || typeof raw === "string") return false;
  if (typeof raw !== "object" || Array.isArray(raw)) return true;
  const o = raw as Record<string, unknown>;
  const shown = primaryKey(o)?.[0];
  for (const k in o) if (Object.prototype.hasOwnProperty.call(o, k) && k !== shown) return true;
  return false;
}

/** The label above one argument's box: its name, or a generic one for a non-object input. */
export function argLabel(a: InputArg, headline: boolean): string {
  if (a.name) return a.name;
  return headline ? "Other arguments" : "Input";
}
