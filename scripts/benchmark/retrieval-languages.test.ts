import { describe, expect, test } from "bun:test";
import { isTestFile, SOURCE_EXTENSIONS, SOURCE_FILE, sourcePathPattern } from "./retrieval-languages";

describe("isTestFile", () => {
  test("excludes tests in every language's own convention", () => {
    // Gold sets exclude tests. That was true for TypeScript and silently false
    // for the rest: the first Java task drawn had three *IT.java files in a gold
    // set of seven, so the same measurement scored TypeScript against production
    // code and Java against production code plus its integration suite.
    for (const path of [
      "src/a.test.ts",
      "src/a.spec.tsx",
      "src/test/java/io/dev/FooIT.java",
      "backend/src/test/java/io/dev/BarTest.java",
      "app/BazTests.java",
      "app/QuxITCase.java",
      "pkg/test_thing.py",
      "pkg/thing_test.py",
      "tests/helpers.py",
    ]) {
      expect(isTestFile(path)).toBe(true);
    }
  });

  test("keeps production code, including files whose names merely contain the words", () => {
    for (const path of [
      "src/main/java/io/dev/DataSourceService.java",
      "src/tui/tui-shell.ts",
      "src/latest/contest.ts",
      "src/protests/index.ts",
    ]) {
      expect(isTestFile(path)).toBe(false);
    }
  });
});

describe("the source-language list", () => {
  test("covers every language gdgraph indexes", () => {
    // src/gdgraph/build.ts builds over these. Measuring retrieval on a language
    // the graph cannot see asks the context arm to show an advantage it
    // structurally does not have, and scores the resulting nothing against
    // keryx. This is why vantage-backend yielded zero tasks at first: 4,204 Java
    // files against a benchmark that only knew TypeScript.
    for (const ext of ["ts", "tsx", "js", "jsx", "java", "py"]) {
      expect(SOURCE_EXTENSIONS).toContain(ext);
    }
  });

  test("the file test and the prose extractor agree on every extension", () => {
    // They used to be two hand-written lists and had already drifted: the
    // extractor took .mjs but not .cjs, the scorer took both, so a gold file one
    // side rejected could still be matched by the other.
    for (const ext of SOURCE_EXTENSIONS) {
      expect(SOURCE_FILE.test(`src/a.${ext}`)).toBe(true);
      const found = [...`see src/a.${ext} for details`.matchAll(sourcePathPattern())];
      expect(found.map((m) => m[0])).toEqual([`src/a.${ext}`]);
    }
  });

  test("does not match documents, data or configuration", () => {
    for (const path of ["README.md", "package.json", "schema.sql", "styles.css", "pom.xml"]) {
      expect(SOURCE_FILE.test(path)).toBe(false);
    }
  });

  test("finds absolute paths with the leading slash intact", () => {
    // Without it the prefix strip against the worktree root fails and a correct
    // answer scores as a miss.
    const found = [...`the file is /tmp/wt-1/src/Main.java`.matchAll(sourcePathPattern())];
    expect(found[0]?.[0]).toBe("/tmp/wt-1/src/Main.java");
  });

  test("a fresh pattern each call, so lastIndex cannot leak between scorings", () => {
    expect(sourcePathPattern()).not.toBe(sourcePathPattern());
    expect(sourcePathPattern().lastIndex).toBe(0);
  });
});
