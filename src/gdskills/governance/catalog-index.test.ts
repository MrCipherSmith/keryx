import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadSkillCatalog } from "./catalog-index";

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
});
