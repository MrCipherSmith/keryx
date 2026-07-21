import { afterEach, expect, test } from "bun:test";
import {
  collapseToolOutput,
  colorEnabled,
  indentBlock,
  renderDiff,
  renderMarkdown,
  roleLabel,
  style,
  summarizeToolArgs,
  symbols,
} from "./ui";

const savedNoColor = process.env.NO_COLOR;
const savedForceColor = process.env.FORCE_COLOR;
const ESC = "\x1b";

afterEach(() => {
  restore("NO_COLOR", savedNoColor);
  restore("FORCE_COLOR", savedForceColor);
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

test("NO_COLOR disables color even when FORCE_COLOR is set", () => {
  process.env.NO_COLOR = "1";
  process.env.FORCE_COLOR = "1";
  expect(colorEnabled()).toBe(false);
  expect(style.green("ok")).toBe("ok");
});

test("FORCE_COLOR emits ANSI escape codes wrapping the text", () => {
  delete process.env.NO_COLOR;
  process.env.FORCE_COLOR = "1";
  expect(colorEnabled()).toBe(true);
  const painted = style.cyan("hi");
  expect(painted).toContain("hi");
  expect(painted).toContain("[36m");
  expect(painted).toContain("[39m");
});

test("symbols are stable plain-text glyphs", () => {
  expect(symbols.ok).toBe("✓");
  expect(symbols.arrow).toBe("→");
});

// --- flow 031: renderMarkdown (pure, deterministic) ---

function forceColor(): void {
  delete process.env.NO_COLOR;
  process.env.FORCE_COLOR = "1";
}

test("renderMarkdown (NO_COLOR) returns the input unchanged with no escape codes", () => {
  process.env.NO_COLOR = "1";
  const md = "# Title\n\nSome **bold** and `code`\n\n- one\n- two\n\n```\ncode line\n```";
  const rendered = renderMarkdown(md);
  expect(rendered).toBe(md);
  expect(rendered).not.toContain("");
});

test("renderMarkdown (FORCE_COLOR) styles a heading and strips the marker", () => {
  forceColor();
  const rendered = renderMarkdown("# Hello");
  expect(rendered).toContain("Hello");
  expect(rendered).not.toContain("#");
  expect(rendered).toContain("[36m"); // cyan
  expect(rendered).toContain("[1m"); // bold
});

test("renderMarkdown (FORCE_COLOR) styles inline bold and code spans", () => {
  forceColor();
  const rendered = renderMarkdown("a **b** and `c` here");
  expect(rendered).toContain("[1m"); // bold wrapping "b"
  expect(rendered).toContain("[90m"); // gray wrapping "c"
  expect(rendered).not.toContain("**");
  expect(rendered).not.toContain("`");
  expect(rendered).toContain("b");
  expect(rendered).toContain("c");
});

test("renderMarkdown (FORCE_COLOR) renders a bullet list with the bullet glyph", () => {
  forceColor();
  const rendered = renderMarkdown("- alpha\n- beta");
  const lines = rendered.split("\n");
  expect(lines).toHaveLength(2);
  for (const line of lines) {
    expect(line).toContain(symbols.bullet);
  }
  expect(rendered).toContain("alpha");
  expect(rendered).toContain("beta");
  expect(rendered).not.toMatch(/^- /m);
});

test("renderMarkdown (FORCE_COLOR) dims fenced code block lines and drops the fences", () => {
  forceColor();
  const rendered = renderMarkdown("```\nconst x = 1;\n```");
  expect(rendered).toContain("const x = 1;");
  expect(rendered).not.toContain("```");
  expect(rendered).toContain("[90m"); // gray/dim code line
});

// --- flow 109: fence-aware renderMarkdown + renderDiff (pure) ---

test("renderMarkdown (FORCE_COLOR) emits the fence language tag above the dimmed body", () => {
  forceColor();
  const rendered = renderMarkdown("```ts\nconst x = 1;\n```");
  const lines = rendered.split("\n");
  expect(lines).toHaveLength(2);
  expect(lines[0]).toContain("ts"); // info string is no longer discarded
  expect(lines[0]).toContain(`${ESC}[2m`); // dim language tag
  expect(lines[1]).toContain("const x = 1;");
  expect(lines[1]).toContain(`${ESC}[90m`);
  expect(rendered).not.toContain("```");
});

test("renderMarkdown (FORCE_COLOR) treats a ~~~ fence like a ``` fence", () => {
  forceColor();
  const rendered = renderMarkdown("~~~py\nprint(1)\n~~~");
  expect(rendered).not.toContain("~~~");
  expect(rendered).toContain("py");
  expect(rendered).toContain("print(1)");
});

test("renderMarkdown (FORCE_COLOR) colorizes a diff fence instead of flatly dimming it", () => {
  forceColor();
  const rendered = renderMarkdown("```diff\n@@ -1 +1 @@\n-old\n+new\n```");
  expect(rendered).toContain(`${ESC}[36m@@ -1 +1 @@`); // cyan hunk header
  expect(rendered).toContain(`${ESC}[31m-old`); // red deletion
  expect(rendered).toContain(`${ESC}[32m+new`); // green addition
  expect(rendered).not.toContain(`${ESC}[90m`); // body is not gray-dimmed
});

test("renderMarkdown (AC7) does not colorize a bullet list inside a fence as a diff", () => {
  forceColor();
  const rendered = renderMarkdown("```\n- one\n- two\n```");
  expect(rendered).not.toContain(`${ESC}[31m`); // "- one" is not a deletion
  expect(rendered).toContain(`${ESC}[90m`); // plain dimmed code body
});

test("renderMarkdown (FORCE_COLOR) segments a CRLF fence exactly like an LF one", () => {
  forceColor();
  // Regression (T6/F1): the fence regex used to reject `"```ts\r"`, so a CRLF
  // payload rendered the raw fence markers as prose with no language tag.
  const rendered = renderMarkdown("intro\r\n```ts\r\nconst x = 1;\r\n```\r\ntail");
  expect(rendered).toBe(renderMarkdown("intro\n```ts\nconst x = 1;\n```\ntail"));
  expect(rendered).not.toContain("```");
  expect(rendered).not.toContain("\r");
  expect(rendered).toContain("ts"); // language tag survived
  expect(rendered).toContain("const x = 1;");
});

test("renderDiff (FORCE_COLOR) colorizes a CRLF diff and drops the stray CR", () => {
  forceColor();
  const rendered = renderDiff("@@ -1 +1 @@\r\n-old\r\n+new");
  expect(rendered).not.toContain("\r");
  expect(rendered).toContain(`${ESC}[36m@@ -1 +1 @@`);
  expect(rendered).toContain(`${ESC}[31m-old`);
  expect(rendered).toContain(`${ESC}[32m+new`);
});

test("renderDiff (NO_COLOR) returns the input unchanged with no escape codes", () => {
  process.env.NO_COLOR = "1";
  const diff = "--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n context";
  const rendered = renderDiff(diff);
  expect(rendered).toBe(diff);
  expect(rendered).not.toContain(ESC);
});

test("renderDiff (FORCE_COLOR) styles add/del/hunk/meta lines and leaves context plain", () => {
  forceColor();
  const lines = renderDiff("--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n context").split("\n");
  expect(lines[0]).toContain(`${ESC}[2m`); // dim file header
  expect(lines[1]).toContain(`${ESC}[2m`);
  expect(lines[2]).toContain(`${ESC}[36m`); // cyan hunk header
  expect(lines[3]).toContain(`${ESC}[31m`); // red deletion
  expect(lines[4]).toContain(`${ESC}[32m`); // green addition
  expect(lines[5]).toBe(" context"); // untouched context line stays plain
});

// --- flow 055: collapseToolOutput (pure) ---

test("collapseToolOutput: single line → no hidden lines", () => {
  expect(collapseToolOutput("only line")).toEqual({ summary: "only line", lineCount: 1, hidden: 0 });
});

test("collapseToolOutput: multi-line → first line summary + hidden count", () => {
  const r = collapseToolOutput("first\nsecond\nthird");
  expect(r.summary).toBe("first");
  expect(r.lineCount).toBe(3);
  expect(r.hidden).toBe(2);
});

test("collapseToolOutput: trailing blank lines are ignored", () => {
  expect(collapseToolOutput("a\n\n\n")).toEqual({ summary: "a", lineCount: 1, hidden: 0 });
});

test("collapseToolOutput: skips leading empty lines for the summary", () => {
  const r = collapseToolOutput("\n\nreal first\nmore");
  expect(r.summary).toBe("real first");
  expect(r.hidden).toBe(3); // lines: "", "", "real first", "more"
});

test("collapseToolOutput: clips the summary to maxWidth", () => {
  expect(collapseToolOutput("x".repeat(50), 10).summary).toBe(`${"x".repeat(10)}…`);
});

test("collapseToolOutput: empty input", () => {
  expect(collapseToolOutput("")).toEqual({ summary: "", lineCount: 0, hidden: 0 });
});

// --- flow 054: indentBlock (pure left gutter) ---

test("indentBlock prefixes non-empty lines and leaves empty lines untouched", () => {
  expect(indentBlock("a\n\nb", "  ")).toBe("  a\n\n  b");
});

test("indentBlock handles a single line and a trailing newline", () => {
  expect(indentBlock("hello", ">>")).toBe(">>hello");
  expect(indentBlock("x\n", "  ")).toBe("  x\n"); // trailing empty segment stays empty
});

// --- flow 050: summarizeToolArgs (pure, color-agnostic) ---

test("summarizeToolArgs renders a JSON object as compact key=value pairs", () => {
  expect(summarizeToolArgs('{"path":"src","depth":2}')).toBe("path=src, depth=2");
});

test("summarizeToolArgs collapses nested objects/arrays and shows null", () => {
  expect(summarizeToolArgs('{"a":{"x":1},"b":[1,2],"c":null}')).toBe("a={…}, b=[…], c=null");
});

test("summarizeToolArgs returns empty string for empty/whitespace input", () => {
  expect(summarizeToolArgs("")).toBe("");
  expect(summarizeToolArgs("   ")).toBe("");
});

test("summarizeToolArgs falls back to the raw (clipped) string for malformed JSON or non-objects", () => {
  expect(summarizeToolArgs("not json")).toBe("not json");
  expect(summarizeToolArgs('"a bare string"')).toBe('"a bare string"');
  expect(summarizeToolArgs("[1,2,3]")).toBe("[1,2,3]");
  const long = "x".repeat(200);
  expect(summarizeToolArgs(long, 10)).toBe(`${"x".repeat(10)}…`);
});

test("roleLabel styles known roles and passes color state through", () => {
  forceColor();
  expect(roleLabel("assistant")).toContain("assistant");
  expect(roleLabel("assistant")).toContain("[90m");
  expect(roleLabel("you")).toContain("[36m");
  process.env.NO_COLOR = "1";
  expect(roleLabel("assistant")).toBe("assistant");
});
