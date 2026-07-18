import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "bun:test";
import { validateAgainstSchemaObject } from "../../contracts/validator";
import type { MetaprojectPort } from "./metaproject-port";
import {
  METAPROJECT_OPERATIONS,
  type MetaprojectOperation,
  toInteractiveTools,
  toToolDefinitions,
} from "./metaproject-operations";

// The frozen operation descriptor schema (src/harness/tool/ -> repo root).
const OPERATION_SCHEMA = JSON.parse(
  readFileSync(
    path.join(
      import.meta.dir,
      "..",
      "..",
      "..",
      "docs",
      "requirements",
      "keryx-metaproject-native",
      "schemas",
      "metaproject-operation.schema.json",
    ),
    "utf8",
  ),
) as Record<string, unknown>;

const EXPECTED_NAMES = [
  "graph_affected",
  "graph_path",
  "graph_query",
  "health_status",
  "memory_search",
  "read_wiki",
  "search_code",
  "test_related",
];

interface PortCalls {
  searchCode: unknown[];
  graphAffected: unknown[];
  graphQuery: unknown[];
  memorySearch: unknown[];
  readWiki: unknown[];
  describeContext: unknown[];
}

/** A fake port that records the calls it received and returns canned structured results. */
function recordingPort(): {
  port: MetaprojectPort;
  calls: PortCalls;
} {
  const calls: PortCalls = {
    searchCode: [],
    graphAffected: [],
    graphQuery: [],
    memorySearch: [],
    readWiki: [],
    describeContext: [],
  };
  const port: MetaprojectPort = {
    async searchCode(input) {
      calls.searchCode.push(input);
      return { pattern: input.pattern, output: "rg output", isError: false };
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
      calls.graphQuery.push(input);
      return { query: input.query, orphans: ["src/orphan.ts"] };
    },
    async memorySearch(input) {
      calls.memorySearch.push(input);
      return {
        query: input.query,
        hits: [{ path: "decisions/x.md", title: "Offline", type: "decision", status: "accepted", score: 0.5 }],
      };
    },
    async readWiki(input) {
      calls.readWiki.push(input);
      return { path: input.path, content: "# Architecture", isError: false };
    },
    async describeContext() {
      calls.describeContext.push({});
      return { root: "/proj", graphNodes: 0, graphEdges: 0, hasWikiIndex: false };
    },
  };
  return { port, calls };
}

// --- AC1: descriptors + schema validation ------------------------------------

test("METAPROJECT_OPERATIONS covers the five metaproject read operations", () => {
  expect(METAPROJECT_OPERATIONS.map((op) => op.name).sort()).toEqual(EXPECTED_NAMES);
  for (const op of METAPROJECT_OPERATIONS) {
    expect(op.risk).toBe("read");
    expect(op.inputSchema.type).toBe("object");
    expect(op.outputSchema.type).toBe("object");
  }
});

test("every descriptor validates against metaproject-operation.schema.json", () => {
  for (const op of METAPROJECT_OPERATIONS) {
    const descriptor = {
      name: op.name,
      module: op.module,
      description: op.description,
      risk: op.risk,
      inputSchema: op.inputSchema,
      outputSchema: op.outputSchema,
    };
    const result = validateAgainstSchemaObject(OPERATION_SCHEMA, descriptor);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  }
});

// --- AC2: toInteractiveTools projection ---------------------------------------

test("toInteractiveTools produces one InteractiveTool per descriptor with matching name + risk read", () => {
  const { port } = recordingPort();
  const tools = toInteractiveTools(METAPROJECT_OPERATIONS, port);
  expect(tools).toHaveLength(METAPROJECT_OPERATIONS.length);
  expect(tools.map((t) => t.definition.name).sort()).toEqual(EXPECTED_NAMES);
  for (const tool of tools) {
    expect(tool.definition.risk).toBe("read");
    expect(tool.definition.inputSchema.type).toBe("object");
  }
});

test("an InteractiveTool invoke delegates to the descriptor's invoke against the fake port", async () => {
  const { port, calls } = recordingPort();
  const tools = toInteractiveTools(METAPROJECT_OPERATIONS, port);

  const affected = tools.find((t) => t.definition.name === "graph_affected");
  const affectedResult = await affected?.invoke({ file: "src/a.ts" });
  expect(calls.graphAffected).toEqual([{ target: "src/a.ts" }]);
  expect(affectedResult?.isError).toBe(false);
  expect(affectedResult?.output).toContain("Blast radius of src/a.ts");

  const query = tools.find((t) => t.definition.name === "graph_query");
  const queryResult = await query?.invoke({ query: "orphans" });
  expect(calls.graphQuery).toEqual([{ query: "orphans" }]);
  expect(queryResult?.output).toContain("src/orphan.ts");

  const wiki = tools.find((t) => t.definition.name === "read_wiki");
  const wikiResult = await wiki?.invoke({ path: "index.md" });
  expect(calls.readWiki).toEqual([{ path: "index.md" }]);
  expect(wikiResult?.output).toContain("# Architecture");
});

test("toInteractiveTools binds a different port per projection", async () => {
  const first = recordingPort();
  const second = recordingPort();
  const firstTools = toInteractiveTools(METAPROJECT_OPERATIONS, first.port);
  const secondTools = toInteractiveTools(METAPROJECT_OPERATIONS, second.port);

  await firstTools.find((t) => t.definition.name === "memory_search")?.invoke({ query: "offline" });
  expect(first.calls.memorySearch).toEqual([{ query: "offline" }]);
  expect(second.calls.memorySearch).toEqual([]);

  await secondTools.find((t) => t.definition.name === "memory_search")?.invoke({ query: "other" });
  expect(second.calls.memorySearch).toEqual([{ query: "other" }]);
});

// --- AC2: toToolDefinitions projection ----------------------------------------

test("toToolDefinitions produces one ToolDefinition per descriptor with matching toolId/risk/schemas", () => {
  const defs = toToolDefinitions(METAPROJECT_OPERATIONS);
  expect(defs).toHaveLength(METAPROJECT_OPERATIONS.length);
  for (const op of METAPROJECT_OPERATIONS) {
    const def = defs.find((d) => d.toolId === `metaproject:${op.name}`);
    expect(def).toBeDefined();
    expect(def?.risk).toBe("read");
    expect(def?.version).toBe("0.1.0");
    expect(def?.schemaVersion).toBe(1);
    expect(def?.inputSchema).toBe(op.inputSchema);
    expect(def?.outputSchema).toBe(op.outputSchema);
    expect(def?.limits.timeoutMs).toBeGreaterThan(0);
    expect(def?.limits.maxOutputBytes).toBeGreaterThan(0);
    expect(def?.limits.concurrencyKey).toBe(`metaproject:${op.name}`);
    expect(def?.replay).toEqual({ deterministic: true, recordedResultSupported: true });
    expect(def?.capabilities).toEqual(["read"]);
  }
});

test("toToolDefinitions is pure — no port and no reference sharing beyond schemas", () => {
  const a = toToolDefinitions(METAPROJECT_OPERATIONS);
  const b = toToolDefinitions(METAPROJECT_OPERATIONS);
  expect(a.map((d) => d.toolId)).toEqual(b.map((d) => d.toolId));
  // Distinct definition objects per call.
  expect(a[0]).not.toBe(b[0]);
});

// --- descriptor invoke edge cases (offline, deterministic) --------------------

test("a descriptor invoke returns an error result for a missing required arg", async () => {
  const { port, calls } = recordingPort();
  const graphAffected = METAPROJECT_OPERATIONS.find(
    (op): op is MetaprojectOperation => op.name === "graph_affected",
  );
  const result = await graphAffected?.invoke(port, {});
  expect(result?.isError).toBe(true);
  expect(calls.graphAffected).toEqual([]); // the port was NOT consulted
});

// --- flow 043: new operations (graph_path / test_related / health_status) ------

function op(name: string): MetaprojectOperation {
  const found = METAPROJECT_OPERATIONS.find((o) => o.name === name);
  if (found === undefined) {
    throw new Error(`operation not found: ${name}`);
  }
  return found;
}

test("new operations return 'unavailable' when the optional port method is absent", async () => {
  const { port } = recordingPort(); // has no graphPath/testRelated/healthStatus
  for (const name of ["graph_path", "test_related", "health_status"]) {
    const result = await op(name).invoke(port, { from: "a", to: "b", file: "a.ts" });
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/not available/);
  }
});

test("new operations format the structured port result when the method is present", async () => {
  const port: MetaprojectPort = {
    ...recordingPort().port,
    graphPath: async ({ from, to }) => ({ from, to, nodes: [from, "mid", to] }),
    testRelated: async ({ file }) => ({ file, tests: ["a.test.ts", "b.test.ts"] }),
    healthStatus: async () => ({
      enabled: true,
      lastRunAt: "2026-07-17",
      gate: "warn",
      sources: [],
      projectScore: 82,
      regressions: 1,
    }),
  };
  const pathResult = await op("graph_path").invoke(port, { from: "a", to: "b" });
  expect(pathResult.isError).toBe(false);
  expect(pathResult.output).toContain("a -> mid -> b");

  const testResult = await op("test_related").invoke(port, { file: "src/x.ts" });
  expect(testResult.output).toContain("a.test.ts");

  const healthResult = await op("health_status").invoke(port, {});
  expect(healthResult.output).toContain("gate: warn");
});

test("toToolDefinitions and MCP-shape names include the new operations", () => {
  const ids = toToolDefinitions(METAPROJECT_OPERATIONS).map((d) => d.toolId);
  expect(ids).toContain("metaproject:graph_path");
  expect(ids).toContain("metaproject:test_related");
  expect(ids).toContain("metaproject:health_status");
});
