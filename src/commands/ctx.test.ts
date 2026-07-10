import { expect, test } from "bun:test";
import { rgListMode, summarizeRgFileList } from "./ctx";

const CONFIG = {
  maxOutputLines: 120,
  maxImportantLines: 60,
  maxGroupItems: 12,
  compactHeadLines: 120,
  compactTailLines: 80,
  outlineMaxEntries: 160,
};

function result(raw: string) {
  return { stdout: raw, stderr: "", raw, exitCode: 0 };
}

test("rgListMode detects file-listing and count flags", () => {
  expect(rgListMode(["foo", "--files-with-matches"])).toBe("files");
  expect(rgListMode(["foo", "-l"])).toBe("files");
  expect(rgListMode(["foo", "--files"])).toBe("files");
  expect(rgListMode(["foo", "--count"])).toBe("count");
  expect(rgListMode(["foo", "-c"])).toBe("count");
  expect(rgListMode(["foo", "src/"])).toBeNull(); // normal match search
});

test("summarizeRgFileList lists real paths, not (unknown) 0:0 garbage", () => {
  const raw = "src/a.ts\nsrc/b.ts\nsrc/c.ts";
  const out = summarizeRgFileList("rg --no-heading foo -l", result(raw), CONFIG, "files");
  expect(out).toContain("Files: `3`");
  expect(out).toContain("- src/a.ts");
  expect(out).toContain("- src/c.ts");
  // the old bug's tells must be gone
  expect(out).not.toContain("(unknown)");
  expect(out).not.toContain("0:0");
});

test("summarizeRgFileList handles --count output (path:count)", () => {
  const out = summarizeRgFileList("rg --count foo", result("src/a.ts:3\nsrc/b.ts:1"), CONFIG, "count");
  expect(out).toContain("path:count");
  expect(out).toContain("- src/a.ts:3");
});
