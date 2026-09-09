import { describe, expect, test } from "bun:test";
import { collectFiles, exemptions, isWasIsRow, scanText, scanTree } from "./check-retired-cli-spellings";

describe("retired publisher spellings are not taught to readers", () => {
  test("the documentation tree contains no undeclared retired spelling", () => {
    const { violations, markerErrors } = scanTree();

    // Named, not counted: a bare count tells you a gate failed, not what to fix.
    expect(violations.map((v) => `${v.file}:${v.line}  ${v.spelling}`)).toEqual([]);
    expect(markerErrors).toEqual([]);
  });

  // A scanner that silently matches nothing reports "clean" exactly like a
  // clean tree. That failure mode has shipped in this repository before, so
  // the gate proves it did the work before it is allowed to pass.
  test("the scan actually reached the documentation corpus", () => {
    const { filesScanned, occurrences } = scanTree();

    // docs/ and .metaproject/ together carry ~1000 markdown files; a collector
    // that broke its glob, its cwd, or its dotfile handling lands far below.
    expect(filesScanned).toBeGreaterThan(400);

    // The was->is tables in decisions.md and specification.md are permanent by
    // design — they record the rename. If the matcher stops seeing even those,
    // it has stopped working, whatever it reports about violations.
    expect(occurrences).toBeGreaterThanOrEqual(6);
  });

  test("the collector reaches the specific files a reader is sent to", () => {
    const files = collectFiles();

    // Spot-checking real paths catches a glob that matches many files while
    // missing the surface that matters — a count alone would not.
    expect(files).toContain("README.md");
    expect(files).toContain("docs/docs/cli-reference.md");
    expect(files).toContain("docs/docs/onboarding.md");
    expect(files).toContain(".metaproject/modules/mcp.md");
  });
});

describe("detection", () => {
  test("flags a retired spelling inside a fenced block, which is where instructions live", () => {
    const src = ["Wire Cursor:", "", "```bash", "keryx mcp install --runtime cursor", "```"].join("\n");
    const { violations } = scanText("d.md", src);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.spelling).toBe("keryx mcp install");
    expect(violations[0]!.line).toBe(4);
  });

  test("flags each of the three retired spellings", () => {
    const src = ["keryx mcp serve", "keryx mcp install", "keryx mcp uninstall"].join("\n");
    expect(scanText("d.md", src).violations.map((v) => v.spelling)).toEqual([
      "keryx mcp serve",
      "keryx mcp install",
      "keryx mcp uninstall",
    ]);
  });

  test("counts every occurrence on one line, not just the first", () => {
    const src = "run `keryx mcp serve`, then `keryx mcp install --runtime all`";
    expect(scanText("d.md", src).violations).toHaveLength(2);
  });

  test("the surviving `keryx mcp` alias and the new spellings are not flagged", () => {
    const src = ["keryx mcp", "keryx serve-mcp --http", "keryx integrate --remove cursor"].join("\n");
    expect(scanText("d.md", src).violations).toEqual([]);
  });
});

describe("was->is rows are exempt by shape, not by filename", () => {
  test("a row naming the old spelling and its replacement is the record of the rename", () => {
    expect(isWasIsRow("| `keryx mcp serve` | `keryx serve-mcp` |")).toBe(true);
    expect(isWasIsRow("| `keryx mcp uninstall --runtime <e>` | `keryx integrate --remove <e>` |")).toBe(true);
  });

  test("a row naming only the old spelling is drift, not a record", () => {
    expect(isWasIsRow("| `keryx mcp serve [--cwd <root>]` | Serve MCP over stdio. |")).toBe(false);
  });

  test("prose mentioning both spellings outside a table is not a row", () => {
    expect(isWasIsRow("Run `keryx mcp serve`, soon to be `keryx serve-mcp`.")).toBe(false);
  });

  test("a brand-new document recording the history passes with no change to this gate", () => {
    const src = [
      "# Some future decision record",
      "",
      "| was | is |",
      "|---|---|",
      "| `keryx mcp serve` | `keryx serve-mcp` |",
      "| `keryx mcp install --runtime <editor>` | `keryx integrate <editor>` |",
    ].join("\n");
    const { violations, occurrences } = scanText("future.md", src);
    expect(violations).toEqual([]);
    expect(occurrences).toBe(2); // seen and deliberately allowed, not invisible
  });
});

describe("declared historical passages", () => {
  test("a file-scoped marker exempts the whole document", () => {
    const src = [
      "<!-- retired-spellings-ok: file — this document analyses the old names -->",
      "# Analysis",
      "`keryx mcp serve` means keryx is the server.",
      "## Later",
      "`keryx mcp install` is the surprising one.",
    ].join("\n");
    expect(scanText("a.md", src).violations).toEqual([]);
  });

  test("a section-scoped marker stops at the next heading", () => {
    const src = [
      "## Changelog",
      "<!-- retired-spellings-ok: section — dated record of what the release stated -->",
      "- 0.29.0 — does not change `keryx mcp serve`.",
      "## Packages",
      "Run `keryx mcp serve` to start it.",
    ].join("\n");
    const { violations } = scanText("r.md", src);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.line).toBe(5);
  });

  test("a line-scoped marker covers the next non-blank line and nothing after it", () => {
    const src = [
      "<!-- retired-spellings-ok: line — verbatim quote of the superseded draft -->",
      "",
      "The draft argued: `keryx mcp install` writes an absolute path.",
      "Today you should still run `keryx mcp install`.",
    ].join("\n");
    const { violations } = scanText("p.md", src);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.line).toBe(4);
  });

  test("a marker with no reason is itself a failure", () => {
    const { markerErrors } = scanText("x.md", "<!-- retired-spellings-ok: file — -->\n`keryx mcp serve`");
    expect(markerErrors).toHaveLength(1);
    expect(markerErrors[0]).toContain("carries no reason");
  });

  test("a marker with an unrecognised scope is itself a failure", () => {
    const { markerErrors } = scanText("x.md", "<!-- retired-spellings-ok: everywhere — because -->");
    expect(markerErrors).toHaveLength(1);
    expect(markerErrors[0]).toContain("unknown retired-spellings-ok scope");
  });

  test("an unreadable marker does not silently exempt the line it sits on", () => {
    const src = ["<!-- retired-spellings-ok: file — -->", "`keryx mcp serve`"].join("\n");
    const { violations, markerErrors } = scanText("x.md", src);
    expect(markerErrors).toHaveLength(1);
    expect(violations).toHaveLength(1);
  });

  test("exemptions reports the line numbers it covers", () => {
    const src = ["# H", "<!-- retired-spellings-ok: section — why -->", "a", "# H2", "b"];
    const { whole, lines } = exemptions(src);
    expect(whole).toBe(false);
    expect([...lines].sort((a, b) => a - b)).toEqual([2, 3]);
  });
});

test("a live instruction wearing a table's clothes is NOT exempt", () => {
  // Found in review of PR #499 and confirmed by running the gate: the shape
  // rule only asked that a line start with `|` and contain a retired spelling
  // and SOME replacement anywhere on it. This line satisfied that and was
  // silently swallowed — while being exactly the thing the gate exists to
  // catch, documentation re-teaching the retired name.
  const line = "| Tip | run `keryx mcp install --runtime cursor` (or the new `keryx integrate cursor`) |";
  expect(isWasIsRow(line)).toBe(false);
});

test("a real was->is row is still exempt, suffixes and all", () => {
  // The pairing rule must not be so strict that genuine rename records trip it;
  // real rows carry argument suffixes.
  expect(
    isWasIsRow("| `keryx mcp uninstall --runtime <editor>` | `keryx integrate --remove <editor>` |"),
  ).toBe(true);
  expect(isWasIsRow("| `keryx mcp serve` | `keryx serve-mcp` |")).toBe(true);
});

test("a retired spelling paired with the WRONG replacement is not exempt", () => {
  // `keryx mcp serve` did not become `keryx integrate`. A rule that accepts any
  // replacement anywhere on the row would excuse a table that misinforms.
  expect(isWasIsRow("| `keryx mcp serve` | `keryx integrate` |")).toBe(false);
});
