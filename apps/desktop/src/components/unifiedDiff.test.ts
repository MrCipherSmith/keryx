import { describe, expect, test } from "bun:test";
import { diffLines, diffStats, looksLikeUnifiedDiff, numberedDiffLines } from "./unifiedDiff";

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

describe("numberedDiffLines", () => {
  test("counts old and new lines from each hunk header for a modified file", () => {
    const numbered = numberedDiffLines(
      ["diff --git a/x.ts b/x.ts", "--- a/x.ts", "+++ b/x.ts", "@@ -3,3 +3,4 @@", " keep", "-gone", "+new one", "+new two", " tail", "@@ -20 +21 @@", "-old", "+new"].join("\n"),
    );
    const pick = (i: number) => [numbered[i]!.kind, numbered[i]!.oldNo, numbered[i]!.newNo];
    expect(pick(0)).toEqual(["meta", undefined, undefined]);
    expect(pick(3)).toEqual(["hunk", undefined, undefined]);
    expect(pick(4)).toEqual(["ctx", 3, 3]);
    expect(pick(5)).toEqual(["del", 4, undefined]);
    expect(pick(6)).toEqual(["add", undefined, 4]);
    expect(pick(7)).toEqual(["add", undefined, 5]);
    expect(pick(8)).toEqual(["ctx", 5, 6]);
    expect(pick(10)).toEqual(["del", 20, undefined]);
    expect(pick(11)).toEqual(["add", undefined, 21]);
  });

  test("a deleted file carries old-side numbers only", () => {
    const numbered = numberedDiffLines(["--- a/gone.ts", "+++ /dev/null", "@@ -1,3 +0,0 @@", "-one", "-two", "-three"].join("\n"));
    const body = numbered.filter((l) => l.kind === "del");
    expect(body.map((l) => l.oldNo)).toEqual([1, 2, 3]);
    expect(body.every((l) => l.newNo === undefined)).toBe(true);
  });

  test("an added file carries new-side numbers only", () => {
    const body = numberedDiffLines(["@@ -0,0 +1,2 @@", "+a", "+b"].join("\n")).filter((l) => l.kind === "add");
    expect(body.map((l) => l.newNo)).toEqual([1, 2]);
    expect(body.every((l) => l.oldNo === undefined)).toBe(true);
  });
});
