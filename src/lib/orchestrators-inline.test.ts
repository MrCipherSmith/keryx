// Flow 417 AC13 — the generated routing text states that the orchestrators run
// in the main session. Tests render from the generators, so a regenerated
// managed block, routing.md or catalog.md that loses the sentence fails here.
import { expect, test } from "bun:test";
import { renderGdskillsCatalog } from "../gdskills/catalog";
import { renderProjectMetaprojectReferenceBlock } from "./agent-entrypoint-blocks";
import { ORCHESTRATORS_INLINE_NOTE } from "./orchestrators-inline";
import { renderIndexMarkdown } from "./templates";

const FLAGS = {
  enableGdgraph: true,
  enableGdctx: true,
  enableGdwiki: true,
  enableGdskills: true,
  enableHealth: true,
  enableTesting: true,
  enableMemory: true,
  enableTasks: true,
  ruleSources: [],
};

test("the note names the three orchestrators and the main session", () => {
  expect(ORCHESTRATORS_INLINE_NOTE).toContain("review-orchestrator");
  expect(ORCHESTRATORS_INLINE_NOTE).toContain("flow-orchestrator");
  expect(ORCHESTRATORS_INLINE_NOTE).toContain("job-orchestrator");
  expect(ORCHESTRATORS_INLINE_NOTE).toContain("main session");
});

test("the managed CLAUDE.md/AGENTS.md block carries the note, with and without tasks", () => {
  for (const enableTasks of [true, false]) {
    expect(renderProjectMetaprojectReferenceBlock({ enableTasks })).toContain(ORCHESTRATORS_INLINE_NOTE);
  }
});

test("routing.md carries the note", () => {
  expect(renderIndexMarkdown(FLAGS)).toContain(ORCHESTRATORS_INLINE_NOTE);
});

test("skills/catalog.md carries the note", () => {
  expect(renderGdskillsCatalog("full")).toContain(ORCHESTRATORS_INLINE_NOTE);
});
