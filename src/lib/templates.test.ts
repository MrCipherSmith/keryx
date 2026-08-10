import { expect, test } from "bun:test";
import { renderIndexMarkdown, renderMetaprojectGitignoreBlock } from "./templates";

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
  expect(index).not.toContain("data/memory/artifacts/latest.md");
});

test("generated index gives one-per-session, non-blocking version advisory guidance", () => {
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

  expect(index).toContain("keryx version check --json");
  expect(index).toMatch(/once per session/i);
  expect(index).toContain("update-available");
  expect(index).toMatch(/notify|advisory/i);
  expect(index).toMatch(/never block|non-blocking/i);
  for (const outcome of ["timeout", "offline", "unavailable", "unknown-command"]) {
    expect(index).toContain(outcome);
  }
});

test("generated ignore block isolates memory views without hiding canonical entries", () => {
  const block = renderMetaprojectGitignoreBlock();
  expect(block).toContain(".metaproject/data/memory/index/");
  expect(block).toContain(".metaproject/data/memory/embeddings/");
  expect(block).toContain(".metaproject/data/memory/artifacts/");
  expect(block).toContain(".metaproject/runtime/memory/");
  expect(block).not.toContain(".metaproject/memory/");
});
