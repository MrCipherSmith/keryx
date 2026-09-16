// The line a finding carries must be one somebody derived, not one somebody claimed.
//
// Written before the wiring, so every case here fails against a pipeline that
// takes `line` as reported: none of these findings carries a usable line at all.

import { describe, expect, test } from "bun:test";
import { locateFinding, locateQuote, MAX_LOCATE_FILE_LINES, MAX_QUOTE_LINES, quoteLines } from "./locate";

const FILE = [
  "export function greet(name: string): string {", // 1
  "  const trimmed = name.trim();", // 2
  "  if (trimmed === \"\") {", // 3
  "    return \"hello\";", // 4
  "  }", // 5
  "  return `hello ${trimmed}`;", // 6
  "}", // 7
  "", // 8
  "export function farewell(name: string): string {", // 9
  "  const trimmed = name.trim();", // 10
  "  return `bye ${trimmed}`;", // 11
  "}", // 12
].join("\n");

describe("locateQuote", () => {
  test("a unique single line yields its 1-based number", () => {
    expect(locateQuote(FILE, "  return `hello ${trimmed}`;")).toEqual({
      state: "derived",
      method: "exact",
      line: 6,
    });
  });

  test("a multi-line quote anchors at its first line", () => {
    const quote = ["  if (trimmed === \"\") {", "    return \"hello\";", "  }"].join("\n");
    expect(locateQuote(FILE, quote)).toEqual({ state: "derived", method: "exact", line: 3 });
  });

  test("indentation lost on the way through a code fence still matches", () => {
    // The same two lines, re-indented to column zero — what a markdown round-trip
    // does to a snippet. Common-indent stripping is what saves this.
    const quote = ["if (trimmed === \"\") {", "  return \"hello\";"].join("\n");
    expect(locateQuote(FILE, quote)).toEqual({ state: "derived", method: "exact", line: 3 });
  });

  test("blank edges around the quote are ignored", () => {
    expect(locateQuote(FILE, "\n\n  return `bye ${trimmed}`;\n\n")).toEqual({
      state: "derived",
      method: "exact",
      line: 11,
    });
  });

  test("a quote whose spacing drifted falls through to the normalised pass", () => {
    expect(locateQuote(FILE, "return    `bye ${trimmed}`;")).toEqual({
      state: "derived",
      method: "whitespace-normalised",
      line: 11,
    });
  });

  test("AMBIGUITY — a quote matching twice is unlocatable, never the first hit", () => {
    // `const trimmed = name.trim();` appears at lines 2 and 10. Choosing 2
    // because it comes first is exactly the confident wrong anchor this exists
    // to prevent.
    const outcome = locateQuote(FILE, "  const trimmed = name.trim();");
    expect(outcome.state).toBe("unlocatable");
    expect(outcome.state === "unlocatable" && outcome.reason).toContain("2 places");
    expect(outcome.state === "unlocatable" && outcome.reason).toContain("lines 2, 10");
  });

  test("AMBIGUITY — the same rule holds for the whitespace-normalised pass", () => {
    // The exact pass had this test and the loose pass did not, so collapsing
    // the loose branch to "return the first hit" left the whole suite green.
    // These two lines differ exactly, and are identical once whitespace is
    // collapsed — so only the second pass can see them as two.
    const file = ["const a = 1;", "const b = 2;", "const  a  =  1;"].join("\n");
    const outcome = locateQuote(file, "const   a = 1;");
    expect(outcome.state).toBe("unlocatable");
    expect(outcome.state === "unlocatable" && outcome.reason).toContain("2 places");
    expect(outcome.state === "unlocatable" && outcome.reason).toContain("whitespace");
  });

  test("a quote past the line bound is refused rather than matched slowly", () => {
    const outcome = locateQuote("a\n".repeat(10), `${"x\n".repeat(MAX_QUOTE_LINES + 1)}`);
    expect(outcome.state).toBe("unlocatable");
    expect(outcome.state === "unlocatable" && outcome.reason).toContain(`${MAX_QUOTE_LINES}-line bound`);
  });

  test("a file past the line bound is refused rather than matched slowly", () => {
    const outcome = locateQuote("a\n".repeat(MAX_LOCATE_FILE_LINES + 1), "a");
    expect(outcome.state).toBe("unlocatable");
    expect(outcome.state === "unlocatable" && outcome.reason).toContain("bound for locating");
  });

  test("a quote that is not in the file says so", () => {
    const outcome = locateQuote(FILE, "  return `howdy ${trimmed}`;");
    expect(outcome).toEqual({ state: "unlocatable", reason: "the quote does not appear in the file" });
  });

  test("an empty quote is unlocatable rather than matching everything", () => {
    expect(locateQuote(FILE, "   \n  \n")).toEqual({ state: "unlocatable", reason: "the quote is empty" });
  });

  test("CRLF on either side does not defeat the match", () => {
    const crlf = FILE.replace(/\n/g, "\r\n");
    expect(locateQuote(crlf, "  return `hello ${trimmed}`;\r\n")).toEqual({
      state: "derived",
      method: "exact",
      line: 6,
    });
  });
});

describe("quoteLines", () => {
  test("strips the common indent and nothing else", () => {
    expect(quoteLines("    a\n      b\n    c\n")).toEqual(["a", "  b", "c"]);
  });

  test("a blank line inside the quote does not reset the common indent to zero", () => {
    expect(quoteLines("    a\n\n    b")).toEqual(["a", "", "b"]);
  });
});

describe("locateFinding", () => {
  const reader = (text: string | null) => async () => text;

  test("derives the line and keeps what the reviewer reported alongside it", async () => {
    const record = await locateFinding(
      { file: "src/greet.ts", quote: "  return `hello ${trimmed}`;", line: 42 },
      reader(FILE),
    );
    expect(record).toEqual({ state: "derived", method: "exact", line: 6, reported_line: 42 });
  });

  test("REGRESSION — a reviewer's wrong line does not survive into the record", async () => {
    // The whole point: 42 is what the reviewer said, 6 is where the code is.
    const record = await locateFinding(
      { file: "src/greet.ts", quote: "  return `hello ${trimmed}`;", line: 42 },
      reader(FILE),
    );
    expect(record?.state === "derived" && record.line).toBe(6);
    expect(record?.state === "derived" && record.line).not.toBe(42);
  });

  test("a missing file is its own reason, distinct from a missing quote", async () => {
    const record = await locateFinding(
      { file: "src/gone.ts", quote: "anything", line: 3 },
      reader(null),
    );
    expect(record).toEqual({
      state: "unlocatable",
      reason: "no such file at this round's head: src/gone.ts",
      reported_line: 3,
    });
  });

  test("a quote with no file named is refused rather than searched for", async () => {
    const record = await locateFinding({ quote: "  return `hello ${trimmed}`;", line: 6 }, reader(FILE));
    expect(record?.state).toBe("unlocatable");
    expect(record?.state === "unlocatable" && record.reason).toContain("names no file");
  });

  test("BOUNDARY — a finding with no quote is left entirely alone", async () => {
    // Not every finding is about a site: an `info` about the round itself has
    // nothing to quote, and inventing a locator for it would be noise.
    expect(await locateFinding({ file: "src/greet.ts", line: 6 }, reader(FILE))).toBeUndefined();
    expect(await locateFinding({ file: "src/greet.ts", quote: "   ", line: 6 }, reader(FILE))).toBeUndefined();
  });
});
