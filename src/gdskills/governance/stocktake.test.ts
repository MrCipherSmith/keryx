import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ContainedWriteError } from "../../lib/contained-write";
import { assertReasonsSpecific, runStocktake, stripSkillIdentity, type StocktakeReport } from "./stocktake";

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

async function withTempRoot<T>(fn: (root: string) => Promise<T> | T): Promise<T> {
  const root = mkdtempSync(path.join(tmpdir(), "stocktake-"));
  try {
    return await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("runStocktake", () => {
  test("every entry carries a non-empty, skill-specific reason (never reused verbatim)", async () => {
    await withTempRoot(async (root) => {
      const report = await runStocktake(root, { scope: "bundled", quick: true, now: () => new Date("2026-01-01T00:00:00.000Z") });
      expect(report.entries.length).toBeGreaterThan(50);
      for (const entry of report.entries) {
        expect(entry.reason.length).toBeGreaterThan(0);
      }
      expect(() => assertReasonsSpecific(report)).not.toThrow();
    });
  }, 20_000);

  test("writes the dated report and the cache under .metaproject/data/skills/stocktake", async () => {
    await withTempRoot(async (root) => {
      const report = await runStocktake(root, { scope: "bundled", quick: true, now: () => new Date("2026-03-15T12:00:00.000Z") });
      const reportPath = path.join(root, ".metaproject", "data", "skills", "stocktake", "2026-03-15.json");
      const cachePath = path.join(root, ".metaproject", "data", "skills", "stocktake", "cache.json");
      const onDisk = JSON.parse(readFileSync(reportPath, "utf8")) as StocktakeReport;
      expect(onDisk.entries.length).toBe(report.entries.length);
      expect(JSON.parse(readFileSync(cachePath, "utf8"))).toBeDefined();
    });
  }, 20_000);

  test("a second run reuses the cache (hits > 0, misses 0)", async () => {
    await withTempRoot(async (root) => {
      await runStocktake(root, { scope: "bundled", quick: true, now: () => new Date("2026-01-01T00:00:00.000Z") });
      const second = await runStocktake(root, { scope: "bundled", quick: true, now: () => new Date("2026-01-02T00:00:00.000Z") });
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
  test("adding a new catalog entry invalidates every other entry's cache row (neighbour-dependent verdicts)", async () => {
    await withTempRoot(async (root) => {
      const first = await runStocktake(root, { scope: "all", quick: true, now: () => new Date("2026-01-01T00:00:00.000Z") });
      expect(first.cache.misses).toBeGreaterThan(0);

      const newSkillDir = path.join(root, ".metaproject", "project-skills", "project", "brand-new-project-skill");
      mkdirSync(newSkillDir, { recursive: true });
      writeFileSync(
        path.join(newSkillDir, "SKILL.md"),
        "---\nname: brand-new-project-skill\ndescription: Use when testing cache invalidation on a new neighbour.\n---\nBody.\n",
        "utf8",
      );

      const second = await runStocktake(root, { scope: "all", quick: true, now: () => new Date("2026-01-02T00:00:00.000Z") });
      // Every previously-cached row's catalogFingerprint changed (a new
      // entry now exists in the corpus every scout/overlap check scores
      // against), so none of them can be served from the stale cache.
      expect(second.cache.misses).toBeGreaterThan(0);
    });
  }, 30_000);

  test("a new/changed verification report invalidates that skill's cache row even though its SKILL.md is unchanged", async () => {
    await withTempRoot(async (root) => {
      const first = await runStocktake(root, { scope: "bundled", quick: true, now: () => new Date("2026-01-01T00:00:00.000Z") });
      const target = first.entries[0];
      if (target === undefined) throw new Error("expected at least one bundled skill");
      const [category, name] = target.skillId.split("/");

      const reportsDir = path.join(root, ".metaproject", "data", "gdskills", "reports");
      mkdirSync(reportsDir, { recursive: true });
      writeFileSync(path.join(reportsDir, `${category}-${name}-verification.json`), JSON.stringify({ status: "stale" }), "utf8");

      const second = await runStocktake(root, { scope: "bundled", quick: true, now: () => new Date("2026-01-02T00:00:00.000Z") });
      const updated = second.entries.find((entry) => entry.skillId === target.skillId);
      // Without the cache-key fix this would still report the run-1 verdict
      // forever (same SKILL.md sha256), never picking up the new report.
      expect(updated?.verdict).toBe("update");
    });
  }, 20_000);

  // Flow 319 follow-up to R700-04: runStocktake's cache/report writes now go
  // through writeContained (root/rel split against the project `root`
  // passed in), so a `.metaproject/data/skills/stocktake` leaf directory
  // swapped for a symlink pointing outside the project is refused, exactly
  // like any other contained-write call site — never silently written
  // through to wherever the symlink points.
  test("refuses to write when .metaproject/data/skills/stocktake is a symlink pointing outside the project, and writes nothing outside", async () => {
    await withTempRoot(async (root) => {
      const outside = mkdtempSync(path.join(tmpdir(), "stocktake-outside-"));
      try {
        mkdirSync(path.join(root, ".metaproject", "data", "skills"), { recursive: true });
        symlinkSync(outside, path.join(root, ".metaproject", "data", "skills", "stocktake"));

        await expect(
          runStocktake(root, { scope: "bundled", quick: true, now: () => new Date("2026-01-01T00:00:00.000Z") }),
        ).rejects.toThrow(ContainedWriteError);

        expect(existsSync(path.join(outside, "cache.json"))).toBe(false);
        expect(existsSync(path.join(outside, "2026-01-01.json"))).toBe(false);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
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
      unreadable: [],
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
      unreadable: [],
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
      unreadable: [],
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
      unreadable: [],
    };
    expect(() => assertReasonsSpecific(report)).not.toThrow();
  });

  // R2-3 (flow 309 review round 2): the bare-name strip used a substring
  // `split`/`join`, which over-stripped a short name wherever its letters
  // occurred inside an unrelated word — name `"pr"` deleted the `"pr"` inside
  // `"improve"`, corrupting the comparison. Word-boundary matching fixes it.
  test("a short skill name is stripped only as its own word, not wherever its letters occur inside another word", () => {
    const report: StocktakeReport = {
      schemaVersion: "1.0.0",
      generatedAt: "2026-01-01T00:00:00.000Z",
      scope: "bundled",
      entries: [
        { skillId: "quality/pr", verdict: "keep", reason: "quality/pr: lint clean; needs to improve nothing", evidence: {} },
        { skillId: "quality/other", verdict: "keep", reason: "quality/other: lint clean; needs to improve nothing", evidence: {} },
      ],
      cache: { hits: 0, misses: 2 },
      unreadable: [],
    };
    // Genuinely identical evidence ("needs to improve nothing") once each
    // skill's own id is stripped — MUST still be flagged. The over-stripping
    // bug would additionally eat "pr" out of "improve" for the first entry
    // only, which could mask or alter this collision unpredictably.
    expect(() => assertReasonsSpecific(report)).toThrow();
  });
});

describe("R2-3 (flow 309 review round 2): runtime duplicate reasons are tagged, never thrown", () => {
  test("three near-duplicate project skills do not crash runStocktake — they are tagged, and the run completes (exit-equivalent: no throw)", async () => {
    await withTempRoot(async (root) => {
      const base = "Use when you need to review code style. Trigger words: code, review, style, when, you, need.";
      for (const name of ["alpha", "beta", "gamma"]) {
        const skillDir = path.join(root, ".metaproject", "project-skills", "project", name);
        mkdirSync(skillDir, { recursive: true });
        writeFileSync(path.join(skillDir, "SKILL.md"), `---\nname: ${name}\ndescription: ${base}\n---\nBody.\n`, "utf8");
      }

      let report: StocktakeReport | undefined;
      let thrown: unknown;
      try {
        report = await runStocktake(root, { scope: "all", quick: true, now: () => new Date("2026-01-01T00:00:00.000Z") });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeUndefined();
      expect(report).toBeDefined();
      if (report === undefined) return;

      const near = report.entries.filter((entry) => entry.skillId.startsWith("project/"));
      expect(near.length).toBe(3);
      // Every entry is still present with a non-empty reason (a full report
      // was produced, not an abort) — and at least one of the collided
      // entries carries `duplicateReasonOf` recording WHICH entry it
      // collided with, instead of the whole run throwing.
      for (const entry of near) {
        expect(entry.reason.length).toBeGreaterThan(0);
      }
      const tagged = near.filter((entry) => "duplicateReasonOf" in entry.evidence);
      expect(tagged.length).toBeGreaterThan(0);
    });
  }, 20_000);

  // R3-4 (flow 309 review round 3): a single unreadable project SKILL.md
  // (EACCES) used to make the whole `--scope all` run throw a raw
  // "permission denied" error, with no report produced for any skill —
  // even the other 71+ perfectly readable ones. It must instead be
  // recorded in a top-level `unreadable` list and the run must still
  // complete.
  test.skipIf(isRoot)("--scope all: an unreadable project SKILL.md (EACCES) is recorded in `unreadable`, not thrown (R3-4)", async () => {
    await withTempRoot(async (root) => {
      const okDir = path.join(root, ".metaproject", "project-skills", "ok-skill");
      mkdirSync(okDir, { recursive: true });
      writeFileSync(path.join(okDir, "SKILL.md"), `---\nname: ok-skill\ndescription: Use when things are fine.\n---\n\nBody.\n`, "utf8");

      const badDir = path.join(root, ".metaproject", "project-skills", "bad-skill");
      mkdirSync(badDir, { recursive: true });
      const badSkillMd = path.join(badDir, "SKILL.md");
      writeFileSync(badSkillMd, `---\nname: bad-skill\ndescription: Use when unreadable.\n---\n\nBody.\n`, "utf8");
      chmodSync(badSkillMd, 0o000);

      try {
        let report: StocktakeReport | undefined;
        let thrown: unknown;
        try {
          report = await runStocktake(root, { scope: "all", quick: true, now: () => new Date("2026-01-01T00:00:00.000Z") });
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeUndefined();
        expect(report).toBeDefined();
        if (report === undefined) return;
        expect(report.unreadable.some((u) => u.path === badSkillMd)).toBe(true);
        expect(report.entries.some((entry) => entry.skillId === "project-skills/ok-skill")).toBe(true);
      } finally {
        chmodSync(badSkillMd, 0o644);
      }
    });
  }, 20_000);
});

describe("stripSkillIdentity (R3-6, flow 309 review round 3)", () => {
  // `\b` is a `\w`/non-`\w` transition — a hyphen is not `\w`, so the OLD
  // `\bname\b` pattern matched "review-frontend" as a PREFIX inside
  // "review-frontend-conventions" too (the boundary right before
  // "-conventions" counts, same as the one at the string's own start).
  // That over-strips a short hyphenated name out of a reason that is
  // really about an unrelated, longer sibling id.
  test("does not strip a hyphenated name where it is only the PREFIX of a longer, different id", () => {
    const reason = "closest neighbour is review-frontend-conventions";
    const stripped = stripSkillIdentity(reason, "review/review-frontend");
    expect(stripped).toBe(reason);
  });

  test("still strips the hyphenated name/id when it appears as its own whole word", () => {
    expect(stripSkillIdentity("closest neighbour is review-frontend", "review/review-frontend")).toBe("closest neighbour is <skill>");
    expect(stripSkillIdentity("id review/review-frontend appears here", "review/review-frontend")).toBe("id <skill> appears here");
  });
});
