import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { createMetaprojectAdapter } from "./metaproject-adapter";
import { METAPROJECT_OPERATIONS, toInteractiveTools, toToolDefinitions } from "./metaproject-operations";
import { assertP0Purity, snapshotProject } from "../../memory/p0-test-utils";

const FIXTURE = path.join(import.meta.dir, "..", "..", "..", "fixtures", "memory-reliability-p0");
const SNAPSHOT_OPTIONS = {
  paths: [".metaproject/memory", ".metaproject/data/memory/artifacts", ".metaproject/runtime/memory"],
  includeRuntimePaths: [
    ".metaproject/data/memory/artifacts/latest.md",
    ".metaproject/data/memory/artifacts/latest.json",
  ],
};

test("P0-5: native adapter memorySearch is structured and characterized as read-only", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-memory-adapter-p0-"));
  try {
    await cp(path.join(FIXTURE, ".metaproject"), path.join(root, ".metaproject"), { recursive: true });
    const adapter = createMetaprojectAdapter(root);
    const before = await snapshotProject(root, SNAPSHOT_OPTIONS);
    const result = await adapter.memorySearch({ query: "authority boundary", limit: 3 });
    const after = await snapshotProject(root, SNAPSHOT_OPTIONS);
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits[0]?.path).not.toContain(root);
    expect(result.hits[0]?.excerpt).toBeDefined();
    assertP0Purity(before, after);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P0-5: unified memory_search keeps read-only risk and projection parity", async () => {
  const op = METAPROJECT_OPERATIONS.find((candidate) => candidate.name === "memory_search");
  expect(op).toBeDefined();
  expect(op?.risk).toBe("read");
  expect(toToolDefinitions(METAPROJECT_OPERATIONS).find((tool) => tool.toolId === "metaproject:memory_search")?.risk).toBe("read");
  const interactive = toInteractiveTools(METAPROJECT_OPERATIONS, {
    searchCode: async () => ({ pattern: "", output: "", isError: false }),
    graphAffected: async ({ target }) => ({ target, affected: [] }),
    graphQuery: async ({ query }) => ({ query, cycles: [] }),
    memorySearch: async ({ query }) => ({ query, hits: [] }),
    readWiki: async ({ path: filePath }) => ({ path: filePath, content: "", isError: false }),
    describeContext: async () => ({ root: "/tmp", graphNodes: 0, graphEdges: 0, hasWikiIndex: false }),
  });
  expect(interactive.find((tool) => tool.definition.name === "memory_search")?.definition.risk).toBe("read");
});

test("P0-5: unified memory_search invocation is purity-characterized", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-memory-unified-p0-"));
  try {
    await cp(path.join(FIXTURE, ".metaproject"), path.join(root, ".metaproject"), { recursive: true });
    const op = METAPROJECT_OPERATIONS.find((candidate) => candidate.name === "memory_search");
    expect(op).toBeDefined();
    const before = await snapshotProject(root, SNAPSHOT_OPTIONS);
    const result = await op?.invoke(createMetaprojectAdapter(root), { query: "authority boundary" });
    const after = await snapshotProject(root, SNAPSHOT_OPTIONS);
    expect(result?.isError).toBe(false);
    expect(result?.output).toContain("Memory hits");
    assertP0Purity(before, after);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
