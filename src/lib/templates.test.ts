import { expect, test } from "bun:test";
import {
  renderGdgraphManifest,
  renderGdgraphSkillReadme,
  renderHooksReadme,
  renderIndexMarkdown,
  renderMetaprojectGitignoreBlock,
} from "./templates";
import { renderProjectMetaprojectReferenceBlock } from "./agent-entrypoint-blocks";

const ALL_MODULES = {
  enableGdgraph: true,
  enableGdctx: true,
  enableGdwiki: true,
  enableGdskills: true,
  enableHealth: true,
  enableTesting: true,
  enableMemory: true,
  enableTasks: true,
  enableSecurity: true,
  ruleSources: [] as string[],
};

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

// The graph answers from the last build, and a stale answer is indistinguishable
// from a fresh one. Every agent-facing surface must therefore carry the refresh
// rule: the manifest holds the contract, the index and the root entrypoint block
// route to it.

test("gdgraph manifest states the freshness contract: what invalidates, how it shows, how to repair", () => {
  const manifest = renderGdgraphManifest();

  expect(manifest).toContain("## Freshness & Refresh");
  // What invalidates the graph.
  expect(manifest).toMatch(/added, deleted, renamed or moved/i);
  expect(manifest).toMatch(/import added or removed/i);
  // The symbol layer is the part an in-file edit does invalidate.
  expect(manifest).toMatch(/symbol layer/i);
  // How staleness is observed, and how it is repaired.
  expect(manifest).toContain("keryx gdgraph context");
  expect(manifest).toContain("freshness: working tree clean");
  expect(manifest).toContain("keryx gdgraph build");
  // The hook half, including its opt-out and its cost.
  expect(manifest).toContain("KERYX_GDGRAPH_HOOK_REBUILD=0");
});

test("generated index routes graph staleness in both the workflow and the intent router", () => {
  const index = renderIndexMarkdown({ ...ALL_MODULES });

  // Workflow item: rebuild before trusting an answer, not once per question.
  expect(index).toMatch(/last `keryx gdgraph build`, not from the working tree/);
  expect(index).toMatch(/added, renamed, deleted or moved files in this session/);
  expect(index).toContain("keryx gdgraph context");
  expect(index).toContain("modules/gdgraph.md");
  // Intent router row for the same intent.
  expect(index).toMatch(/\|[^\n]*graph answers look stale[^\n]*\|[^\n]*keryx gdgraph build[^\n]*\|/i);
});

test("index drops the graph freshness routing when gdgraph is disabled", () => {
  const index = renderIndexMarkdown({ ...ALL_MODULES, enableGdgraph: false });

  expect(index).not.toContain("keryx gdgraph build");
  expect(index).not.toMatch(/graph answers look stale/i);
});

test("root entrypoint block carries the same rebuild rule as the index", () => {
  const block = renderProjectMetaprojectReferenceBlock({ enableTasks: true });

  expect(block).toContain("<!-- keryx:index -->");
  expect(block).toMatch(/last `keryx gdgraph build`, not from the working tree/);
  expect(block).toContain(".metaproject/modules/gdgraph.md");
});

test("gdgraph skill refresh policy describes the hook the template actually renders", () => {
  const skill = renderGdgraphSkillReadme();

  // The previous text claimed the hook "refreshes graph"; the body only printed
  // a reminder. Whatever it claims now must match the rendered hook.
  expect(skill).toContain("KERYX_GDGRAPH_HOOK_REBUILD=0");
  expect(skill).toMatch(/never blocks the commit/i);
  expect(skill).toContain("$HOME/.local/bin/keryx");
  expect(skill).toContain("modules/gdgraph.md");
});

test("hooks README documents the gdgraph hook as rebuilding, with its cost and opt-out", () => {
  const readme = renderHooksReadme();

  expect(readme).toMatch(/rebuilds the graph|rebuilding/i);
  expect(readme).toContain("KERYX_GDGRAPH_HOOK_REBUILD=0");
  expect(readme).toMatch(/exits 0|never blocks/i);
  expect(readme).toContain("data/gdgraph/artifacts/");
});

test("generated ignore block isolates memory views without hiding canonical entries", () => {
  const block = renderMetaprojectGitignoreBlock();
  expect(block).toContain(".metaproject/data/memory/index/");
  expect(block).toContain(".metaproject/data/memory/embeddings/");
  expect(block).toContain(".metaproject/data/memory/artifacts/");
  expect(block).toContain(".metaproject/runtime/memory/");
  expect(block).not.toContain(".metaproject/memory/");
});
