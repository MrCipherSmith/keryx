import { expect, test } from "bun:test";
import {
  renderGdgraphManifest,
  renderGdgraphSkillReadme,
  renderHooksReadme,
  renderIndexGateMarkdown,
  renderIndexMarkdown,
  ROUTING_FILENAME,
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

test("the index gate stays small, because its size is multiplied by task length", () => {
  // Measured 2026-09-05: the full router is ~3,226 tokens and an agent re-sends
  // its whole transcript every turn, so reading it once costs ~3,226 x turns —
  // ~80,000 on a 25-turn task, about half the context gap the retrieval
  // benchmark measured against keryx.
  //
  // This bound is the point of the split. If the gate creeps back toward the
  // router's size, the split has quietly undone itself and nothing else would
  // say so.
  const gate = renderIndexGateMarkdown({ ...ALL_MODULES });

  expect(gate.length).toBeLessThan(2000); // ~500 tokens, against ~3,226 before
  expect(gate).toContain(ROUTING_FILENAME);
});

test("the gate carries pointers and the rules that bind, not prose", () => {
  const gate = renderIndexGateMarkdown({ ...ALL_MODULES });

  // Pointers an agent needs to act at all.
  expect(gate).toContain("keryx gdgraph affected");
  expect(gate).toContain("keryx ctx rg");
  // The two rules that change behaviour rather than describing it.
  expect(gate).toMatch(/never bare `rg`\/`grep`/);
  expect(gate).toMatch(/last `keryx gdgraph build`/);

  // Deliberately left to routing.md: these are re-read every turn of every
  // task, including the many where none of it applies.
  expect(gate).not.toContain("## Intent Router");
  expect(gate).not.toContain("## Agent Workflow");
  expect(gate).not.toContain("## Enabled Modules");
});

test("the gate names only the modules that are enabled", () => {
  const gate = renderIndexGateMarkdown({
    ...ALL_MODULES,
    enableGdwiki: false,
    enableMemory: false,
  });

  expect(gate).toContain("keryx ctx rg");
  expect(gate).not.toContain("wiki/index.md");
  expect(gate).not.toContain("keryx memory search");
});

test("subagents are not all made to read the full routing index", () => {
  // Measured 2026-09-05: `.metaproject/index.md` is ~3,226 tokens, and an agent
  // re-sends its whole transcript on every turn — so one read costs ~3,226 x
  // turns. The old rule required EVERY subagent to read it, which at three
  // subagents of ten turns each is ~177,000 tokens of routing index alone, and
  // defeats the reason subagents exist: a narrow slice of context.
  //
  // The rule is prose, so nothing but this test stops it drifting back.
  const block = renderProjectMetaprojectReferenceBlock({ enableTasks: true });

  expect(block).not.toMatch(/Every subagent prompt must .*require reading/);
  expect(block).toMatch(/inline the few routing pointers/i);
  expect(block).toMatch(/only when it will navigate the codebase itself/i);
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
