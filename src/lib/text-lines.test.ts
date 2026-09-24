// Flow 313 (W4) review R2-F5 / R3-F7 / R3-F8, choke point d.
import { describe, expect, test } from "bun:test";
import { splitLogicalLines } from "./text-lines";

describe("splitLogicalLines", () => {
  test("splits on LF", () => {
    expect(splitLogicalLines("a\nb\nc")).toEqual(["a", "b", "c"]);
  });

  test("splits on CRLF without leaving a trailing CR on the line", () => {
    expect(splitLogicalLines("a\r\nb\r\nc")).toEqual(["a", "b", "c"]);
  });

  test("splits on a lone CR", () => {
    expect(splitLogicalLines("a\rb\rc")).toEqual(["a", "b", "c"]);
  });

  test("splits on U+2028 LINE SEPARATOR", () => {
    expect(splitLogicalLines("a" + " " + "b")).toEqual(["a", "b"]);
  });

  test("splits on U+2029 PARAGRAPH SEPARATOR", () => {
    expect(splitLogicalLines("a" + " " + "b")).toEqual(["a", "b"]);
  });

  test("splits on U+0085 NEXT LINE (R3-F7/R3-F8: missing from the pre-fix lists)", () => {
    expect(splitLogicalLines("a" + "\u0085" + "b")).toEqual(["a", "b"]);
  });

  test("a mixed document splits consistently", () => {
    const doc =
      "one\r\ntwo\nthree\rfour" + " " + "five" + " " + "six" + "\u0085" + "seven";
    expect(splitLogicalLines(doc)).toEqual([
      "one",
      "two",
      "three",
      "four",
      "five",
      "six",
      "seven",
    ]);
  });

  test("does not split on vertical tab or form feed (intra-line whitespace, not a line break)", () => {
    const line = "a" + "\u000b" + "b" + "\u000c" + "c";
    expect(splitLogicalLines(line)).toEqual([line]);
  });

  test("does not split on Unicode space separators", () => {
    const line = "a" + " " + "b" + "　" + "c";
    expect(splitLogicalLines(line)).toEqual([line]);
  });

  test("empty input yields a single empty line", () => {
    expect(splitLogicalLines("")).toEqual([""]);
  });
});
