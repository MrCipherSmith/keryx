import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { artifactDirectories, findKnownExcerpt, readKnown } from "./project-artifacts";

test("reads bounded previews and Unicode excerpts from a regular artifact in a nested directory", () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "review-artifact-")));
  try {
    const nested = path.join(root, "project", "reports");
    mkdirSync(nested, { recursive: true });
    const file = path.join(nested, "report.md");
    writeFileSync(file, "a".repeat(65535) + "проверено marker");
    expect([...artifactDirectories(root)]).toEqual([path.join(root, "project")]);
    expect([...artifactDirectories(nested)]).toEqual([]);
    expect(readKnown(file, 5)).toBeUndefined();
    expect(readKnown(file, 6, "tail")?.text).toBe("… marker");
    expect(findKnownExcerpt(file, "ПРОВЕРЕНО", 30)).toContain("проверено marker");
    expect(readKnown(nested, 256)).toBeUndefined();
    expect(findKnownExcerpt(nested, "marker", 30)).toBe("");
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test.skipIf(!["darwin", "linux"].includes(process.platform))("skips local aliases and a named pipe without reading their contents", () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "review-artifact-types-")));
  try {
    const folder = path.join(root, "records");
    mkdirSync(folder);
    writeFileSync(path.join(folder, "report.md"), "local fixture");
    symlinkSync("records", path.join(root, "alias"));
    symlinkSync("report.md", path.join(folder, "copy"));
    const pipe = path.join(folder, "notify");
    execFileSync("mkfifo", [pipe]);
    for (const file of [path.join(root, "alias", "report.md"), path.join(folder, "copy"), pipe]) {
      expect(readKnown(file, 100)).toBeUndefined();
      expect(findKnownExcerpt(file, "fixture", 30)).toBe("");
    }
    expect([...artifactDirectories(path.join(root, "alias"))]).toEqual([]);
    expect([...artifactDirectories(root)]).toEqual([folder]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
