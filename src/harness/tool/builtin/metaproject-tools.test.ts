import { expect, test } from "bun:test";
import { type KeryxRunner, builtinMetaprojectTools } from "./metaproject-tools";
import type { InteractiveTool } from "./interactive-tools";

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
