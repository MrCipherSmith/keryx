import { describe, expect, test } from "bun:test";
import { diffLines, diffStats, looksLikeUnifiedDiff } from "./unifiedDiff";

const GIT_DIFF = [
  "diff --git a/src/x.ts b/src/x.ts",
  "index 1111111..2222222 100644",
  "--- a/src/x.ts",
  "+++ b/src/x.ts",
  "@@ -1,4 +1,4 @@",
  " const a = 1;",
  "--- a removed line that starts with two dashes",
  "+++ an added line that starts with two pluses",
  " const c = 3;",
  " const d = 4;",
  "\\ No newline at end of file",
].join("\n");

describe("diffLines", () => {
  test("reads headers outside a hunk and +/- lines inside one by the hunk's counts", () => {
    expect(diffLines(GIT_DIFF).map((l) => l.kind)).toEqual(["meta", "meta", "meta", "meta", "hunk", "ctx", "del", "add", "ctx", "ctx", "meta"]);
  });

  test("a second file's headers after the first hunk ends are headers again", () => {
    const two = ["--- a/one", "+++ b/one", "@@ -1 +1 @@", "-x", "+y", "--- a/two", "+++ b/two", "@@ -1 +1 @@", "-p", "+q"].join("\n");
    expect(diffLines(two).map((l) => l.kind)).toEqual(["meta", "meta", "hunk", "del", "add", "meta", "meta", "hunk", "del", "add"]);
  });

  test("diffStats counts added and removed lines", () => {
    expect(diffStats(diffLines(GIT_DIFF))).toEqual({ added: 1, removed: 1 });
  });
});

describe("looksLikeUnifiedDiff", () => {
  test("accepts a git diff and bare hunks", () => {
    expect(looksLikeUnifiedDiff(GIT_DIFF)).toBe(true);
    expect(looksLikeUnifiedDiff("@@ -1,2 +1,2 @@\n a\n-b\n+c\n")).toBe(true);
  });

  test("rejects prose, lists and text that only mentions @@", () => {
    expect(looksLikeUnifiedDiff("- item one\n- item two\n+ plus")).toBe(false);
    expect(looksLikeUnifiedDiff("the hunk header looks like @@ -1 +1 @@ in docs")).toBe(false);
    expect(looksLikeUnifiedDiff("@@ -1 +1 @@\nnot a diff line\n")).toBe(false);
  });
});
