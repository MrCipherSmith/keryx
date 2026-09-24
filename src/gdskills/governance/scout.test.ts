import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadSkillCatalog } from "./catalog-index";
import {
  checkSkillSelected,
  readScoutRecord,
  recordScout,
  SCOUT_FORK_THRESHOLD,
  SCOUT_USE_THRESHOLD,
  scoutImports,
  scoutSkill,
  scoutVetCandidate,
} from "./scout";

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

  test("a short domain query against a covering skill reaches fork or use, never create (flow 309 T12 regression)", () => {
    // Before flow 309 T12 this scored review/review-frontend at 0.086
    // (symmetric Jaccard against its full ~40-token description) and decided
    // "create" even though review-frontend/code-mobx-store-review plainly
    // cover "review react components mobx". The IDF-weighted coverage
    // scorer judges the query's own intent, not diluted by the rest of the
    // description, so a covering skill now clears at least the fork bar.
    const result = scoutSkill("review react components mobx", catalog);
    expect(result.decision).not.toBe("create");
    const coveringIds = ["review/review-frontend", "review/code-mobx-store-review", "review/review-backend"];
    const topMatchIsCovering = result.matches.some((match) => coveringIds.includes(match.skillId) && match.overlapScore >= SCOUT_FORK_THRESHOLD);
    expect(topMatchIsCovering).toBe(true);
  });

  test("a fully unrelated technical query still returns create", () => {
    const result = scoutSkill("kubernetes helm chart linting", catalog);
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

describe("checkSkillSelected", () => {
  test("review/review-frontend's own triggers all select it against the real bundled catalog", () => {
    const skill = catalog.find((entry) => entry.id === "review/review-frontend");
    expect(skill).toBeDefined();
    if (skill === undefined) return;
    for (const trigger of skill.triggers) {
      const result = checkSkillSelected(trigger, skill.id, catalog);
      expect(result.selected).toBe(true);
    }
  });

  test("a different-category skill's trigger does not select an unrelated skill", () => {
    const skill = catalog.find((entry) => entry.id === "review/review-frontend");
    const other = catalog.find((entry) => entry.category !== "review" && entry.triggers.length > 0);
    expect(skill).toBeDefined();
    expect(other).toBeDefined();
    if (skill === undefined || other === undefined) return;
    const result = checkSkillSelected(other.triggers[0] as string, skill.id, catalog);
    expect(result.selected).toBe(false);
  });

  test("reports rank -1 and not selected for an id absent from the catalog", () => {
    const result = checkSkillSelected("anything", "nope/does-not-exist", catalog);
    expect(result.selected).toBe(false);
    expect(result.rank).toBe(-1);
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

  test("recordScout accepts and round-trips an optional justification", () => {
    const packDir = mkdtempSync(path.join(tmpdir(), "scout-record-"));
    try {
      recordScout(packDir, {
        query: "python pytest testing",
        decision: "fork",
        topMatch: "review/review-testing-practices",
        recordedAt: "2026-01-01T00:00:00.000Z",
        skillName: "python-testing",
        justification: "top match is a review skill, not an authoring workflow; no generic skill covers pytest-specific fixture/parametrization guidance",
      });
      const record = readScoutRecord(packDir);
      expect(record[0]?.justification).toBe(
        "top match is a review skill, not an authoring workflow; no generic skill covers pytest-specific fixture/parametrization guidance",
      );
    } finally {
      rmSync(packDir, { recursive: true, force: true });
    }
  });

  test("readScoutRecord omits justification when not recorded", () => {
    const packDir = mkdtempSync(path.join(tmpdir(), "scout-record-"));
    try {
      recordScout(packDir, {
        query: "anything",
        decision: "create",
        topMatch: null,
        recordedAt: "2026-01-01T00:00:00.000Z",
        skillName: "anything",
      });
      expect(readScoutRecord(packDir)[0]?.justification).toBeUndefined();
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
