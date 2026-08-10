import { expect, test } from "bun:test";
import { renderMemoryManifest, renderMemorySkillReadme } from "./templates";

test("generated memory templates describe canonical and disposable locations", () => {
  const generated = `${renderMemoryManifest()}\n${renderMemorySkillReadme()}`;
  expect(generated).toContain("data/memory/index/index.json");
  expect(generated).toContain("data/memory/embeddings/");
  expect(generated).toContain("runtime/memory/search/<run-id>/");
  expect(generated).not.toContain("data/memory/artifacts/latest.md");
  expect(generated).not.toContain("data/memory/artifacts/latest.json");
});
