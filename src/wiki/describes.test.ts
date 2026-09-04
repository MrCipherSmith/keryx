// LWG-1 describe-set resolution (flow 223, phase 0). Covers flow AC4 —
// frontmatter > related-code > key-files precedence — plus the two outcomes
// this module exists to keep distinct: a page that names nothing, and a page
// that names files which are gone.

import { describe, expect, test } from "bun:test";
import {
  matchPattern,
  parseDescribesField,
  parseRelatedCodePaths,
  resolveDescribeSet,
} from "./describes";

const KNOWN = new Set([
  "src/ctx/index.ts",
  "src/ctx/run.ts",
  "src/ctx/nested/deep.ts",
  "src/wiki/service.ts",
  "src/wiki/collect.ts",
  "docs/readme.md",
]);

const EMPTY_KEY_FILES = new Map<string, string[]>();

function resolve(content: string, keyFiles = EMPTY_KEY_FILES) {
  return resolveDescribeSet({
    page: { relativePath: "components/src-ctx.md" },
    content,
    knownPaths: KNOWN,
    keyFilesIndex: keyFiles,
  });
}

describe("parseDescribesField", () => {
  test("reads a block list and stops at the first non-list line", () => {
    const content = [
      "# Page",
      "Describes:",
      "  - src/ctx/index.ts",
      "  - `src/ctx/run.ts`",
      "",
      "## Overview",
      "  - not a describes entry",
    ].join("\n");
    expect(parseDescribesField(content)).toEqual(["src/ctx/index.ts", "src/ctx/run.ts"]);
  });

  test("reads the inline comma-separated form", () => {
    expect(parseDescribesField("Describes: src/ctx/index.ts, src/ctx/run.ts")).toEqual([
      "src/ctx/index.ts",
      "src/ctx/run.ts",
    ]);
  });

  test("absent field yields nothing", () => {
    expect(parseDescribesField("# Page\nVersion: 1.0.0\n")).toEqual([]);
  });
});

describe("parseRelatedCodePaths", () => {
  test("extracts backticked and linked paths, ignoring prose and the placeholder", () => {
    const content = [
      "## Related Code",
      "",
      "- `src/wiki/service.ts` - the collector",
      "- [collect](src/wiki/collect.ts)",
      "- some explanatory sentence with no path",
      "",
      "## Related Wiki",
      "- `src/should/not/appear.ts`",
    ].join("\n");
    expect(parseRelatedCodePaths(content)).toEqual([
      "src/wiki/service.ts",
      "src/wiki/collect.ts",
    ]);
  });

  test("the generated placeholder contributes nothing", () => {
    const content = "## Related Code\n\n- (none recorded automatically — add manually if relevant)\n";
    expect(parseRelatedCodePaths(content)).toEqual([]);
  });
});

describe("matchPattern", () => {
  test("a bare directory covers everything beneath it", () => {
    expect(matchPattern("src/ctx", KNOWN)).toEqual([
      "src/ctx/index.ts",
      "src/ctx/nested/deep.ts",
      "src/ctx/run.ts",
    ]);
  });

  test("* does not cross a path separator, ** does", () => {
    expect(matchPattern("src/ctx/*.ts", KNOWN)).toEqual(["src/ctx/index.ts", "src/ctx/run.ts"]);
    expect(matchPattern("src/ctx/**", KNOWN)).toEqual([
      "src/ctx/index.ts",
      "src/ctx/nested/deep.ts",
      "src/ctx/run.ts",
    ]);
  });

  test("**/ also matches zero directories", () => {
    expect(matchPattern("src/ctx/**/*.ts", KNOWN)).toEqual([
      "src/ctx/index.ts",
      "src/ctx/nested/deep.ts",
      "src/ctx/run.ts",
    ]);
  });

  test("an unmatched pattern resolves to nothing rather than throwing", () => {
    expect(matchPattern("src/gone/**", KNOWN)).toEqual([]);
  });
});

describe("resolveDescribeSet precedence (flow AC4)", () => {
  const keyFiles = new Map([["components/src-ctx.md", ["src/wiki/collect.ts"]]]);

  test("frontmatter wins and REPLACES, it does not merge", () => {
    const content = [
      "Describes:",
      "  - src/ctx/index.ts",
      "",
      "## Related Code",
      "- `src/wiki/service.ts`",
    ].join("\n");
    const result = resolve(content, keyFiles);
    expect(result.origin).toBe("frontmatter");
    expect(result.paths).toEqual(["src/ctx/index.ts"]);
  });

  test("related-code wins over key-files when there is no frontmatter", () => {
    const content = "## Related Code\n- `src/wiki/service.ts`\n";
    const result = resolve(content, keyFiles);
    expect(result.origin).toBe("related-code");
    expect(result.paths).toEqual(["src/wiki/service.ts"]);
  });

  test("key-files is the fallback for an untouched generated page", () => {
    const result = resolve("# Page\nStatus: draft\n", keyFiles);
    expect(result.origin).toBe("key-files");
    expect(result.paths).toEqual(["src/wiki/collect.ts"]);
  });
});

describe("resolveDescribeSet outcomes that must stay distinct", () => {
  test("a page naming nothing is undecidable, not fresh and not orphaned", () => {
    const result = resolve("# Architecture\nStatus: accepted\n");
    expect(result.undecidable).toBe(true);
    expect(result.origin).toBeUndefined();
    expect(result.entries).toEqual([]);
    expect(result.paths).toEqual([]);
  });

  test("a page naming files that are gone keeps its origin and reports the broken pattern", () => {
    const result = resolve("Describes:\n  - src/deleted/module.ts\n");
    // Precedence is NOT surrendered to key-files: silently substituting a
    // derived set would hide that the author's list is broken.
    expect(result.origin).toBe("frontmatter");
    expect(result.undecidable).toBe(true);
    expect(result.entries).toEqual([
      { pattern: "src/deleted/module.ts", origin: "frontmatter", resolvedPaths: [] },
    ]);
  });

  test("a broken frontmatter list does not fall through to key-files", () => {
    const keyFiles = new Map([["components/src-ctx.md", ["src/wiki/collect.ts"]]]);
    const result = resolve("Describes:\n  - src/deleted/module.ts\n", keyFiles);
    expect(result.paths).toEqual([]);
    expect(result.origin).toBe("frontmatter");
  });

  test("resolved paths are deduplicated and sorted", () => {
    const content = [
      "Describes:",
      "  - src/ctx/run.ts",
      "  - src/ctx",
      "  - src/ctx/run.ts",
    ].join("\n");
    expect(resolve(content).paths).toEqual([
      "src/ctx/index.ts",
      "src/ctx/nested/deep.ts",
      "src/ctx/run.ts",
    ]);
  });
});
