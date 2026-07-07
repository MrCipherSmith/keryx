import { test, expect } from "bun:test";
import { searchEntries } from "./search";
import { DEFAULT_MEMORY_CONFIG as C } from "./config";
import type { MemoryEntry } from "./types";

function entry(over: Partial<MemoryEntry>): MemoryEntry {
  return {
    absolutePath: "",
    relativePath: "lessons/x.md",
    type: "lesson",
    title: "",
    version: "0.1.0",
    status: "draft",
    confidence: "medium",
    summary: "",
    details: "",
    tags: [],
    scopes: { module: null, entity: null, files: [], skills: [] },
    created: null,
    updated: null,
    provenance: { source: null, link: null },
    ...over,
  };
}

test("ranks relevant entries and drops non-matching", () => {
  const relevant = entry({ relativePath: "lessons/bun.md", title: "Prefer Bun", summary: "use bun runtime for scripts" });
  const other = entry({ relativePath: "lessons/other.md", title: "Something else", summary: "unrelated content here" });
  const results = searchEntries([relevant, other], "bun runtime", {}, C, new Date("2026-07-07"));
  expect(results.length).toBe(1);
  expect(results[0]?.entry.relativePath).toBe("lessons/bun.md");
});

test("status filter restricts results", () => {
  const accepted = entry({ relativePath: "a.md", status: "accepted", title: "bun", summary: "bun" });
  const draft = entry({ relativePath: "b.md", status: "draft", title: "bun", summary: "bun" });
  const results = searchEntries([accepted, draft], "bun", { status: "accepted" }, C, new Date());
  expect(results.length).toBe(1);
  expect(results[0]?.entry.status).toBe("accepted");
});

test("module and entity filters restrict results", () => {
  const pipelineStep = entry({
    relativePath: "a.md",
    title: "step",
    summary: "step",
    status: "accepted",
    scopes: { module: "pipelines", entity: "step", files: [], skills: [] },
  });
  const pipelineStore = entry({
    relativePath: "b.md",
    title: "step",
    summary: "step",
    status: "accepted",
    scopes: { module: "pipelines", entity: "store", files: [], skills: [] },
  });
  const analyticsStep = entry({
    relativePath: "c.md",
    title: "step",
    summary: "step",
    status: "accepted",
    scopes: { module: "analytics", entity: "step", files: [], skills: [] },
  });

  const results = searchEntries(
    [pipelineStore, analyticsStep, pipelineStep],
    "step",
    { module: "pipelines", entity: "step" },
    C,
    new Date(),
  );

  expect(results.map((result) => result.entry.relativePath)).toEqual(["a.md"]);
});

test("accepted/high-confidence outranks draft/low at equal relevance", () => {
  const accepted = entry({ relativePath: "a.md", status: "accepted", confidence: "high", title: "bun tip", summary: "bun tip" });
  const draft = entry({ relativePath: "b.md", status: "draft", confidence: "low", title: "bun tip", summary: "bun tip" });
  const results = searchEntries([draft, accepted], "bun tip", {}, C, new Date());
  expect(results[0]?.entry.relativePath).toBe("a.md");
});
