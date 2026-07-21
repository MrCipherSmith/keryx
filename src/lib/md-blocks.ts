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
