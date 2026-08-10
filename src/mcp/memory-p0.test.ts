import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { METAPROJECT_OPERATIONS } from "../harness/tool/metaproject-operations";
import type { MetaprojectPort } from "../harness/tool/metaproject-port";
import { assertP0Purity, snapshotProject } from "../memory/p0-test-utils";
import { toMcpTools } from "./metaproject-tools";

const FIXTURE = path.join(import.meta.dir, "..", "..", "fixtures", "memory-reliability-p0");
const SNAPSHOT_OPTIONS = {
  paths: [".metaproject/memory", ".metaproject/data/memory/artifacts", ".metaproject/runtime/memory"],
  includeRuntimePaths: [
    ".metaproject/data/memory/artifacts/latest.md",
    ".metaproject/data/memory/artifacts/latest.json",
  ],
};

test("P0-6: MCP memory.search is mutating:false and purity-characterized", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-memory-mcp-p0-"));
  try {
    await cp(path.join(FIXTURE, ".metaproject"), path.join(root, ".metaproject"), { recursive: true });
    const port = toMcpTools(METAPROJECT_OPERATIONS).find((tool) => tool.name === "memory_search");
    expect(port).toBeDefined();
    expect(port?.mutating).toBe(false);
    const before = await snapshotProject(root, SNAPSHOT_OPTIONS);
    const result = (await port?.invoke(root, { query: "authority boundary" })) as { query: string; hits: unknown[] };
    const after = await snapshotProject(root, SNAPSHOT_OPTIONS);
    expect(result.query).toBe("authority boundary");
    expect(result.hits.length).toBeGreaterThan(0);
    assertP0Purity(before, after);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P0-6: MCP fake port fixture proves structured memory.search dispatch", async () => {
  const port: MetaprojectPort = {
    searchCode: async ({ pattern }) => ({ pattern, output: "", isError: false }),
    graphAffected: async ({ target }) => ({ target, affected: [] }),
    graphQuery: async ({ query }) => ({ query, cycles: [] }),
    memorySearch: async ({ query }) => ({
      query,
      hits: [{ path: "decisions/accepted.md", title: "Accepted", score: 1 }],
    }),
    readWiki: async ({ path: filePath }) => ({ path: filePath, content: "", isError: false }),
    describeContext: async () => ({ root: "/tmp", graphNodes: 0, graphEdges: 0, hasWikiIndex: false }),
  };
  const tool = toMcpTools(METAPROJECT_OPERATIONS, () => port).find((entry) => entry.name === "memory_search");
  expect(tool?.mutating).toBe(false);
  expect(await tool?.invoke("/tmp", { query: "accepted" })).toEqual({
    query: "accepted",
    hits: [{ path: "decisions/accepted.md", title: "Accepted", score: 1 }],
  });
});
