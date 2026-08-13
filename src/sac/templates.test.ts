import { expect, test } from "bun:test";
import { renderSacManifest, renderSacSkillReadme } from "./templates";

test("renderSacManifest returns non-empty prose documenting the workspace commands", () => {
  const manifest = renderSacManifest();
  expect(manifest.length).toBeGreaterThan(0);
  expect(manifest).toContain("keryx workspace propose");
  expect(manifest).toContain("keryx workspace review");
});

test("renderSacSkillReadme has valid frontmatter with name and description", () => {
  const skill = renderSacSkillReadme();
  expect(skill.length).toBeGreaterThan(0);
  expect(skill.startsWith("---\n")).toBe(true);
  const frontmatterEnd = skill.indexOf("\n---\n", 4);
  expect(frontmatterEnd).toBeGreaterThan(0);
  const frontmatter = skill.slice(4, frontmatterEnd);
  expect(frontmatter).toContain("name: sac");
  expect(frontmatter).toMatch(/description: .+/);
});

test("renderSacSkillReadme documents the no-session-linkage constraint and workspace discovery", () => {
  const skill = renderSacSkillReadme();
  expect(skill).toContain("keryx workspace list");
  expect(skill).toContain("session-to-workspace linkage");
});
