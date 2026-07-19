import { afterEach, expect, test } from "bun:test";
import { colorEnabled, indentBlock, renderMarkdown, roleLabel, style, summarizeToolArgs, symbols } from "./ui";

const savedNoColor = process.env.NO_COLOR;
const savedForceColor = process.env.FORCE_COLOR;

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
