import { describe, expect, test } from "bun:test";
import type { MdSegment } from "./md-blocks";
import {
  blockLabel,
  classifyDiffLine,
  fenceInfo,
  looksLikeUnifiedDiff,
  payloadKind,
  segmentMarkdown,
  splitLines,
  stripTrailingCr,
} from "./md-blocks";

// flow 109 / T2 — RED phase. `src/lib/md-blocks.ts` does not exist yet.
// These tests pin the pure L1 surface described in plan.md L1.

// --- segmentMarkdown -------------------------------------------------------

describe("segmentMarkdown", () => {
  test("empty input yields no segments", () => {
    expect(segmentMarkdown("")).toEqual([]);
  });

  test("plain prose yields a single text segment carrying the input verbatim", () => {
    const md = "first line\n\nthird line";
    expect(segmentMarkdown(md)).toEqual([{ kind: "text", text: md }]);
  });

  test("interleaves text -> code -> text and drops the fence lines", () => {
    const md = "before\n```ts\nconst x = 1;\nconst y = 2;\n```\nafter";
    const expected: MdSegment[] = [
      { kind: "text", text: "before" },
      { kind: "code", lang: "ts", body: "const x = 1;\nconst y = 2;" },
      { kind: "text", text: "after" },
    ];
    expect(segmentMarkdown(md)).toEqual(expected);
  });

  test("a fence at the very start yields exactly one code segment (no empty leading text)", () => {
    expect(segmentMarkdown("```\ncode line\n```")).toEqual([{ kind: "code", lang: "", body: "code line" }]);
  });

  test("a fence with no info string yields an empty lang", () => {
    const [segment] = segmentMarkdown("```\nx\n```");
    expect(segment).toEqual({ kind: "code", lang: "", body: "x" });
  });

  test("the info string contributes only its first token as lang", () => {
    expect(segmentMarkdown("```ts title=foo.ts\nx\n```")).toEqual([{ kind: "code", lang: "ts", body: "x" }]);
  });

  test("an unterminated fence (streaming in progress) still yields a code segment with the partial body", () => {
    const expected: MdSegment[] = [
      { kind: "text", text: "intro" },
      { kind: "code", lang: "js", body: "const partial = (" },
    ];
    expect(segmentMarkdown("intro\n```js\nconst partial = (")).toEqual(expected);
  });

  test("an unterminated fence with no body yet yields an empty code body", () => {
    expect(segmentMarkdown("```py")).toEqual([{ kind: "code", lang: "py", body: "" }]);
  });

  test("tilde fences behave exactly like backtick fences", () => {
    const expected: MdSegment[] = [
      { kind: "text", text: "before" },
      { kind: "code", lang: "py", body: "print(1)" },
      { kind: "text", text: "after" },
    ];
    expect(segmentMarkdown("before\n~~~py\nprint(1)\n~~~\nafter")).toEqual(expected);
  });

  test("multiple fenced blocks are segmented independently", () => {
    const md = "a\n```ts\n1\n```\nb\n```diff\n+2\n```\nc";
    expect(segmentMarkdown(md)).toEqual([
      { kind: "text", text: "a" },
      { kind: "code", lang: "ts", body: "1" },
      { kind: "text", text: "b" },
      { kind: "code", lang: "diff", body: "+2" },
      { kind: "text", text: "c" },
    ]);
  });

  test("blank lines inside prose stay inside one text segment", () => {
    const md = "para one\n\npara two\n\npara three";
    expect(segmentMarkdown(md)).toEqual([{ kind: "text", text: md }]);
  });

  test("inline backticks in prose are NOT treated as a fence", () => {
    const md = "use `const x = 1` and `y` inline";
    expect(segmentMarkdown(md)).toEqual([{ kind: "text", text: md }]);
  });

  test("a triple backtick that does not start the line is NOT a fence", () => {
    const md = "see ``` for fenced blocks";
    expect(segmentMarkdown(md)).toEqual([{ kind: "text", text: md }]);
  });

  test("an empty fenced block yields an empty body", () => {
    expect(segmentMarkdown("```ts\n```")).toEqual([{ kind: "code", lang: "ts", body: "" }]);
  });

  // flow 109 / T3 carried concern: anchoring the fence at column 0 rendered a
  // fence nested in a list item as literal prose. CommonMark allows up to three
  // characters of indentation.
  test("a fence indented up to three spaces (nested in a list item) still opens a block", () => {
    const md = "- step one:\n  ```ts\n  const x = 1;\n  ```\n- step two";
    expect(segmentMarkdown(md)).toEqual([
      { kind: "text", text: "- step one:" },
      { kind: "code", lang: "ts", body: "  const x = 1;" },
      { kind: "text", text: "- step two" },
    ]);
  });

  test("a fence indented four or more spaces is NOT a fence (indented code block)", () => {
    const md = "prose\n    ```ts\n    x\n    ```";
    expect(segmentMarkdown(md)).toEqual([{ kind: "text", text: md }]);
  });
});

// --- CR / CRLF (flow 109 / T6 review F1) -----------------------------------
//
// The permissive `/^\s*```/` this fence detection replaced DID match a CRLF
// fence line; `/^[ \t]{0,3}(```|~~~)(.*)$/` silently did not, because JS treats
// CR as a line terminator (neither `.` nor `$` crosses it). The table below
// enumerates what the old regex accepted so the narrower one cannot regress it
// again — a CRLF payload (Windows tool output, a CRLF file read, a model
// emitting CRLF) must segment exactly like its LF twin.

describe("fenceInfo: CR / LF / tab acceptance table", () => {
  const cases: Array<{ line: string; label: string; lang: string | undefined }> = [
    { line: "```ts", label: "bare LF fence", lang: "ts" },
    { line: "```ts\r", label: "CRLF fence", lang: "ts" },
    { line: "```\r", label: "CRLF fence, no info string", lang: "" },
    { line: "~~~py\r", label: "CRLF tilde fence", lang: "py" },
    { line: "  ```ts\r", label: "indented CRLF fence", lang: "ts" },
    { line: "\t```ts\r", label: "tab-indented CRLF fence", lang: "ts" },
    { line: "```ts extra\r", label: "CRLF fence with a multi-token info string", lang: "ts" },
    { line: "    ```ts\r", label: "4-space indent (indented code block, not a fence)", lang: undefined },
    { line: "see ``` here\r", label: "mid-line backticks in CRLF prose", lang: undefined },
    { line: "plain prose\r", label: "CRLF prose", lang: undefined },
  ];

  for (const { line, label, lang } of cases) {
    test(`${label}: ${JSON.stringify(line)}`, () => {
      expect(fenceInfo(line)?.lang).toBe(lang);
    });
  }

  test("the info string never keeps a stray CR", () => {
    expect(fenceInfo("```ts\r")).toEqual({ marker: "```", lang: "ts" });
  });
});

describe("segmentMarkdown: CRLF payloads", () => {
  test("a CRLF document segments identically to its LF twin", () => {
    const lf = "a\n```ts\nx\n```\nb";
    const crlf = "a\r\n```ts\r\nx\r\n```\r\nb";
    expect(segmentMarkdown(crlf)).toEqual(segmentMarkdown(lf));
    expect(segmentMarkdown(crlf)).toEqual([
      { kind: "text", text: "a" },
      { kind: "code", lang: "ts", body: "x" },
      { kind: "text", text: "b" },
    ]);
  });

  test("no segment retains a stray CR", () => {
    for (const segment of segmentMarkdown("intro\r\nmore prose\r\n```diff\r\n+added\r\n```\r\ntail\r\n")) {
      const text = segment.kind === "text" ? segment.text : segment.body;
      expect(text).not.toContain("\r");
    }
  });

  test("an unterminated CRLF fence still yields its partial body", () => {
    expect(segmentMarkdown("intro\r\n```js\r\nconst partial = (")).toEqual([
      { kind: "text", text: "intro" },
      { kind: "code", lang: "js", body: "const partial = (" },
    ]);
  });

  test("a lone CR (no LF) is NOT treated as a line break", () => {
    const md = "not a fence: ```ts\rstill the same line";
    expect(segmentMarkdown(md)).toEqual([{ kind: "text", text: md }]);
  });
});

describe("splitLines / stripTrailingCr", () => {
  test("stripTrailingCr removes one trailing CR and nothing else", () => {
    expect(stripTrailingCr("x\r")).toBe("x");
    expect(stripTrailingCr("x")).toBe("x");
    expect(stripTrailingCr("x\r\r")).toBe("x\r");
    expect(stripTrailingCr("\rx")).toBe("\rx");
    expect(stripTrailingCr("")).toBe("");
  });

  test("splitLines normalizes CRLF and leaves LF-only input untouched", () => {
    expect(splitLines("a\r\nb\r\nc")).toEqual(["a", "b", "c"]);
    expect(splitLines("a\nb\nc")).toEqual(["a", "b", "c"]);
    expect(splitLines("a\r\nb\nc\r")).toEqual(["a", "b", "c"]);
    expect(splitLines("")).toEqual([""]);
  });
});

describe("looksLikeUnifiedDiff: CRLF", () => {
  test("a CRLF unified diff is still detected", () => {
    expect(looksLikeUnifiedDiff("@@ -1,2 +1,2 @@\r\n-old\r\n+new")).toBe(true);
    expect(looksLikeUnifiedDiff("--- a/x.ts\r\n+++ b/x.ts\r\n context")).toBe(true);
  });

  test("a CRLF bullet list is still NOT a diff (AC7)", () => {
    expect(looksLikeUnifiedDiff("- one\r\n- two\r\n- three")).toBe(false);
  });
});

// --- classifyDiffLine ------------------------------------------------------

describe("classifyDiffLine", () => {
  test("hunk headers", () => {
    expect(classifyDiffLine("@@ -1,4 +1,6 @@")).toBe("hunk");
    expect(classifyDiffLine("@@ -1,4 +1,6 @@ function foo()")).toBe("hunk");
  });

  test("file headers are meta", () => {
    expect(classifyDiffLine("--- a/src/lib/ui.ts")).toBe("meta");
    expect(classifyDiffLine("+++ b/src/lib/ui.ts")).toBe("meta");
    expect(classifyDiffLine("--- /dev/null")).toBe("meta");
  });

  test("added and removed body lines", () => {
    expect(classifyDiffLine("+added line")).toBe("add");
    expect(classifyDiffLine("-removed line")).toBe("del");
  });

  test("everything else is context", () => {
    expect(classifyDiffLine(" unchanged line")).toBe("context");
    expect(classifyDiffLine("plain text")).toBe("context");
    expect(classifyDiffLine("")).toBe("context");
  });
});

// --- looksLikeUnifiedDiff --------------------------------------------------

describe("looksLikeUnifiedDiff", () => {
  test("true when an @@ hunk header is present", () => {
    expect(looksLikeUnifiedDiff("@@ -1,4 +1,6 @@\n context\n+added\n-removed")).toBe(true);
  });

  test("true for a single-line hunk header without counts", () => {
    expect(looksLikeUnifiedDiff("@@ -1 +1 @@\n-old\n+new")).toBe(true);
  });

  test("true when a --- / +++ file-header pair is present", () => {
    expect(looksLikeUnifiedDiff("--- a/x.ts\n+++ b/x.ts\n context")).toBe(true);
  });

  test("AC7: a markdown bullet list starting with '- ' is NOT a diff", () => {
    expect(looksLikeUnifiedDiff("- one\n- two\n- three")).toBe(false);
  });

  test("prose with a leading '-' is NOT a diff", () => {
    expect(looksLikeUnifiedDiff("- see the notes below\nand some prose")).toBe(false);
  });

  test("bare +/- lines without any header are NOT a diff", () => {
    expect(looksLikeUnifiedDiff("+added\n-removed")).toBe(false);
  });

  test("a lone --- file header without its +++ partner is NOT a diff", () => {
    expect(looksLikeUnifiedDiff("--- a/x.ts\nsome prose")).toBe(false);
  });

  test("empty and whitespace input are NOT a diff", () => {
    expect(looksLikeUnifiedDiff("")).toBe(false);
    expect(looksLikeUnifiedDiff("   \n\n")).toBe(false);
  });
});

// --- payloadKind -----------------------------------------------------------

describe("payloadKind", () => {
  test("markdown-ish languages map to the markdown payload", () => {
    for (const lang of ["md", "markdown", "prompt", "txt", "text"]) {
      expect(payloadKind(lang, 3)).toBe("markdown");
    }
  });

  test("diff-ish languages map to the diff payload", () => {
    expect(payloadKind("diff", 12)).toBe("diff");
    expect(payloadKind("patch", 12)).toBe("diff");
  });

  test("anything else maps to the code payload", () => {
    expect(payloadKind("ts", 4)).toBe("code");
    expect(payloadKind("python", 4)).toBe("code");
    expect(payloadKind("", 4)).toBe("code");
  });

  test("the language match is case-insensitive", () => {
    expect(payloadKind("MD", 1)).toBe("markdown");
    expect(payloadKind("Markdown", 1)).toBe("markdown");
    expect(payloadKind("Diff", 1)).toBe("diff");
    expect(payloadKind("PATCH", 1)).toBe("diff");
    expect(payloadKind("TS", 1)).toBe("code");
  });

  test("line count does not change the language mapping", () => {
    expect(payloadKind("md", 1)).toBe(payloadKind("md", 500));
    expect(payloadKind("diff", 1)).toBe(payloadKind("diff", 500));
    expect(payloadKind("ts", 1)).toBe(payloadKind("ts", 500));
  });
});

// --- blockLabel (AC2) ------------------------------------------------------

describe("blockLabel", () => {
  test("collapsed uses the closed marker, expanded uses the open marker", () => {
    expect(blockLabel({ kind: "thought", lineCount: 14, collapsed: true })).toBe("▸ thought (14 lines)");
    expect(blockLabel({ kind: "thought", lineCount: 14, collapsed: false })).toBe("▾ thought (14 lines)");
  });

  test("line count is singular for exactly one line", () => {
    expect(blockLabel({ kind: "tool", lineCount: 1, collapsed: true })).toBe("▸ tool (1 line)");
    expect(blockLabel({ kind: "tool", lineCount: 2, collapsed: true })).toBe("▸ tool (2 lines)");
    expect(blockLabel({ kind: "tool", lineCount: 0, collapsed: true })).toBe("▸ tool (0 lines)");
  });

  test("an optional hint is appended after a ' · ' separator", () => {
    expect(blockLabel({ kind: "thought", lineCount: 14, collapsed: true, hint: "ctrl+r" })).toBe(
      "▸ thought (14 lines) · ctrl+r",
    );
    expect(blockLabel({ kind: "code", lineCount: 1, collapsed: false, hint: "/copy" })).toBe("▾ code (1 line) · /copy");
  });

  test("an absent or empty hint adds no separator", () => {
    expect(blockLabel({ kind: "code", lineCount: 3, collapsed: true })).toBe("▸ code (3 lines)");
    expect(blockLabel({ kind: "code", lineCount: 3, collapsed: true, hint: "" })).toBe("▸ code (3 lines)");
  });

  test("the label is plain text so callers own the styling", () => {
    const label = blockLabel({ kind: "thought", lineCount: 9, collapsed: true, hint: "ctrl+r" });
    expect(label).not.toContain("");
  });
});
