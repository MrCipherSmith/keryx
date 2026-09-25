import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadSkillCatalog, loadSkillCatalogWithDiagnostics } from "./catalog-index";

// R3-4 (flow 309 review round 3): chmod 000 has no effect for the root user
// (root can read/write regardless of mode bits), so the chmod-based
// discrimination this describe block relies on is skipped when running as
// root — matches the review's own repro note.
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

describe("loadSkillCatalog", () => {
  test("loads the real bundled catalog with non-empty, well-shaped entries", () => {
    const catalog = loadSkillCatalog(process.cwd(), { scope: "bundled" });
    expect(catalog.length).toBeGreaterThan(50);
    for (const entry of catalog) {
      expect(entry.id).toBe(`${entry.category}/${entry.name}`);
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.body.length).toBeGreaterThan(0);
    }
  });

  test("is sorted by id and has no duplicate ids", () => {
    const catalog = loadSkillCatalog(process.cwd(), { scope: "bundled" });
    const ids = catalog.map((entry) => entry.id);
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("determinism: two loads of the same tree produce byte-identical ids and hashes", () => {
    const first = loadSkillCatalog(process.cwd(), { scope: "bundled" });
    const second = loadSkillCatalog(process.cwd(), { scope: "bundled" });
    expect(first.map((entry) => `${entry.id}:${entry.sha256}`)).toEqual(second.map((entry) => `${entry.id}:${entry.sha256}`));
  });

  test("scope 'all' includes an installed gdskills mirror and dedupes against bundled", () => {
    const root = mkdtempSync(path.join(tmpdir(), "catalog-index-"));
    try {
      const gdskillsDir = path.join(root, ".metaproject", "skills", "gdskills", "widget", "my-widget-skill");
      mkdirSync(gdskillsDir, { recursive: true });
      writeFileSync(
        path.join(gdskillsDir, "SKILL.md"),
        `---\nname: my-widget-skill\ndescription: Use when widgets need testing.\n---\n\nBody.\n`,
        "utf8",
      );

      const bundledOnly = loadSkillCatalog(root, { scope: "bundled" });
      expect(bundledOnly.some((entry) => entry.id === "widget/my-widget-skill")).toBe(false);

      const all = loadSkillCatalog(root, { scope: "all" });
      const found = all.find((entry) => entry.id === "widget/my-widget-skill");
      expect(found).toBeDefined();
      expect(found?.description).toContain("Use when widgets need testing");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // R3-4 (flow 309 review round 3): before this fix, `loadSkillCatalog`
  // called `readFileSync`/`readdirSync` with no error handling — a single
  // unreadable project `SKILL.md` (EACCES) or unreadable directory made the
  // WHOLE load throw, so `stocktake`/`eval`/`scout --scope all` aborted with
  // no report at all for the other, perfectly readable skills.
  test.skipIf(isRoot)("an unreadable project SKILL.md (EACCES) is skipped, not thrown — the rest of the catalog still loads (R3-4)", () => {
    const root = mkdtempSync(path.join(tmpdir(), "catalog-index-eacces-"));
    try {
      const okDir = path.join(root, ".metaproject", "project-skills", "ok-skill");
      mkdirSync(okDir, { recursive: true });
      writeFileSync(path.join(okDir, "SKILL.md"), `---\nname: ok-skill\ndescription: Use when things are fine.\n---\n\nBody.\n`, "utf8");

      const badDir = path.join(root, ".metaproject", "project-skills", "bad-skill");
      mkdirSync(badDir, { recursive: true });
      const badSkillMd = path.join(badDir, "SKILL.md");
      writeFileSync(badSkillMd, `---\nname: bad-skill\ndescription: Use when unreadable.\n---\n\nBody.\n`, "utf8");
      chmodSync(badSkillMd, 0o000);

      expect(() => loadSkillCatalog(root, { scope: "all" })).not.toThrow();
      const { entries, unreadable } = loadSkillCatalogWithDiagnostics(root, { scope: "all" });
      expect(entries.some((entry) => entry.id === "project-skills/ok-skill")).toBe(true);
      expect(unreadable.some((u) => u.path === badSkillMd)).toBe(true);
      expect(unreadable.find((u) => u.path === badSkillMd)?.code).toBe("EACCES");
    } finally {
      chmodSync(path.join(root, ".metaproject", "project-skills", "bad-skill", "SKILL.md"), 0o644);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
