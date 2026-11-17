// What a tool call acts on, made faithful for display: the approval dialog and the transcript row
// both read a call's input through these helpers, so neither can show it differently.

/**
 * Characters that reorder or hide text: bidi embeddings, overrides and isolates, zero-width and
 * other format characters, line/paragraph separators, and every C0/C1 control except \n and \t.
 */
const HIDDEN = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u180E\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF]/g;

/** Make every invisible or reordering character visible as an escape such as ⟨U+202E⟩. */
export function visibleText(s: string): string {
  return s.replace(HIDDEN, (ch) => `⟨U+${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}⟩`);
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

/** The one thing a call acts on: a command, path, URL or query. */
export function primaryInput(raw: unknown): PrimaryInput | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "string") return { label: "Input", value: visibleText(raw) };
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  for (const [k, label] of PRIMARY_KEYS) {
    const v = o[k];
    if (typeof v === "string") return { label, value: visibleText(v), key: k };
    if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string")) {
      return { label, value: visibleText(quoteArgv(v as string[])), key: k };
    }
  }
  return null;
}

export interface InputArg {
  /** The argument's name, display-safe; "" when the input is not an object. */
  key: string;
  /** Display-safe text: a string argument verbatim (real newlines), anything else as JSON. */
  text: string;
  json: boolean;
}

function toJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2) ?? String(v);
  } catch {
    return String(v);
  }
}

function arg(name: string, v: unknown): InputArg {
  const key = visibleText(name);
  return typeof v === "string" ? { key, text: visibleText(v), json: false } : { key, text: visibleText(toJson(v)), json: true };
}

/** Every argument the headline does not show, one per key; empty when the headline covers the whole input. */
export function restInput(raw: unknown): InputArg[] {
  if (raw === undefined || raw === null || typeof raw === "string") return [];
  if (typeof raw !== "object" || Array.isArray(raw)) return [arg("", raw)];
  const shown = primaryInput(raw)?.key;
  return Object.entries(raw as Record<string, unknown>)
    .filter(([k]) => k !== shown)
    .map(([k, v]) => arg(k, v));
}

/** The label above one argument's box: its name, or a generic one for a non-object input. */
export function argLabel(a: InputArg, headline: boolean): string {
  if (a.key) return a.key;
  return headline ? "Other arguments" : "Input";
}
