import { describe, expect, test } from "bun:test";
import { extractSection, markdownHeadings, slugifyHeading } from "./references-section";

// AC6: with an anchor the obligation and the budget are the section from the
// heading to the next heading of equal or higher level; a missing anchor is a
// distinct result (not a throw) so the resolver can fall back with a warning and
// `check` can report an error.

const DOC = [
  "# Styling",
  "",
  "Intro text.",
  "",
  "## Class conventions",
  "",
  "Use tokens.",
  "",
  "### Tailwind 4 cascade",
  "",
  "Layers matter.",
  "",
  "## Theming",
  "",
  "Theme text.",
  "",
  "# Appendix",
  "",
  "Tail.",
  "",
].join("\n");

describe("extractSection", () => {
  test("returns the section from the heading to the next heading of equal level", () => {
    const result = extractSection(DOC, "Theming");
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.text).toBe("## Theming\n\nTheme text.\n\n");
    expect(result.heading).toBe("Theming");
    expect(result.level).toBe(2);
  });

  test("keeps deeper headings inside the section", () => {
    const result = extractSection(DOC, "Class conventions");
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.text).toContain("### Tailwind 4 cascade");
    expect(result.text).toContain("Layers matter.");
    expect(result.text).not.toContain("Theme text.");
  });

  test("stops at a heading of higher level", () => {
    const result = extractSection(DOC, "Tailwind 4 cascade");
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.text).toBe("### Tailwind 4 cascade\n\nLayers matter.\n\n");
  });

  test("a level-1 anchor runs to the next level-1 heading", () => {
    const result = extractSection(DOC, "Styling");
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.text.endsWith("Theme text.\n\n")).toBe(true);
    expect(result.text).not.toContain("Appendix");
  });

  test("the last section runs to the end of the file", () => {
    const result = extractSection(DOC, "Appendix");
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.text).toBe("# Appendix\n\nTail.\n");
  });

  test("reports bytes in UTF-8, not characters", () => {
    const result = extractSection("# Тема\n\nтекст\n", "Тема");
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.bytes).toBe(Buffer.byteLength("# Тема\n\nтекст\n", "utf8"));
    expect(result.bytes).toBeGreaterThan(result.text.length);
  });

  test("matches the heading text case-insensitively and trimmed", () => {
    const result = extractSection(DOC, "  class CONVENTIONS ");
    expect(result.found).toBe(true);
  });

  test("matches a slug, with or without the leading hash", () => {
    for (const anchor of ["tailwind-4-cascade", "#tailwind-4-cascade"]) {
      const result = extractSection(DOC, anchor);
      expect(result.found).toBe(true);
      if (result.found) expect(result.heading).toBe("Tailwind 4 cascade");
    }
  });

  test("ignores headings inside fenced code blocks", () => {
    const text = ["## Real", "", "```sh", "# not a heading", "## also not", "```", "", "after fence", "", "## Next", ""].join("\n");
    const real = extractSection(text, "Real");
    expect(real.found).toBe(true);
    if (real.found) {
      expect(real.text).toContain("after fence");
      expect(real.text).not.toContain("## Next");
    }
    expect(extractSection(text, "not a heading").found).toBe(false);
  });

  test("ignores closing hashes and handles CRLF without altering bytes", () => {
    const text = "## Alpha ##\r\n\r\nbody\r\n\r\n## Beta\r\n";
    const result = extractSection(text, "Alpha");
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.heading).toBe("Alpha");
    expect(result.text).toBe("## Alpha ##\r\n\r\nbody\r\n\r\n");
  });

  test("a missing anchor is a distinct result, not a throw", () => {
    const result = extractSection(DOC, "Does not exist");
    expect(result.found).toBe(false);
    if (result.found) return;
    expect(result.anchor).toBe("Does not exist");
    expect(result.reason).toContain("Does not exist");
    expect(result.available).toContain("Theming");
  });

  test("an empty anchor is not found", () => {
    expect(extractSection(DOC, "   ").found).toBe(false);
    expect(extractSection(DOC, "#").found).toBe(false);
  });

  test("a heading needs a space after the hashes", () => {
    expect(extractSection("#nospace\n\ntext\n", "nospace").found).toBe(false);
  });

  test("the first of two same-named headings wins", () => {
    const result = extractSection("## Dup\n\none\n\n## Dup\n\ntwo\n", "Dup");
    expect(result.found).toBe(true);
    if (result.found) expect(result.text).toContain("one");
  });
});

describe("markdownHeadings and slugifyHeading", () => {
  test("lists headings outside fences with level and slug", () => {
    expect(markdownHeadings("# A b\n```\n# x\n```\n### C\n")).toEqual([
      { level: 1, text: "A b", slug: "a-b" },
      { level: 3, text: "C", slug: "c" },
    ]);
  });

  test("slugifies like GitHub for ASCII and keeps other scripts", () => {
    expect(slugifyHeading("Tailwind 4: the cascade!")).toBe("tailwind-4-the-cascade");
    expect(slugifyHeading("Тема оформления")).toBe("тема-оформления");
  });
});
