import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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
    wikiBacklinks: async ({ file }) => ({ file, backlinks: [] }),
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
    wiki_backlinks: { file: "src/x.ts" },
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

// Flow 313 (W4) review R1-F4: the `memory_search` MCP projection
// (METAPROJECT_OPERATIONS -> toMcpTools, distinct from `src/mcp/tools.ts`'s
// `memory.search`) never applied any `target_harnesses` filter before this
// fix — every restricted entry was returned to every bound harness.
// Discriminating: pre-fix, `invokeStructured`'s `memory_search` case
// returned `port.memorySearch(...)`'s hits UNFILTERED regardless of
// `context.harnessIdentity`.
test("R1-F4: memory_search filters hits by the bound harness identity in context", async () => {
  const project = mkdtempSync(path.join(tmpdir(), "keryx-metaproject-tools-mem-"));
  try {
    const decisionsDir = path.join(project, ".metaproject", "memory", "decisions");
    mkdirSync(decisionsDir, { recursive: true });
    writeFileSync(
      path.join(decisionsDir, "codex-only.md"),
      "# Codex only\n\nVersion: 0.1.0\nType: decision\nStatus: accepted\nConfidence: high\nSource-Harness: claude\nTarget-Harnesses: codex\n\n## Summary\n\nrestricted\n",
      "utf8",
    );
    const port: MetaprojectPort = {
      ...fullFakePort(),
      memorySearch: async ({ query }) => ({
        query,
        hits: [{ path: "decisions/codex-only.md", title: "Codex only", score: 1 }],
      }),
    };
    const tool = toMcpTools(METAPROJECT_OPERATIONS, () => port).find((t) => t.name === "memory_search");

    const asClaude = (await tool?.invoke(project, { query: "x" }, { transport: "in-process", harnessIdentity: "claude" })) as {
      hits: unknown[];
    };
    expect(asClaude.hits).toEqual([]);

    const asCodex = (await tool?.invoke(project, { query: "x" }, { transport: "in-process", harnessIdentity: "codex" })) as {
      hits: unknown[];
    };
    expect(asCodex.hits.length).toBe(1);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

// R1-F4: `wiki_ask`'s MCP projection previously went through the shared
// `op.invoke`, which never threads a bound MCP harness identity through to
// `port.wikiAsk` at all — this asserts the identity now actually reaches
// the port call.
test("R1-F4: wiki_ask threads context.harnessIdentity into port.wikiAsk", async () => {
  const seen: Array<string | null | undefined> = [];
  const port: MetaprojectPort = {
    ...fullFakePort(),
    wikiAsk: async ({ question, harnessIdentity }) => {
      seen.push(harnessIdentity);
      return { question, answer: "", citations: [] };
    },
  };
  const tool = toMcpTools(METAPROJECT_OPERATIONS, () => port).find((t) => t.name === "wiki_ask");
  await tool?.invoke("/proj", { question: "why" }, { transport: "in-process", harnessIdentity: "claude" });
  await tool?.invoke("/proj", { question: "why" });
  expect(seen).toEqual(["claude", null]);
});
