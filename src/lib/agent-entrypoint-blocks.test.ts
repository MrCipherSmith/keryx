// Flow 336 — the Model choice policy inside the managed `<!-- keryx:index -->`
// block. `renderProjectMetaprojectReferenceBlock` itself is pure/sync, so
// these tests need no filesystem at all.
import { expect, test } from "bun:test";
import { renderProjectMetaprojectReferenceBlock } from "./agent-entrypoint-blocks";

test("default call (no modelChoice given) still carries the Model choice policy, tier words only", () => {
  const block = renderProjectMetaprojectReferenceBlock({ enableTasks: true });
  expect(block).toContain("<!-- keryx:index -->");
  expect(block).toContain("<!-- /keryx:index -->");
  expect(block).toMatch(/flagship tier for planning and review/);
});

test("modelChoice.enabled: false drops the policy line entirely, leaving the rest of the block intact", () => {
  const enabled = renderProjectMetaprojectReferenceBlock({
    enableTasks: true,
    modelChoice: { enabled: true, assignments: {} },
  });
  const disabled = renderProjectMetaprojectReferenceBlock({
    enableTasks: true,
    modelChoice: { enabled: false, assignments: {} },
  });

  expect(enabled).toMatch(/flagship tier for planning and review/);
  expect(disabled).not.toMatch(/flagship tier for planning and review/);
  // Every other policy line is unaffected.
  expect(disabled).toContain("HARD GATE");
  expect(disabled).toContain("keryx ctx rg");
});

test("a resolved assignment is rendered into the block's Model choice line", () => {
  const block = renderProjectMetaprojectReferenceBlock({
    enableTasks: true,
    modelChoice: {
      enabled: true,
      assignments: { review: { kind: "model", providerId: "anthropic", modelId: "claude-opus-5" } },
    },
  });
  expect(block).toContain("review=anthropic/claude-opus-5");
});

test("the whole block, markers included, is still exactly one keryx:index pair", () => {
  const block = renderProjectMetaprojectReferenceBlock({ enableTasks: true });
  const starts = block.match(/<!-- keryx:index -->/g) ?? [];
  const ends = block.match(/<!-- \/keryx:index -->/g) ?? [];
  expect(starts.length).toBe(1);
  expect(ends.length).toBe(1);
});
