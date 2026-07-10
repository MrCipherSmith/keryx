import { expect, test } from "bun:test";
import { renderIndexMarkdown } from "./templates";

test("generated index uses supported refresh commands only", () => {
  const index = renderIndexMarkdown({
    enableGdgraph: true,
    enableGdctx: true,
    enableGdwiki: true,
    enableGdskills: true,
    enableHealth: true,
    enableTesting: true,
    enableMemory: true,
    enableTasks: true,
    enableSecurity: true,
    ruleSources: [],
  });
  expect(index).not.toContain("keryx index refresh");
  expect(index).toContain("keryx gdgraph build");
  expect(index).toContain("keryx wiki index");
  expect(index).toContain("keryx test analyze");
});
