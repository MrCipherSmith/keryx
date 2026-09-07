import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createMetaprojectAdapter } from "./metaproject-adapter";

const SENTINEL = "outside-containment-sentinel";

type Fixture = { base: string; root: string; wiki: string; skills: string; outside: string };

async function fixture(): Promise<Fixture> {
  const base = await mkdtemp(path.join(tmpdir(), "keryx-harness-containment-"));
  const root = path.join(base, "project");
  const wiki = path.join(root, ".metaproject", "wiki");
  const skills = path.join(root, ".metaproject", "skills", "gdskills");
  const outside = path.join(base, "outside");
  await mkdir(path.join(wiki, "nested"), { recursive: true });
  await mkdir(path.join(skills, "category", "inside"), { recursive: true });
  await mkdir(path.join(outside, "category", "escape"), { recursive: true });
  await writeFile(path.join(wiki, "nested", "page.md"), "wiki-inside\n", "utf8");
  await writeFile(path.join(outside, "secret.md"), SENTINEL, "utf8");
  await writeFile(path.join(skills, "category", "inside", "SKILL.md"), "---\nname: inside\n---\ninside\n", "utf8");
  await writeFile(path.join(outside, "category", "escape", "SKILL.md"), SENTINEL, "utf8");
  await writeFile(path.join(root, ".metaproject", "skills", "catalog.md"), "| Skill | Category | Purpose | Entry |\n| inside | category | fixture | x |\n", "utf8");
  await symlink(path.join("nested", "page.md"), path.join(wiki, "alias.md"));
  await symlink(path.join(wiki, "nested"), path.join(wiki, "alias-dir"));
  await symlink(path.join(outside, "secret.md"), path.join(wiki, "escape.md"));
  await symlink(path.join(skills, "category"), path.join(skills, "linked-category"));
  return { base, root, wiki, skills, outside };
}

let current: Fixture | undefined;
afterEach(async () => {
  if (current) await rm(current.base, { recursive: true, force: true });
  current = undefined;
});

function assertSafeWikiError(result: { isError: boolean; content: string; error?: string }): void {
  expect(result.isError).toBe(true);
  expect(result.content).toBe("");
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain(SENTINEL);
  expect(serialized).not.toContain("outside");
}

describe("harness wiki/skills containment RED scenarios", () => {
  test("readWiki returns the same bytes through internal file links", async () => {
    current = await fixture();
    const adapter = createMetaprojectAdapter(current.root);
    const direct = await adapter.readWiki({ path: "nested/page.md" });
    const linked = await adapter.readWiki({ path: "alias.md" });
    expect(direct.isError).toBe(false);
    expect(linked.isError).toBe(false);
    expect(linked.content).toBe(direct.content);
  });

  test("readWiki rejects external links without disclosing content or target names", async () => {
    current = await fixture();
    const result = await createMetaprojectAdapter(current.root).readWiki({ path: "escape.md" });
    assertSafeWikiError(result);
  });

  test("readWiki rejects a replaced wiki root instead of following a new outside tree", async () => {
    current = await fixture();
    const replacement = path.join(current.base, "replacement-wiki");
    await mkdir(replacement, { recursive: true });
    await writeFile(path.join(replacement, "leak.md"), SENTINEL, "utf8");
    await rm(current.wiki, { recursive: true, force: true });
    await symlink(replacement, current.wiki);
    const result = await createMetaprojectAdapter(current.root).readWiki({ path: "leak.md" });
    assertSafeWikiError(result);
  });

  test("skills discovery follows an internal linked category while keeping path ownership", async () => {
    current = await fixture();
    const catalog = await createMetaprojectAdapter(current.root).skillsCatalog!({});
    const linked = catalog.skills.find((entry) => entry.path.includes("linked-category"));
    expect(linked).toBeDefined();
    expect(linked?.path).toContain(path.join(".metaproject", "skills", "gdskills"));
  });

  test("replaced skills root is refused and cannot disclose an outside skill", async () => {
    current = await fixture();
    const replacement = path.join(current.base, "replacement-skills");
    await mkdir(path.join(replacement, "category", "escape"), { recursive: true });
    await writeFile(path.join(replacement, "category", "escape", "SKILL.md"), SENTINEL, "utf8");
    await rm(current.skills, { recursive: true, force: true });
    await symlink(replacement, current.skills);
    const result = await createMetaprojectAdapter(current.root).skillsCatalog!({});
    expect(result.skills).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  test("loadSkill follows an internal catalog path but refuses unknown/external paths", async () => {
    current = await fixture();
    const adapter = createMetaprojectAdapter(current.root);
    const catalogPath = path.join(".metaproject", "skills", "gdskills", "linked-category", "inside", "SKILL.md");
    const linked = await adapter.loadSkill!({ name: catalogPath });
    expect(linked.found).toBe(true);
    expect(linked.content).toContain("inside");
    const external = await adapter.loadSkill!({ name: path.join(".metaproject", "skills", "gdskills", "..", "..", "..", "outside", "category", "escape", "SKILL.md") });
    expect(external.found).toBe(false);
    expect(external.content).toBe("");
  });
});
