import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  // F6 (flow 309 review round 1): the cache used to be keyed on ONLY the
  // skill's own SKILL.md sha256, so it kept serving a stale verdict when a
  // DIFFERENT input the verdict depends on changed — a new neighbour skill
  // (the merge/overlap check scores against the whole catalog) or a
  // verification report (the `update` verdict). Both must invalidate the
  // cache even though the skill's own SKILL.md content never moved.
  test("adding a new catalog entry invalidates every other entry's cache row (neighbour-dependent verdicts)", () => {
    withTempRoot((root) => {
      const first = runStocktake(root, { scope: "all", quick: true, now: () => new Date("2026-01-01T00:00:00.000Z") });
      expect(first.cache.misses).toBeGreaterThan(0);

      const newSkillDir = path.join(root, ".metaproject", "project-skills", "project", "brand-new-project-skill");
      mkdirSync(newSkillDir, { recursive: true });
      writeFileSync(
        path.join(newSkillDir, "SKILL.md"),
        "---\nname: brand-new-project-skill\ndescription: Use when testing cache invalidation on a new neighbour.\n---\nBody.\n",
        "utf8",
      );

      const second = runStocktake(root, { scope: "all", quick: true, now: () => new Date("2026-01-02T00:00:00.000Z") });
      // Every previously-cached row's catalogFingerprint changed (a new
      // entry now exists in the corpus every scout/overlap check scores
      // against), so none of them can be served from the stale cache.
      expect(second.cache.misses).toBeGreaterThan(0);
    });
  }, 30_000);

  test("a new/changed verification report invalidates that skill's cache row even though its SKILL.md is unchanged", () => {
    withTempRoot((root) => {
      const first = runStocktake(root, { scope: "bundled", quick: true, now: () => new Date("2026-01-01T00:00:00.000Z") });
      const target = first.entries[0];
      if (target === undefined) throw new Error("expected at least one bundled skill");
      const [category, name] = target.skillId.split("/");

      const reportsDir = path.join(root, ".metaproject", "data", "gdskills", "reports");
      mkdirSync(reportsDir, { recursive: true });
      writeFileSync(path.join(reportsDir, `${category}-${name}-verification.json`), JSON.stringify({ status: "stale" }), "utf8");

      const second = runStocktake(root, { scope: "bundled", quick: true, now: () => new Date("2026-01-02T00:00:00.000Z") });
      const updated = second.entries.find((entry) => entry.skillId === target.skillId);
      // Without the cache-key fix this would still report the run-1 verdict
      // forever (same SKILL.md sha256), never picking up the new report.
      expect(updated?.verdict).toBe("update");
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

  // F23 (flow 309 review round 1): every reason is prefixed with the
  // skill's own id, which means two DIFFERENT skills' reasons could never
  // collide byte-for-byte on the old check even when the EVIDENCE after the
  // prefix was identical (same closest neighbor, same score) — "satisfied
  // by construction". The comparison now strips each entry's own id/name
  // before comparing, so identical evidence under different ids IS flagged.
  test("throws when two different skills carry identical evidence once their own ids are stripped", () => {
    const report: StocktakeReport = {
      schemaVersion: "1.0.0",
      generatedAt: "2026-01-01T00:00:00.000Z",
      scope: "bundled",
      entries: [
        { skillId: "a/one", verdict: "keep", reason: "a/one: lint clean; 2 trigger(s); closest neighbor b/shared at 0.40", evidence: {} },
        { skillId: "a/two", verdict: "keep", reason: "a/two: lint clean; 2 trigger(s); closest neighbor b/shared at 0.40", evidence: {} },
      ],
      cache: { hits: 0, misses: 2 },
    };
    expect(() => assertReasonsSpecific(report)).toThrow();
  });

  test("does not throw when two skills' evidence genuinely differs beyond their own ids", () => {
    const report: StocktakeReport = {
      schemaVersion: "1.0.0",
      generatedAt: "2026-01-01T00:00:00.000Z",
      scope: "bundled",
      entries: [
        { skillId: "a/one", verdict: "keep", reason: "a/one: lint clean; 2 trigger(s); closest neighbor b/shared at 0.40", evidence: {} },
        { skillId: "a/two", verdict: "keep", reason: "a/two: lint clean; 3 trigger(s); closest neighbor c/other at 0.55", evidence: {} },
      ],
      cache: { hits: 0, misses: 2 },
    };
    expect(() => assertReasonsSpecific(report)).not.toThrow();
  });
});
