import { describe, expect, test } from "bun:test";
import { renderScopedDiff, buildReviewScope } from "./scope";
import {
  DEFAULT_SLICE_MAX_BYTES,
  buildSlices,
  byteLength,
  classifyLedger,
  looksLikeScopedDiff,
  parseScopedDiff,
  resliceText,
  sliceDomainOf,
  sliceSourceFromDiff,
} from "./slice";

function gitFile(filePath: string, lines: string[]): string {
  return [
    `diff --git a/${filePath} b/${filePath}`,
    "index 111..222 100644",
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -1,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
    "",
  ].join("\n");
}

function csvLedger(filePath: string, bytes: number): string {
  const row = "2026-10-01,account-000123,debit,19.99,EUR,settled";
  const lines: string[] = [];
  let size = 0;
  while (size < bytes) {
    lines.push(row);
    size += row.length + 2;
  }
  return gitFile(filePath, lines);
}

describe("classifyLedger", () => {
  test("names the reason for each ledger kind", () => {
    expect(classifyLedger("data/ledger.csv", 10)?.reason).toBe("data-ledger");
    expect(classifyLedger("bun.lock", 10)?.reason).toBe("lockfile");
    expect(classifyLedger("src/__snapshots__/a.snap", 10)?.reason).toBe("snapshot");
    expect(classifyLedger("public/app.min.js", 10)?.reason).toBe("generated");
    expect(classifyLedger("test/fixtures/big.json", 30_000)?.reason).toBe("large-json");
    expect(classifyLedger("package.json", 500)).toBeNull();
    expect(classifyLedger("src/a.ts", 10)).toBeNull();
  });
});

describe("sliceDomainOf", () => {
  test("keeps tests, docs and config apart from the code they sit beside", () => {
    expect(sliceDomainOf("src/review/a.ts")).toBe("src/review");
    expect(sliceDomainOf("src/review/a.test.ts")).toBe("src/review [test]");
    expect(sliceDomainOf("docs/x.md")).toBe("docs [docs]");
    expect(sliceDomainOf("README.md")).toBe(". [docs]");
  });
});

describe("scoped diff round trip", () => {
  test("parseScopedDiff reads back what renderScopedDiff wrote", () => {
    const scope = buildReviewScope(gitFile("src/a.ts", ["one", "two"]) + gitFile("src/b.ts", ["three"]));
    const text = renderScopedDiff(scope);
    expect(looksLikeScopedDiff(text)).toBe(true);
    const regions = parseScopedDiff(text);
    expect(regions.map((region) => region.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(regions[0]?.text).toContain("+one");
  });

  test("a git diff is not mistaken for a scoped diff", () => {
    expect(looksLikeScopedDiff(gitFile("src/a.ts", ["x"]))).toBe(false);
    expect(sliceSourceFromDiff(gitFile("src/a.ts", ["x"])).source).toBe("diff");
  });
});

describe("buildSlices", () => {
  test("a ~1.6 MB diff with CSV ledgers yields slices that all fit and omits the ledgers by name", () => {
    const parts: string[] = [];
    for (const name of ["a", "b", "c"]) {
      parts.push(csvLedger(`data/${name}-ledger.csv`, 380_000));
    }
    for (let index = 0; index < 60; index += 1) {
      const dir = index % 3 === 0 ? "src/alpha" : index % 3 === 1 ? "src/beta" : "src/gamma";
      parts.push(gitFile(`${dir}/file${index}.ts`, Array.from({ length: 300 }, (_, n) => `const value${index}_${n} = ${n};`)));
    }
    const diff = parts.join("");
    expect(byteLength(diff)).toBeGreaterThan(1_400_000);

    const source = sliceSourceFromDiff(diff);
    const { manifest, slices } = buildSlices(source);

    expect(slices.length).toBeGreaterThan(1);
    for (const slice of slices) {
      expect(slice.bytes).toBeLessThanOrEqual(DEFAULT_SLICE_MAX_BYTES);
      expect(byteLength(slice.text)).toBe(slice.bytes);
    }
    const omitted = manifest.omissions.map((omission) => omission.path).sort();
    expect(omitted).toEqual(["data/a-ledger.csv", "data/b-ledger.csv", "data/c-ledger.csv"]);
    expect(manifest.omissions.every((omission) => omission.reason === "data-ledger" && omission.bytes > 300_000)).toBe(true);
    const sliced = new Set(slices.flatMap((slice) => slice.files));
    expect(sliced.size).toBe(60);
    expect(manifest.totals.slices).toBe(slices.length);
    expect(manifest.totals.omittedFiles).toBe(3);
  });

  test("a small diff is one slice", () => {
    const { slices } = buildSlices(sliceSourceFromDiff(gitFile("src/a.ts", ["x"]) + gitFile("src/b.ts", ["y"])));
    expect(slices).toHaveLength(1);
    expect(slices[0]?.id).toBe("slice-01");
    expect(slices[0]?.split).toBe("domain");
  });

  test("a domain bigger than the ceiling is cut by file", () => {
    const diff = Array.from({ length: 6 }, (_, index) =>
      gitFile(`src/big/f${index}.ts`, Array.from({ length: 40 }, (_, n) => `const x${index}_${n} = ${n};`)),
    ).join("");
    const { slices } = buildSlices(sliceSourceFromDiff(diff), { maxBytes: 2_500 });
    expect(slices.length).toBeGreaterThan(1);
    for (const slice of slices) {
      expect(slice.bytes).toBeLessThanOrEqual(2_500);
    }
    expect(slices.some((slice) => slice.split === "file")).toBe(true);
  });

  test("one oversize file is cut by hunk and every piece fits", () => {
    const lines = Array.from({ length: 800 }, (_, n) => `export const row${n} = "${"x".repeat(40)}";`);
    const { slices, manifest } = buildSlices(sliceSourceFromDiff(gitFile("src/huge.ts", lines)), { maxBytes: 4_000 });
    expect(slices.length).toBeGreaterThan(5);
    for (const slice of slices) {
      expect(slice.bytes).toBeLessThanOrEqual(4_000);
      expect(slice.split).toBe("hunk");
      expect(slice.files).toEqual(["src/huge.ts"]);
      expect(slice.text.startsWith("--- src/huge.ts\n@@ ")).toBe(true);
    }
    const joined = slices.map((slice) => slice.text).join("");
    for (const n of [0, 399, 799]) {
      expect(joined).toContain(`row${n} =`);
    }
    expect(manifest.omissions).toHaveLength(0);
  });

  test("a single line longer than the ceiling is chunked rather than exceeded", () => {
    const { slices } = buildSlices(sliceSourceFromDiff(gitFile("src/one.ts", ["y".repeat(9_000)])), { maxBytes: 1_000 });
    expect(slices.length).toBeGreaterThan(8);
    for (const slice of slices) {
      expect(slice.bytes).toBeLessThanOrEqual(1_000);
    }
  });

  test("scope drops of a whole file become omissions with their reason", () => {
    const diff = gitFile("src/a.ts", ["x"]) + gitFile("bun.lock", ["lock"]);
    const { manifest } = buildSlices(sliceSourceFromDiff(diff));
    expect(manifest.omissions.map((omission) => omission.path)).toContain("bun.lock");
  });

  test("a ceiling below the minimum is refused", () => {
    expect(() => buildSlices({ regions: [], drops: [] }, { maxBytes: 10 })).toThrow(/Invalid --max-bytes/);
  });

  test("resliceText cuts slice text at a smaller ceiling and keeps every file", () => {
    const { slices } = buildSlices(
      sliceSourceFromDiff(
        Array.from({ length: 4 }, (_, index) => gitFile(`src/m/f${index}.ts`, Array.from({ length: 40 }, (_, n) => `const q${index}_${n} = ${n};`))).join(""),
      ),
    );
    expect(slices).toHaveLength(1);
    const smaller = resliceText(slices[0]!.text, Math.floor(slices[0]!.bytes / 2), { prefix: "r1-x" });
    expect(smaller.length).toBeGreaterThan(1);
    expect(smaller[0]?.id).toBe("r1-x-01");
    expect(new Set(smaller.flatMap((slice) => slice.files)).size).toBe(4);
  });
});
