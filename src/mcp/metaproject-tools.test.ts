import { expect, test } from "bun:test";
import { toMcpTools } from "./metaproject-tools";
import { METAPROJECT_OPERATIONS } from "../harness/tool/metaproject-operations";
import type { MetaprojectPort } from "../harness/tool/metaproject-port";

// A full MetaprojectPort fake (including the flow-043/044 OPTIONAL methods) so every
// unified operation has a backing method to dispatch to.
function fullFakePort(): MetaprojectPort {
  const port: MetaprojectPort = {
    searchCode: async ({ pattern }) => ({ pattern, output: "rg", isError: false }),
    graphAffected: async ({ target }) => ({ target, affected: [] }),
    graphQuery: async ({ query }) => (query === "orphans" ? { query, orphans: [] } : { query, cycles: [] }),
    memorySearch: async ({ query }) => ({ query, hits: [] }),
    readWiki: async ({ path }) => ({ path, content: "x", isError: false }),
    describeContext: async () => ({ root: "/x", graphNodes: 0, graphEdges: 0, hasWikiIndex: false }),
    graphPath: async ({ from, to }) => ({ from, to, nodes: [] }),
    testRelated: async ({ file }) => ({ file, tests: [] }),
    healthStatus: async () => ({
      enabled: false,
      lastRunAt: null,
      gate: null,
      sources: [],
      projectScore: null,
      regressions: 0,
    }),
    graphSymbol: async ({ name }) => ({ name, definitions: [], callers: [], callees: [] }),
    repomap: async () => ({ budget: 0, files: [], tokens: 0, omitted: 0 }),
    wikiAsk: async ({ question }) => ({ question, answer: "", citations: [] }),
  };
  return port;
}

test("every unified metaproject tool is invocable via MCP (no 'unknown operation')", async () => {
  const port = fullFakePort();
  const tools = toMcpTools(METAPROJECT_OPERATIONS, () => port);
  expect(tools).toHaveLength(METAPROJECT_OPERATIONS.length);

  const minimalParams: Record<string, Record<string, unknown>> = {
    search_code: { pattern: "x" },
    graph_affected: { file: "a.ts" },
    graph_query: { query: "orphans" },
    memory_search: { query: "x" },
    read_wiki: { path: "index.md" },
    graph_path: { from: "a", to: "b" },
    test_related: { file: "a.ts" },
    health_status: {},
    graph_symbol: { name: "Foo" },
    repomap: {},
    wiki_ask: { question: "how?" },
  };

  for (const tool of tools) {
    const result = await tool.invoke("/proj", minimalParams[tool.name] ?? {});
    const asRecord = result as { error?: unknown };
    // The fix: no registered operation returns the "unknown operation" sentinel.
    expect(typeof asRecord.error === "string" && asRecord.error.includes("unknown metaproject operation")).toBe(
      false,
    );
    expect(tool.mutating).toBe(false); // M-10 read-only preserved
  }
});
