import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadSkillCatalog } from "./catalog-index";
import { readScoutRecord, recordScout, SCOUT_FORK_THRESHOLD, SCOUT_USE_THRESHOLD, scoutImports, scoutSkill, scoutVetCandidate } from "./scout";

const catalog = loadSkillCatalog(process.cwd(), { scope: "bundled" });

describe("scoutSkill", () => {
  test("querying an existing skill's own description returns use or fork, never create", () => {
    for (const entry of catalog) {
      if (entry.description.length === 0) continue;
      const result = scoutSkill(entry.description, catalog);
      expect(result.decision).not.toBe("create");
      expect(result.matches[0]?.skillId).toBe(entry.id);
    }
  });

  test("an unrelated query returns create", () => {
    const result = scoutSkill("underwater basket weaving championship schedule for goldfish", catalog);
    expect(result.decision).toBe("create");
  });

  test("matches are sorted by score descending, then id, capped at 5", () => {
    const result = scoutSkill("review the pull request for security issues", catalog);
    expect(result.matches.length).toBeLessThanOrEqual(5);
    for (let i = 1; i < result.matches.length; i++) {
      const prev = result.matches[i - 1]!;
      const cur = result.matches[i]!;
      expect(prev.overlapScore > cur.overlapScore || (prev.overlapScore === cur.overlapScore && prev.skillId < cur.skillId)).toBe(true);
    }
  });

  test("thresholds are the documented constants by default", () => {
    const result = scoutSkill("anything", catalog);
    expect(result.thresholds).toEqual({ use: SCOUT_USE_THRESHOLD, fork: SCOUT_FORK_THRESHOLD });
  });

  test("empty catalog always decides create", () => {
    const result = scoutSkill("anything at all", []);
    expect(result.decision).toBe("create");
    expect(result.matches).toEqual([]);
  });
});

describe("scout record", () => {
  test("readScoutRecord returns [] when none recorded; recordScout appends and is readable back", () => {
    const packDir = mkdtempSync(path.join(tmpdir(), "scout-record-"));
    try {
      expect(readScoutRecord(packDir)).toEqual([]);
      recordScout(packDir, {
        query: "python testing",
        decision: "create",
        topMatch: null,
        recordedAt: "2026-01-01T00:00:00.000Z",
        skillName: "python-testing",
      });
      const record = readScoutRecord(packDir);
      expect(record.length).toBe(1);
      expect(record[0]?.skillName).toBe("python-testing");
    } finally {
      rmSync(packDir, { recursive: true, force: true });
    }
  });
});

describe("scoutImports", () => {
  test("reports not searched, W4 absent", () => {
    expect(scoutImports()).toEqual({ searched: false, reason: "no imported bundles (W4 not installed)" });
  });
});

describe("scoutVetCandidate", () => {
  test("returns a result without throwing for a real directory", async () => {
    const result = await scoutVetCandidate(process.cwd());
    expect(typeof result.available).toBe("boolean");
  });

  test("reports unavailable, not a fake pass, for a nonexistent directory", async () => {
    const result = await scoutVetCandidate(path.join(tmpdir(), "definitely-does-not-exist-scout-candidate"));
    expect(result.available).toBe(false);
    expect(result.reason).toBeDefined();
  });
});
