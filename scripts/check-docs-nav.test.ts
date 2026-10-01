import { describe, expect, test } from "bun:test";
import { isExcluded, matchesPattern, orphans, parseMkdocs } from "./check-docs-nav";

const YAML = `site_name: x
docs_dir: docs/docs
exclude_docs: |
  README.md
not_in_nav: |
  # a comment
  old/*.md
nav:
  # comment
  - Home: index.md
  - Guides:
      - Set up:
          - "Quoted: title": guides/a.md
          - B: guides/b.md
  - Reference: reference/
`;

describe("parseMkdocs", () => {
  test("reads docs_dir, nav pages at any depth, and both exclusion blocks", () => {
    const cfg = parseMkdocs(YAML);
    expect(cfg.docsDir).toBe("docs/docs");
    expect([...cfg.nav].sort()).toEqual(["guides/a.md", "guides/b.md", "index.md"]);
    expect(cfg.patterns).toEqual(["README.md", "old/*.md"]);
  });
});

describe("matchesPattern", () => {
  test("matches exact paths, globs and directory prefixes", () => {
    expect(matchesPattern("README.md", "README.md")).toBe(true);
    expect(matchesPattern("old/x.md", "old/*.md")).toBe(true);
    expect(matchesPattern("old/x.md", "old/")).toBe(true);
    expect(matchesPattern("new/x.md", "old/*.md")).toBe(false);
  });
});

describe("orphans", () => {
  test("reports a page that is neither in the nav nor excluded", () => {
    const cfg = parseMkdocs(YAML);
    const files = ["index.md", "guides/a.md", "README.md", "old/x.md", "stray.md"];
    expect(orphans(files, cfg)).toEqual(["stray.md"]);
  });
});

describe("negation (gitignore semantics)", () => {
  test("a lone !pattern excludes nothing, so an orphan is still reported", () => {
    const cfg = parseMkdocs(`docs_dir: docs
exclude_docs: |
  !keep-me.md
nav:
  - Home: index.md
`);
    expect(orphans(["index.md", "keep-me.md", "stray.md"], cfg)).toEqual(["keep-me.md", "stray.md"]);
  });

  test("!pattern re-includes a file an earlier pattern excluded; last match wins", () => {
    expect(isExcluded("drafts/keep.md", ["drafts/", "!drafts/keep.md"])).toBe(false);
    expect(isExcluded("drafts/other.md", ["drafts/", "!drafts/keep.md"])).toBe(true);
    expect(isExcluded("drafts/keep.md", ["drafts/", "!drafts/keep.md", "drafts/*.md"])).toBe(true);
  });

  test("a negation in one block does not re-include a file the other block excludes", () => {
    const cfg = parseMkdocs(`docs_dir: docs
exclude_docs: |
  !old/x.md
not_in_nav: |
  old/*.md
nav:
  - Home: index.md
`);
    expect(orphans(["index.md", "old/x.md"], cfg)).toEqual([]);
  });

  test("matchesPattern refuses a negated pattern instead of matching everything", () => {
    expect(() => matchesPattern("guide.md", "!keep.md")).toThrow();
    expect(matchesPattern("!odd.md", "\\!odd.md")).toBe(true);
  });
});
