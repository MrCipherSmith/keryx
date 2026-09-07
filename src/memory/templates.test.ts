import { expect, test } from "bun:test";
import {
  renderMemoryEntry,
  renderMemoryEntryTemplate,
  renderMemoryManifest,
  renderMemorySkillReadme,
} from "./templates";

test("generated memory templates describe canonical and disposable locations", () => {
  const generated = `${renderMemoryManifest()}\n${renderMemorySkillReadme()}`;
  expect(generated).toContain("data/memory/index/index.json");
  expect(generated).toContain("data/memory/embeddings/");
  expect(generated).toContain("runtime/memory/search/<run-id>/");
  expect(generated).not.toContain("data/memory/artifacts/latest.md");
  expect(generated).not.toContain("data/memory/artifacts/latest.json");
});

// AFC-25 / AC6: parseEntry (store.ts) can only recover an author, a
// confirming participant, and a caveat if the scaffolds authors actually
// create offer those fields. Without this, the parsing stays dead in
// practice -- no author ever writes a field the template never showed them.
test("AFC-25 / T20 finding 2: entry scaffolds offer Author, Confirmed-By and Caveat fields", () => {
  const generated = renderMemoryEntry({ title: "T", type: "decision", date: "2026-01-01" });
  expect(generated).toContain("- Author:");
  expect(generated).toContain("- Confirmed-By:");
  expect(generated).toContain("Caveat:");

  const template = renderMemoryEntryTemplate();
  expect(template).toContain("- Author:");
  expect(template).toContain("- Confirmed-By:");
  expect(template).toContain("Caveat:");
});
