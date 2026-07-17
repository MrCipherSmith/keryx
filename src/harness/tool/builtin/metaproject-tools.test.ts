import { expect, test } from "bun:test";
import { type KeryxRunner, builtinMetaprojectTools } from "./metaproject-tools";
import type { InteractiveTool } from "./interactive-tools";
import type { MetaprojectPort } from "../metaproject-port";

const ROOT = "/proj";

/** A fake runner that records the argv it was called with and returns canned output. */
function recordingRunner(result = { output: "ok", isError: false }): {
  run: KeryxRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    run: async (args) => {
      calls.push(args);
      return result;
    },
  };
}

function tool(tools: InteractiveTool[], name: string): InteractiveTool {
  const found = tools.find((t) => t.definition.name === name);
  if (found === undefined) {
    throw new Error(`tool not found: ${name}`);
  }
  return found;
}

test("metaproject tools are all risk read with valid names and schemas", () => {
  const { run } = recordingRunner();
  const tools = builtinMetaprojectTools(ROOT, run);
  expect(tools.map((t) => t.definition.name).sort()).toEqual(["graph_affected", "memory_search", "search_code"]);
  for (const t of tools) {
    expect(t.definition.risk).toBe("read");
    expect(t.definition.inputSchema.type).toBe("object");
  }
});

test("search_code maps input to `ctx rg <pattern> [path]` argv", async () => {
  const { run, calls } = recordingRunner();
  const tools = builtinMetaprojectTools(ROOT, run);
  await tool(tools, "search_code").invoke({ pattern: "AppendOnlySession" });
  expect(calls[0]).toEqual(["ctx", "rg", "AppendOnlySession"]);
  await tool(tools, "search_code").invoke({ pattern: "foo", path: "src" });
  expect(calls[1]).toEqual(["ctx", "rg", "foo", "src"]);
});

test("graph_affected maps input to `gdgraph affected <file>` argv", async () => {
  const { run, calls } = recordingRunner();
  const tools = builtinMetaprojectTools(ROOT, run);
  await tool(tools, "graph_affected").invoke({ file: "src/commands/shell.ts" });
  expect(calls[0]).toEqual(["gdgraph", "affected", "src/commands/shell.ts"]);
});

test("memory_search maps input to `memory search <query>` argv", async () => {
  const { run, calls } = recordingRunner();
  const tools = builtinMetaprojectTools(ROOT, run);
  await tool(tools, "memory_search").invoke({ query: "why offline" });
  expect(calls[0]).toEqual(["memory", "search", "why offline"]);
});

test("a missing required arg errors WITHOUT invoking the runner", async () => {
  const { run, calls } = recordingRunner();
  const tools = builtinMetaprojectTools(ROOT, run);
  const r1 = await tool(tools, "search_code").invoke({});
  const r2 = await tool(tools, "graph_affected").invoke({});
  const r3 = await tool(tools, "memory_search").invoke({});
  for (const r of [r1, r2, r3]) {
    expect(r.isError).toBe(true);
  }
  expect(calls).toHaveLength(0);
});

test("a runner failure is propagated as an error result", async () => {
  const { run } = recordingRunner({ output: "boom", isError: true });
  const tools = builtinMetaprojectTools(ROOT, run);
  const result = await tool(tools, "search_code").invoke({ pattern: "x" });
  expect(result.isError).toBe(true);
  expect(result.output).toBe("boom");
});

// --- flow 037: port-aware in-process path ---

/** A fake port that records the calls it received and returns canned structured results. */
function recordingPort(): {
  port: MetaprojectPort;
  calls: { graphAffected: unknown[]; memorySearch: unknown[]; searchCode: unknown[] };
} {
  const calls = { graphAffected: [] as unknown[], memorySearch: [] as unknown[], searchCode: [] as unknown[] };
  const port: MetaprojectPort = {
    async searchCode(input) {
      calls.searchCode.push(input);
      return { pattern: input.pattern, output: "no in-process backing", isError: true };
    },
    async graphAffected(input) {
      calls.graphAffected.push(input);
      return {
        target: input.target,
        depth: 1,
        ranked: true,
        affected: [{ id: "src/b.ts", path: "src/b.ts", hop: 1, fanIn: 2 }],
      };
    },
    async graphQuery(input) {
      return { query: input.query };
    },
    async memorySearch(input) {
      calls.memorySearch.push(input);
      return {
        query: input.query,
        hits: [{ path: "decisions/x.md", title: "Offline", type: "decision", status: "accepted", score: 0.5 }],
      };
    },
    async readWiki(input) {
      return { path: input.path, content: "", isError: false };
    },
    async describeContext() {
      return { root: ROOT, graphNodes: 0, graphEdges: 0, hasWikiIndex: false };
    },
  };
  return { port, calls };
}

test("with an injected port, graph_affected calls the port (not the subprocess) and formats its result", async () => {
  const { run, calls: runnerCalls } = recordingRunner();
  const { port, calls } = recordingPort();
  const tools = builtinMetaprojectTools(ROOT, run, port);
  const result = await tool(tools, "graph_affected").invoke({ file: "src/a.ts" });

  expect(runnerCalls).toHaveLength(0); // NO subprocess
  expect(calls.graphAffected).toEqual([{ target: "src/a.ts" }]);
  expect(result.isError).toBe(false);
  expect(result.output).toContain("Blast radius of src/a.ts");
  expect(result.output).toContain("src/b.ts (hop 1, fanIn 2)");
});

test("with an injected port, memory_search calls the port (not the subprocess) and formats its result", async () => {
  const { run, calls: runnerCalls } = recordingRunner();
  const { port, calls } = recordingPort();
  const tools = builtinMetaprojectTools(ROOT, run, port);
  const result = await tool(tools, "memory_search").invoke({ query: "offline" });

  expect(runnerCalls).toHaveLength(0);
  expect(calls.memorySearch).toEqual([{ query: "offline" }]);
  expect(result.isError).toBe(false);
  expect(result.output).toContain('Memory hits for "offline"');
  expect(result.output).toContain("decisions/x.md");
});

test("search_code falls back to the subprocess runner when the port has no in-process backing", async () => {
  const { run, calls: runnerCalls } = recordingRunner();
  const { port, calls } = recordingPort();
  const tools = builtinMetaprojectTools(ROOT, run, port);
  await tool(tools, "search_code").invoke({ pattern: "foo" });

  expect(calls.searchCode).toEqual([{ pattern: "foo" }]); // the port was consulted
  expect(runnerCalls[0]).toEqual(["ctx", "rg", "foo"]); // then it fell back to subprocess
});
