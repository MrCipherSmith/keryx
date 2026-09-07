import { describe, expect, test } from "bun:test";
import { blankCode, linksIn } from "./check-doc-links";

// The gate reported three broken links in
// docs/requirements/keryx-agent-first-core/policies.md pointing at a file
// named `URL`. There is no such link. That document DEFINES which markdown
// spellings the zero-click auto-fetch floor covers, so it has to write
// `![alt](URL)` out in backticks in order to name the construct. Quoted
// syntax is not a link, and a documentation gate that cannot tell prose from
// code fails exactly the documents that are most careful about syntax.

describe("blankCode", () => {
  test("blanks an inline code span while preserving length and line count", () => {
    const out = blankCode("see `[a](b.md)` here\nnext line");
    expect(out).toBe("see             here\nnext line");
    expect(out.length).toBe("see `[a](b.md)` here\nnext line".length);
    expect(out.split("\n")).toHaveLength(2);
  });

  test("blanks a fenced block, including link syntax at the start of a line inside it", () => {
    const src = ["intro", "```md", "[label]: ./nope.md", "```", "outro"].join("\n");
    const out = blankCode(src);
    expect(out.split("\n")).toHaveLength(5);
    expect(out).toContain("intro");
    expect(out).toContain("outro");
    expect(out).not.toContain("nope.md");
  });

  test("a run of N backticks closes only on a run of exactly N", () => {
    // The inner single backticks must not terminate the double-backtick span.
    expect(blankCode("``a `[x](y.md)` b``")).toBe("                   ");
  });

  test("an unbalanced backtick inside a fence does not swallow the rest of the document", () => {
    const src = ["```sh", "echo `date", "```", "real [text](./after.md)"].join("\n");
    expect(linksIn(src)).toEqual(["./after.md"]);
  });
});

describe("linksIn", () => {
  test("finds inline and reference links in prose", () => {
    const src = ["[one](./a.md) and [two](../b.md#sec)", "[three]: ./c.md"].join("\n");
    expect(linksIn(src)).toEqual(["./a.md", "../b.md#sec", "./c.md"]);
  });

  test("regression: markdown syntax quoted as an example is not a link", () => {
    // Verbatim shapes from policies.md, which is what broke the gate.
    const src =
      "inline `![alt](URL)`, `![a[b]c](URL)`, badge `[![alt](URL)](href)`, " +
      "definition `[ref]: URL`, in a quote (`> [ref]: URL`) or a list item (`- [ref]: URL`).";
    expect(linksIn(src)).toEqual([]);
  });

  test("a real link on the same line as a quoted example is still found", () => {
    const src = "the floor covers `![alt](URL)`; see [the policy](./policies.md).";
    expect(linksIn(src)).toEqual(["./policies.md"]);
  });

  test("a reference definition is only recognised at the start of a line", () => {
    expect(linksIn("text [label]: ./a.md")).toEqual([]);
    expect(linksIn("[label]: ./a.md")).toEqual(["./a.md"]);
  });
});
