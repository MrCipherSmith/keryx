// Pure markdown/diff block primitives shared by the readline renderer
// (`src/lib/ui.ts`) and the OpenTUI transcript (`src/tui/`). Deliberately free
// of IO, ANSI and any optional-dependency import — the TUI reaches its
// renderables through the injected `otui` handle — so this module stays
// unit-testable without a terminal and safe to import from either shell.

export type MdSegment = { kind: "text"; text: string } | { kind: "code"; lang: string; body: string };

export type DiffLineKind = "add" | "del" | "hunk" | "meta" | "context";

export type PayloadKind = "markdown" | "diff" | "code";

export type BlockLabelInput = { kind: string; lineCount: number; collapsed: boolean; hint?: string };

// A fence opens the line, allowing CommonMark's up-to-3 characters of leading
// indentation so a fence nested in a list item still opens a block (4+ would be
// an indented code block). `~~~` behaves exactly like ```` ``` ````. Inline
// backticks in prose therefore never open a block.
//
// The trailing `\r?` is load-bearing: JS treats CR as a line terminator, so with
// a CRLF payload (Windows tool output, a CRLF file read, a model emitting CRLF)
// `.` refuses to match the `\r` AND `$` refuses to match before it — without it
// `"```ts\r"` is not a fence and the whole payload degrades to raw prose.
const FENCE_LINE = /^[ \t]{0,3}(```|~~~)(.*)\r?$/;

// `@@ -a[,b] +c[,d] @@` — the only prefix strong enough to call a text a diff on
// its own. A bare `-`/`+` line is far more likely to be a markdown bullet.
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;

const MARKDOWN_LANGS = new Set(["md", "markdown", "prompt", "txt", "text"]);
const DIFF_LANGS = new Set(["diff", "patch"]);

/**
 * Drop the CR of a CRLF pair from an already-split line. Every line-oriented
 * helper here funnels through it so a CRLF payload behaves exactly like an LF
 * one and no stray CR survives into a rendered body (it would print as a control
 * character and desync the frame).
 */
export function stripTrailingCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/** Split on LF and normalize CRLF away. The line splitter for both shells. */
export function splitLines(text: string): string[] {
  return text.split("\n").map(stripTrailingCr);
}

/**
 * Fence marker + info-string language of `line`, or `undefined` when the line is
 * not a fence. The single source of truth for fence detection: `segmentMarkdown`,
 * the TUI stream segmenter and the TUI markdown chunker all go through it, so
 * the shells cannot disagree about what opens a code block. Only the first token
 * of the info string survives as `lang` (case preserved). Pure.
 */
export function fenceInfo(line: string): { marker: string; lang: string } | undefined {
  const match = FENCE_LINE.exec(line);
  if (match === null) {
    return undefined;
  }
  return { marker: match[1] ?? "", lang: (match[2] ?? "").trim().split(/\s+/)[0] ?? "" };
}

// Split markdown into text and fenced-code segments. Fence lines are dropped;
// only the first token of the info string survives as `lang` (case preserved).
// An unterminated fence — the normal case while a response is still streaming —
// yields a code segment carrying the partial body. CRLF input is normalized to
// LF, so segment bodies never carry a stray CR. Pure + deterministic.
export function segmentMarkdown(md: string): MdSegment[] {
  const segments: MdSegment[] = [];
  let text: string[] = [];
  let code: string[] | undefined; // defined only while inside a fence
  let lang = "";
  let marker = "";

  // Blank prose lines stay inside their text segment; a segment that would be
  // empty (fence at the very start / very end) is never emitted.
  const flushText = (): void => {
    const joined = text.join("\n");
    text = [];
    if (joined.length > 0) {
      segments.push({ kind: "text", text: joined });
    }
  };

  for (const line of splitLines(md)) {
    const fence = fenceInfo(line);
    if (code === undefined) {
      if (fence === undefined) {
        text.push(line);
        continue;
      }
      flushText();
      marker = fence.marker;
      lang = fence.lang;
      code = [];
      continue;
    }
    if (fence?.marker === marker) {
      segments.push({ kind: "code", lang, body: code.join("\n") });
      code = undefined;
      continue;
    }
    code.push(line);
  }

  if (code === undefined) {
    flushText();
  } else {
    segments.push({ kind: "code", lang, body: code.join("\n") });
  }
  return segments;
}

// Classify one unified-diff line for styling. File headers are checked before
// the `+`/`-` body lines so `--- a/x.ts` is meta, not a deletion.
export function classifyDiffLine(line: string): DiffLineKind {
  if (line.startsWith("@@")) {
    return "hunk";
  }
  if (line.startsWith("---") || line.startsWith("+++")) {
    return "meta";
  }
  if (line.startsWith("+")) {
    return "add";
  }
  if (line.startsWith("-")) {
    return "del";
  }
  return "context";
}

// Sniff whether unlabelled text is a unified diff. Requires a real hunk header
// or an adjacent `--- ` / `+++ ` file-header pair, so a markdown bullet list
// starting with `-` is never misdetected (AC7).
export function looksLikeUnifiedDiff(text: string): boolean {
  const lines = splitLines(text);
  for (const [index, line] of lines.entries()) {
    if (HUNK_HEADER.test(line)) {
      return true;
    }
    if (line.startsWith("--- ") && (lines[index + 1]?.startsWith("+++ ") ?? false)) {
      return true;
    }
  }
  return false;
}

// --- lightweight code tokenizer ---------------------------------------------
//
// A single-pass, per-line scanner — NOT a grammar. Flow 109 (D-2) ruled out the
// native `CodeRenderable`'s tree-sitter worker (it can fetch grammars over the
// network at render time, which the shell's worker-free/no-egress stance
// forbids). This stays a plain string scan: no worker, no network, no grammar
// file, so it composes with that decision instead of reopening it. It only
// recognizes comments, quoted strings, and a per-language keyword list — good
// enough to make a block readable at a glance, not a real lexer (nested
// template literals, regex literals and multi-line block comments are not
// tracked).

export type CodeTokenKind = "keyword" | "string" | "number" | "comment" | "plain";
export type CodeToken = { kind: CodeTokenKind; text: string };

const CODE_LANG_ALIASES: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  py3: "python",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  yml: "yaml",
  rb: "ruby",
  rs: "rust",
  kt: "kotlin",
  cs: "csharp",
  "c++": "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
};

const GENERIC_KEYWORDS = new Set([
  "if",
  "else",
  "for",
  "while",
  "return",
  "function",
  "class",
  "const",
  "let",
  "var",
  "import",
  "export",
  "from",
  "true",
  "false",
  "null",
  "new",
  "this",
  "try",
  "catch",
  "throw",
  "switch",
  "case",
  "break",
  "continue",
  "default",
  "static",
  "public",
  "private",
]);

const CODE_LANG_KEYWORDS: Record<string, ReadonlySet<string>> = {
  javascript: new Set([
    ...GENERIC_KEYWORDS,
    "async",
    "await",
    "yield",
    "typeof",
    "instanceof",
    "in",
    "of",
    "void",
    "undefined",
    "super",
    "extends",
    "finally",
    "do",
    "delete",
  ]),
  typescript: new Set([
    ...GENERIC_KEYWORDS,
    "async",
    "await",
    "yield",
    "typeof",
    "instanceof",
    "in",
    "of",
    "void",
    "undefined",
    "super",
    "extends",
    "implements",
    "interface",
    "type",
    "enum",
    "namespace",
    "declare",
    "readonly",
    "abstract",
    "as",
    "satisfies",
    "finally",
    "do",
    "delete",
  ]),
  python: new Set([
    "def",
    "return",
    "if",
    "elif",
    "else",
    "for",
    "while",
    "break",
    "continue",
    "class",
    "import",
    "from",
    "as",
    "try",
    "except",
    "finally",
    "raise",
    "with",
    "lambda",
    "yield",
    "pass",
    "None",
    "True",
    "False",
    "and",
    "or",
    "not",
    "in",
    "is",
    "global",
    "nonlocal",
    "assert",
    "async",
    "await",
    "del",
    "self",
  ]),
  bash: new Set([
    "if",
    "then",
    "else",
    "elif",
    "fi",
    "for",
    "while",
    "do",
    "done",
    "case",
    "esac",
    "function",
    "return",
    "local",
    "export",
    "exit",
    "break",
    "continue",
    "in",
    "select",
    "until",
  ]),
  go: new Set([
    "func",
    "return",
    "if",
    "else",
    "for",
    "range",
    "switch",
    "case",
    "default",
    "break",
    "continue",
    "package",
    "import",
    "var",
    "const",
    "type",
    "struct",
    "interface",
    "map",
    "chan",
    "go",
    "defer",
    "select",
    "fallthrough",
    "nil",
    "true",
    "false",
  ]),
  rust: new Set([
    "fn",
    "let",
    "mut",
    "return",
    "if",
    "else",
    "for",
    "while",
    "loop",
    "match",
    "struct",
    "enum",
    "impl",
    "trait",
    "pub",
    "use",
    "mod",
    "crate",
    "self",
    "Self",
    "super",
    "const",
    "static",
    "async",
    "await",
    "move",
    "ref",
    "dyn",
    "where",
    "unsafe",
    "true",
    "false",
    "None",
    "Some",
    "Ok",
    "Err",
  ]),
  json: new Set(["true", "false", "null"]),
};

/** `//` / `#` / `--` line-comment prefix for a normalized language, or "" if unknown. */
function codeCommentPrefix(normalizedLang: string): string {
  switch (normalizedLang) {
    case "javascript":
    case "typescript":
    case "go":
    case "rust":
    case "java":
    case "c":
    case "cpp":
    case "csharp":
    case "swift":
    case "kotlin":
    case "scala":
    case "php":
      return "//";
    case "python":
    case "bash":
    case "ruby":
    case "yaml":
    case "toml":
    case "r":
    case "perl":
      return "#";
    case "sql":
    case "lua":
    case "haskell":
      return "--";
    default:
      return "";
  }
}

/** Lowercase + alias a fence's info-string language for tokenizer lookups. */
function normalizeCodeLang(lang: string): string {
  const key = lang.trim().toLowerCase();
  return CODE_LANG_ALIASES[key] ?? key;
}

const CODE_WORD_OR_NUMBER = /[A-Za-z_$][A-Za-z0-9_$]*|\d+(?:\.\d+)?/g;

/** Split a comment/string-free segment into keyword/number/plain tokens. */
function tokenizeCodeWords(text: string, keywords: ReadonlySet<string>): CodeToken[] {
  const tokens: CodeToken[] = [];
  let last = 0;
  CODE_WORD_OR_NUMBER.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CODE_WORD_OR_NUMBER.exec(text)) !== null) {
    if (m.index > last) {
      tokens.push({ kind: "plain", text: text.slice(last, m.index) });
    }
    const word = m[0];
    if (/^[0-9]/.test(word)) {
      tokens.push({ kind: "number", text: word });
    } else if (keywords.has(word)) {
      tokens.push({ kind: "keyword", text: word });
    } else {
      tokens.push({ kind: "plain", text: word });
    }
    last = m.index + word.length;
  }
  if (last < text.length) {
    tokens.push({ kind: "plain", text: text.slice(last) });
  }
  return tokens;
}

/**
 * Tokenize one line of code for a fence's language: quoted strings and a
 * trailing line comment are pulled out first (a quote INSIDE a comment is not
 * re-scanned, and a comment marker inside a string is not treated as one),
 * then whatever code text remains is split into keyword/number/plain tokens.
 */
export function tokenizeCodeLine(line: string, lang: string): CodeToken[] {
  const normalized = normalizeCodeLang(lang);
  const keywords = CODE_LANG_KEYWORDS[normalized] ?? GENERIC_KEYWORDS;
  const commentPrefix = codeCommentPrefix(normalized);
  const tokens: CodeToken[] = [];
  let plainBuf = "";
  const flushPlain = (): void => {
    if (plainBuf.length > 0) {
      tokens.push(...tokenizeCodeWords(plainBuf, keywords));
      plainBuf = "";
    }
  };
  let i = 0;
  while (i < line.length) {
    if (commentPrefix.length > 0 && line.startsWith(commentPrefix, i)) {
      flushPlain();
      tokens.push({ kind: "comment", text: line.slice(i) });
      break;
    }
    const ch = line[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      flushPlain();
      let j = i + 1;
      while (j < line.length && line[j] !== ch) {
        j += line[j] === "\\" ? 2 : 1;
      }
      j = Math.min(j + 1, line.length);
      tokens.push({ kind: "string", text: line.slice(i, j) });
      i = j;
      continue;
    }
    plainBuf += ch;
    i += 1;
  }
  flushPlain();
  return tokens;
}

// Which frame a fenced segment gets, from its info string alone. `lineCount` is
// part of the contract (callers pass what they measured) but deliberately does
// not influence the mapping — a one-line diff is still a diff. Body sniffing via
// `looksLikeUnifiedDiff` is the caller's job, since the body is not passed here.
export function payloadKind(lang: string, _lineCount: number): PayloadKind {
  const normalized = lang.toLowerCase();
  if (MARKDOWN_LANGS.has(normalized)) {
    return "markdown";
  }
  if (DIFF_LANGS.has(normalized)) {
    return "diff";
  }
  return "code";
}

// The single source of truth for collapsible block headers
// (`▸ thought (14 lines) · ctrl+r`), shared by the TUI and readline shells so
// the two never drift. Plain text — the caller owns the styling.
export function blockLabel({ kind, lineCount, collapsed, hint }: BlockLabelInput): string {
  const marker = collapsed ? "▸" : "▾";
  const unit = lineCount === 1 ? "line" : "lines";
  const suffix = hint !== undefined && hint.length > 0 ? ` · ${hint}` : "";
  return `${marker} ${kind} (${lineCount} ${unit})${suffix}`;
}

/**
 * The transcript echo for a submitted composer line. A single line passes
 * through unchanged. Multi-line input (typed via Shift+Enter or pasted) keeps
 * the user's OWN first line instead of discarding it: a typed question in
 * front of a large paste used to vanish entirely behind a bare
 * `[pasted N lines]` placeholder, which is indistinguishable from "I said
 * nothing." The remaining lines still collapse to a count so a large paste
 * does not flood the transcript.
 */
export function summarizeSubmittedLine(line: string): string {
  const normalized = line.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const nonEmpty = normalized.split("\n").filter((linePart) => linePart.length > 0);
  if (nonEmpty.length <= 1) {
    return line;
  }
  const [first, ...rest] = nonEmpty;
  return `${first} [+ ${rest.length} pasted line${rest.length === 1 ? "" : "s"}]`;
}

// --- terminal width (flow 115) ---------------------------------------------
//
// A transcript box that must hug its content sets `maxWidth` — NOT
// `alignSelf: "flex-start"`, which stops the node measuring its intrinsic
// height, collapses it to the viewport and makes a bordered box paint its
// border rows over its content (see `src/capability/tui-layout.test.ts` for the
// measurements). `maxWidth` is clamped by the parent, so a value that is too
// large simply yields a full-width box and a value that is too small only costs
// extra wrapping — neither can corrupt the layout. That tolerance is why this
// width model is deliberately small instead of a full Unicode width table.

/** Combining marks and other zero-width code points. */
const ZERO_WIDTH = /^[̀-ͯ​-‏︀-️⁠-⁤]$/u;

/**
 * Ranges that terminals render two columns wide: CJK, Hangul, Kana, fullwidth
 * forms, and the emoji planes. Enough for the shell's payloads (prose, code,
 * tool output); anything exotic degrades to one column and costs a wrap.
 */
const WIDE_RANGES: readonly [number, number][] = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2e80, 0x303e], // CJK radicals, Kangxi, punctuation
  [0x3041, 0x33ff], // Kana, CJK compatibility
  [0x3400, 0x4dbf], // CJK ext A
  [0x4e00, 0x9fff], // CJK unified
  [0xa000, 0xa4cf], // Yi
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe30, 0xfe6f], // CJK compatibility forms
  [0xff00, 0xff60], // Fullwidth forms
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f], // emoji
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd], // CJK ext B+
];

function codePointWidth(cp: number): number {
  for (const [lo, hi] of WIDE_RANGES) {
    if (cp >= lo && cp <= hi) {
      return 2;
    }
  }
  return 1;
}

/**
 * Terminal columns `text` occupies: one per code point, two for the wide
 * ranges, zero for combining marks. Iterates code POINTS, so an astral glyph
 * counts once rather than twice for its surrogate pair.
 */
export function visualWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    if (ZERO_WIDTH.test(ch)) {
      continue;
    }
    width += codePointWidth(ch.codePointAt(0) ?? 0);
  }
  return width;
}

/**
 * The `maxWidth` a box needs to hug `text`: its widest line plus `chrome` —
 * the caller's own borders and horizontal padding (2 + 2 for a bordered box
 * with `paddingLeft: 1` / `paddingRight: 1`). A trailing newline is ignored so
 * it does not read as an empty last line.
 */
export function hugWidth(text: string, chrome: number): number {
  const lines = splitLines(text.replace(/\n+$/, ""));
  let widest = 0;
  for (const line of lines) {
    widest = Math.max(widest, visualWidth(line));
  }
  return widest + chrome;
}
