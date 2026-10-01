import { describe, expect, test } from "bun:test";
import { matchesPattern, orphans, parseMkdocs } from "./check-docs-nav";

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
