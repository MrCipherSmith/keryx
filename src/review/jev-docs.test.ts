// flow 333 — pure-function tests for `src/review/jev-docs.ts` (AC1/AC2 of
// the frozen acceptance criteria). No I/O, no Jev, no network: every
// function here takes strings/objects and returns strings/objects.

import { describe, expect, test } from "bun:test";
import {
  batchDocsSections,
  boundLinkedSections,
  detectRemovedFlags,
  docsFindingStats,
  extractDocLinks,
  extractDocSections,
  findDeterministicFlagFindings,
  linkSectionsToDiff,
  linksToChangedPath,
  renderJevDocsMarkdown,
  synthesizeDocsFinding,
  type LinkedSection,
} from "./jev-docs";
import type { ScopedRegion } from "./scope";

function region(overrides: Partial<ScopedRegion> = {}): ScopedRegion {
  return {
    path: "src/widget.ts",
    startLine: 1,
    endLine: 3,
    changedLines: 1,
    contextTruncated: false,
    text: "+export function widget() {}\n-export function oldWidget() {}",
    ...overrides,
  };
}

describe("AC1: extractDocSections — deterministic, no model call", () => {
  test("splits by heading, nesting sub-headings inside the parent section", () => {
    const content = ["# Title", "", "intro text", "", "## First", "", "first body", "", "### Nested", "", "nested body", "", "## Second", "", "second body"].join(
      "\n",
    );
    const sections = extractDocSections("docs/x.md", content);
    const headings = sections.map((s) => s.heading);
    // No preamble section: "# Title" is itself the first heading, so there is
    // no non-heading content before it.
    expect(headings).toEqual(["Title", "First", "Nested", "Second"]);
    const first = sections.find((s) => s.heading === "First")!;
    expect(first.text).toContain("first body");
    // Flat, not nesting: "First"'s own text stops before "### Nested" starts —
    // a parent section never absorbs a child's content (see the function's
    // own header for why: it would double-report every finding at every
    // enclosing heading level).
    expect(first.text).not.toContain("nested body");
    expect(first.headingPath).toEqual(["Title", "First"]);
    const nested = sections.find((s) => s.heading === "Nested")!;
    expect(nested.text).toContain("nested body");
    expect(nested.headingPath).toEqual(["Title", "First", "Nested"]);
  });

  test("a headingless file is one section", () => {
    const sections = extractDocSections("README.md", "just some text\nmore text");
    expect(sections).toHaveLength(1);
    expect(sections[0]!.heading).toBe("");
  });

  test("an empty file yields no sections", () => {
    expect(extractDocSections("docs/empty.md", "")).toEqual([]);
    expect(extractDocSections("docs/empty.md", "   \n  \n")).toEqual([]);
  });
});

describe("AC1: extractDocLinks — explicit paths/flags/verbs/symbols", () => {
  test("finds a path, a flag, a keryx verb, and a backtick symbol", () => {
    const links = extractDocLinks(
      "See `src/review/jev-docs.ts` and run `keryx review jev-docs --max-calls 10`. The function `extractDocSections(` does the work.",
    );
    const kinds = links.map((l) => l.kind).sort();
    expect(kinds).toContain("path");
    expect(kinds).toContain("flag");
    expect(kinds).toContain("verb");
    expect(kinds).toContain("symbol");
    expect(links.find((l) => l.kind === "path")?.value).toBe("src/review/jev-docs.ts");
    expect(links.find((l) => l.kind === "flag")?.value).toBe("--max-calls");
    expect(links.find((l) => l.kind === "symbol")?.value).toBe("extractDocSections");
  });

  test("dedupes repeated mentions", () => {
    const links = extractDocLinks("`src/foo.ts` and again `src/foo.ts`");
    expect(links.filter((l) => l.kind === "path")).toHaveLength(1);
  });
});

describe("AC1: linkSectionsToDiff — path > symbol > verb, first match wins", () => {
  test("a section mentioning a changed path is linked via path", () => {
    const sections = extractDocSections("docs/widget.md", "## Widget\n\nSee `src/widget.ts` for details.");
    const linked = linkSectionsToDiff(sections, [region()]);
    expect(linked).toHaveLength(1);
    expect(linked[0]!.linkKind).toBe("path");
    expect(linked[0]!.linkedTo).toBe("src/widget.ts");
  });

  test("a headingless preamble is never linked (nothing to name in a finding)", () => {
    const sections = extractDocSections("docs/widget.md", "mentions `src/widget.ts` before any heading");
    const linked = linkSectionsToDiff(sections, [region()]);
    expect(linked).toEqual([]);
  });

  test("a section mentioning an unrelated path is not linked", () => {
    const sections = extractDocSections("docs/other.md", "## Other\n\nSee `src/unrelated.ts`.");
    expect(linkSectionsToDiff(sections, [region()])).toEqual([]);
  });

  test("linksToChangedPath finds the first matching path", () => {
    const links = extractDocLinks("`src/widget.ts` and `src/other.ts`");
    expect(linksToChangedPath(links, new Set(["src/other.ts"]))).toBe("src/other.ts");
    expect(linksToChangedPath(links, new Set(["src/nowhere.ts"]))).toBeUndefined();
  });

  test("a keryx verb mention links to the matching command file", () => {
    const sections = extractDocSections("docs/cli.md", "## Reviewing\n\nRun `keryx review jev-docs` to check.");
    const cmdRegion = region({ path: "src/commands/review.ts", text: "+export async function reviewCommand() {}" });
    const linked = linkSectionsToDiff(sections, [cmdRegion], new Set(["review"]));
    expect(linked).toHaveLength(1);
    expect(linked[0]!.linkKind).toBe("verb");
  });
});

describe("AC1: boundLinkedSections — --max-calls, truncation reported", () => {
  function fakeLinked(file: string, line: number): LinkedSection {
    return { section: { file, heading: "H", headingPath: ["H"], line, text: "text" }, linkKind: "path", linkedTo: file, relevantRegions: [] };
  }

  test("keeps a stable prefix and reports the rest as dropped", () => {
    const items = [fakeLinked("b.md", 5), fakeLinked("a.md", 3), fakeLinked("a.md", 1)];
    const result = boundLinkedSections(items, 2);
    expect(result.selected.map((i) => i.section.file)).toEqual(["a.md", "a.md"]);
    expect(result.dropped).toHaveLength(1);
    expect(result.maxCalls).toBe(2);
  });
});

describe("AC1: batchDocsSections — batches under the token budget", () => {
  test("one section makes one batch with one question", () => {
    const sections = extractDocSections("docs/widget.md", "## Widget\n\nSee `src/widget.ts`.");
    const linked = linkSectionsToDiff(sections, [region()]);
    const batches = batchDocsSections(linked);
    expect(batches).toHaveLength(1);
    expect(Object.keys(batches[0]!.questions)).toHaveLength(1);
    expect(batches[0]!.state).toContain("Widget");
  });

  test("no items makes no batches", () => {
    expect(batchDocsSections([])).toEqual([]);
  });
});

describe("AC2: synthesizeDocsFinding — Jev-scored", () => {
  test("above threshold produces a minor finding naming section and code change", () => {
    const sections = extractDocSections("docs/widget.md", "## Widget behaviour\n\nSee `src/widget.ts` for details.");
    const linked = linkSectionsToDiff(sections, [region()])[0]!;
    const finding = synthesizeDocsFinding(linked, 0.8, 0.5);
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("minor");
    expect(finding!.file).toBe("docs/widget.md");
    expect(finding!.reviewer).toBe("review-jev-docs");
    expect(finding!.problem).toContain("Widget behaviour");
    expect(finding!.problem).toContain("src/widget.ts");
  });

  test("below threshold produces no finding", () => {
    const sections = extractDocSections("docs/widget.md", "## Widget\n\nSee `src/widget.ts`.");
    const linked = linkSectionsToDiff(sections, [region()])[0]!;
    expect(synthesizeDocsFinding(linked, 0.2, 0.5)).toBeUndefined();
  });
});

describe("AC2: detectRemovedFlags / findDeterministicFlagFindings — no Jev call", () => {
  test("a flag present only on a removed line is detected as gone", () => {
    const r = region({
      path: "src/commands/review.ts",
      text: ["-  console.log(optionValue(args, \"--old-flag\"));", "+  console.log(optionValue(args, \"--new-flag\"));"].join("\n"),
    });
    const removed = detectRemovedFlags([r]);
    expect(removed.get("src/commands/review.ts")?.has("--old-flag")).toBe(true);
    expect(removed.get("src/commands/review.ts")?.has("--new-flag")).toBe(false);
  });

  test("a flag present on both removed and added lines is NOT reported gone (moved within the file)", () => {
    const r = region({
      path: "src/commands/review.ts",
      text: ["-  const x = 1; // --kept-flag", "+  const x = 2; // --kept-flag"].join("\n"),
    });
    expect(detectRemovedFlags([r]).size).toBe(0);
  });

  test("a doc section (untouched by the diff) still mentioning a removed flag is flagged deterministically", () => {
    const sections = extractDocSections("docs/cli.md", "## Usage\n\nRun with `--old-flag` to enable it.");
    const r = region({
      path: "src/commands/review.ts",
      text: "-  optionValue(args, \"--old-flag\");",
    });
    const removed = detectRemovedFlags([r]);
    const findings = findDeterministicFlagFindings(sections, removed, new Set(["src/commands/review.ts"]));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("minor");
    expect(findings[0]!.evidence).toContain("Deterministic");
  });

  test("a doc file the diff itself edited is not flagged (it is presumably already updated)", () => {
    const sections = extractDocSections("docs/cli.md", "## Usage\n\nRun with `--old-flag` to enable it.");
    const r = region({ path: "src/commands/review.ts", text: "-  optionValue(args, \"--old-flag\");" });
    const removed = detectRemovedFlags([r]);
    // docs/cli.md itself is in the changed-file set this time.
    const findings = findDeterministicFlagFindings(sections, removed, new Set(["src/commands/review.ts", "docs/cli.md"]));
    expect(findings).toEqual([]);
  });
});

describe("docsFindingStats / renderJevDocsMarkdown", () => {
  test("stats count every finding as minor", () => {
    const sections = extractDocSections("docs/widget.md", "## Widget\n\nSee `src/widget.ts`.");
    const linked = linkSectionsToDiff(sections, [region()])[0]!;
    const finding = synthesizeDocsFinding(linked, 0.9, 0.5)!;
    const stats = docsFindingStats([finding]);
    expect(stats).toEqual({ blocker: 0, major: 0, minor: 1, info: 0 });
  });

  test("renders a header and one section per finding", () => {
    const sections = extractDocSections("docs/widget.md", "## Widget\n\nSee `src/widget.ts`.");
    const linked = linkSectionsToDiff(sections, [region()])[0]!;
    const finding = synthesizeDocsFinding(linked, 0.9, 0.5)!;
    const markdown = renderJevDocsMarkdown({
      status: "DONE_WITH_CONCERNS",
      reviewer: "review-jev-docs",
      summary: "summary line",
      findings: [finding],
      stats: docsFindingStats([finding]),
    });
    expect(markdown).toContain("# review-jev-docs");
    expect(markdown).toContain("summary line");
    expect(markdown).toContain(finding.id);
  });

  test("renders a no-findings line when empty", () => {
    const markdown = renderJevDocsMarkdown({
      status: "DONE",
      reviewer: "review-jev-docs",
      summary: "nothing found",
      findings: [],
      stats: docsFindingStats([]),
    });
    expect(markdown).toContain("_no stale-doc findings");
  });
});
