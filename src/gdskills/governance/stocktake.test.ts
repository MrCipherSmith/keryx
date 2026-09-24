import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertReasonsSpecific, runStocktake, type StocktakeReport } from "./stocktake";

function withTempRoot<T>(fn: (root: string) => T): T {
  const root = mkdtempSync(path.join(tmpdir(), "stocktake-"));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("runStocktake", () => {
  test("every entry carries a non-empty, skill-specific reason (never reused verbatim)", () => {
    withTempRoot((root) => {
      const report = runStocktake(root, { scope: "bundled", quick: true, now: () => new Date("2026-01-01T00:00:00.000Z") });
      expect(report.entries.length).toBeGreaterThan(50);
      for (const entry of report.entries) {
        expect(entry.reason.length).toBeGreaterThan(0);
      }
      expect(() => assertReasonsSpecific(report)).not.toThrow();
    });
  }, 20_000);

  test("writes the dated report and the cache under .metaproject/data/skills/stocktake", () => {
    withTempRoot((root) => {
      const report = runStocktake(root, { scope: "bundled", quick: true, now: () => new Date("2026-03-15T12:00:00.000Z") });
      const reportPath = path.join(root, ".metaproject", "data", "skills", "stocktake", "2026-03-15.json");
      const cachePath = path.join(root, ".metaproject", "data", "skills", "stocktake", "cache.json");
      const onDisk = JSON.parse(readFileSync(reportPath, "utf8")) as StocktakeReport;
      expect(onDisk.entries.length).toBe(report.entries.length);
      expect(JSON.parse(readFileSync(cachePath, "utf8"))).toBeDefined();
    });
  }, 20_000);

  test("a second run reuses the cache (hits > 0, misses 0)", () => {
    withTempRoot((root) => {
      runStocktake(root, { scope: "bundled", quick: true, now: () => new Date("2026-01-01T00:00:00.000Z") });
      const second = runStocktake(root, { scope: "bundled", quick: true, now: () => new Date("2026-01-02T00:00:00.000Z") });
      expect(second.cache.hits).toBeGreaterThan(0);
      expect(second.cache.misses).toBe(0);
    });
  }, 20_000);
});

describe("assertReasonsSpecific", () => {
  test("throws when the same reason is reused across two different skills", () => {
    const report: StocktakeReport = {
      schemaVersion: "1.0.0",
      generatedAt: "2026-01-01T00:00:00.000Z",
      scope: "bundled",
      entries: [
        { skillId: "a/one", verdict: "keep", reason: "generic reason", evidence: {} },
        { skillId: "a/two", verdict: "keep", reason: "generic reason", evidence: {} },
      ],
      cache: { hits: 0, misses: 2 },
    };
    expect(() => assertReasonsSpecific(report)).toThrow();
  });

  test("does not throw when the same skill repeats its own reason", () => {
    const report: StocktakeReport = {
      schemaVersion: "1.0.0",
      generatedAt: "2026-01-01T00:00:00.000Z",
      scope: "bundled",
      entries: [{ skillId: "a/one", verdict: "keep", reason: "a/one: fine", evidence: {} }],
      cache: { hits: 0, misses: 1 },
    };
    expect(() => assertReasonsSpecific(report)).not.toThrow();
  });
});
