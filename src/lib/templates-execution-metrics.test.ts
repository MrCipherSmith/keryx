import { expect, test } from "bun:test";
import { renderIndexMarkdown } from "./templates";

function render(enableGdskills: boolean): string {
  return renderIndexMarkdown({
    enableGdgraph: false,
    enableGdctx: false,
    enableGdwiki: false,
    enableGdskills,
    enableHealth: false,
    enableTesting: false,
    enableMemory: false,
    enableTasks: false,
    ruleSources: [],
  });
}

test("generated index activates execution metrics for direct user skill runs", () => {
  const index = render(true);

  expect(index).toContain(".metaproject/rules/core/execution-metrics.md");
  expect(index).toContain("invoked directly by a user");
  expect(index).toContain("dispatched as a subagent");
  expect(index.indexOf("execution-metrics.md")).toBeLessThan(index.indexOf("For any non-trivial repository task"));
  expect(index.indexOf("execution-metrics.md")).toBeLessThan(index.indexOf("Route by question type"));
});

test("generated index omits execution metrics routing without gdskills", () => {
  expect(render(false)).not.toContain("execution-metrics.md");
});
