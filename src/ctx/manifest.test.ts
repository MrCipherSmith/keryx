import { expect, test } from "bun:test";
import { buildLossManifest, MANIFEST_MAX_ENTRIES, renderLossManifest } from "./manifest";
import { compactLines } from "./lines";

const ADDRESS = ".metaproject/data/gdctx/raw/2026-01-01T00-00-00-000Z_read.log";

test("an empty manifest renders nothing", () => {
  const manifest = buildLossManifest([], ADDRESS);
  expect(manifest.truncated).toBe(false);
  expect(manifest.totalRanges).toBe(0);
  expect(renderLossManifest(manifest)).toBe("");
});

test("each entry carries the command that returns exactly that range", () => {
  const manifest = buildLossManifest([{ start: 121, end: 2_500 }], ADDRESS);
  expect(manifest.omittedLines).toBe(2_380);
  expect(manifest.entries[0]?.recover).toBe(`keryx ctx show ${ADDRESS} --raw --lines 121-2500`);
  expect(renderLossManifest(manifest)).toContain("- lines 121-2500 (2380)");
});

// AC4: "усечение manifest видно". A manifest listing 12 of 63 omitted ranges
// with no note is the same defect the manifest exists to fix, one level up.
test("a manifest that is itself shortened says so, and says by how much", () => {
  const ranges = Array.from({ length: 40 }, (_, i) => ({ start: i * 10 + 1, end: i * 10 + 5 }));
  const manifest = buildLossManifest(ranges, ADDRESS);

  expect(manifest.entries.length).toBe(MANIFEST_MAX_ENTRIES);
  expect(manifest.truncated).toBe(true);
  expect(manifest.omittedEntries).toBe(40 - MANIFEST_MAX_ENTRIES);
  expect(renderLossManifest(manifest)).toContain(
    `manifest truncated: ${40 - MANIFEST_MAX_ENTRIES} of 40 omitted ranges are not listed`,
  );
});

test("the ranges it keeps are the largest ones, listed in source order", () => {
  const manifest = buildLossManifest(
    [
      { start: 10, end: 11 },
      { start: 20, end: 100 },
      { start: 200, end: 210 },
    ],
    ADDRESS,
    2,
  );
  expect(manifest.entries.map((entry) => entry.start)).toEqual([20, 200]);
  expect(manifest.truncated).toBe(true);
});

// The ranges have to describe the body that was actually produced, or the
// recovery command returns the wrong lines — a worse failure than no manifest.
test("compactLines reports omitted ranges that exclude the lines it rescued", () => {
  const lines = Array.from({ length: 1_000 }, (_, i) =>
    i === 500 ? "not ok 500 - the middle failure" : `ok ${i}`,
  );
  const compaction = compactLines(lines, 200, 60);

  expect(compaction.lines).toContain("not ok 500 - the middle failure");
  // The rescued line sits at source line 501 and is NOT inside any omitted
  // range: it is in the body.
  for (const range of compaction.omittedRanges) {
    expect(range.start <= 501 && 501 <= range.end).toBe(false);
  }
  // Every omitted line is accounted for exactly once.
  const covered = compaction.omittedRanges.reduce(
    (total, range) => total + (range.end - range.start + 1),
    0,
  );
  expect(covered).toBe(compaction.omitted);
});

test("a compaction that rescued nothing reports one contiguous omitted range", () => {
  const lines = Array.from({ length: 1_000 }, (_, i) => `ok ${i}`);
  const compaction = compactLines(lines, 200, 60);
  expect(compaction.omittedRanges.length).toBe(1);
  expect(compaction.omittedRanges[0]).toEqual({ start: 91, end: 910 });
});
