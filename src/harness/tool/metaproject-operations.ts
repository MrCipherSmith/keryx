// Single source-of-truth metaproject operation descriptors (flow 038 / MP-3).
//
// A metaproject operation is defined ONCE here — name + owning module + risk +
// input/output JSON Schema + an `invoke(port, input)` over the flow-037
// MetaprojectPort — and projected into the two current consumers:
//   - the interactive agent, via `toInteractiveTools(ops, port)` (content-returning
//     InteractiveTool[]), and
//   - the harness ToolRegistry, via `toToolDefinitions(ops)` (durable
//     ToolDefinition[] with limits/replay/capabilities populated).
// Adding an operation once therefore surfaces it in BOTH the agent and the
// registry. MCP consolidation is a later increment and is deliberately untouched.
//
// Each descriptor's `invoke` calls the matching MetaprojectPort method and FORMATS
// its structured result into the readable text the model needs; the formatters are
// shared with the agent tool factory (metaproject-tools.ts re-exports the same
// shapes). Descriptors validate against
// docs/requirements/keryx-metaproject-native/schemas/metaproject-operation.schema.json.

import type {
  GraphAffectedResult,
  GraphPathResult,
  GraphQueryResult,
  HealthStatusResult,
  MemorySearchResult,
  MetaprojectPort,
  TestRelatedResult,
  WikiPageResult,
} from "./metaproject-port";
import type { ToolDefinition } from "./types";
import type { InteractiveTool, InteractiveToolResult } from "./builtin/interactive-tools";

/**
 * A single metaproject operation descriptor — the source of truth projected into
 * the agent InteractiveTool set and the harness ToolRegistry. Mirrors
 * metaproject-operation.schema.json (name/module/description/risk/input+output
 * schema) and carries the port-bound `invoke`.
 */
export interface MetaprojectOperation {
  /** Stable operation name exposed to the model (e.g. graph_affected). */
  name: string;
  /** Owning metaproject module (facade backing the operation). */
  module: "gdgraph" | "gdctx" | "gdwiki" | "memory" | "health" | "testing" | "flow";
  /** Human/model-facing summary of what the operation does. */
  description: string;
  /** Metaproject reads are always `read`. */
  risk: "read";
  /** JSON Schema for the operation input (validated before invoke). */
  inputSchema: Record<string, unknown>;
  /** JSON Schema for the structured operation result. */
  outputSchema: Record<string, unknown>;
  /** Call the backing MetaprojectPort method and format the result to text. */
  invoke(port: MetaprojectPort, input: Record<string, unknown>): Promise<InteractiveToolResult>;
}

// --- shared input validation + formatters -------------------------------------

/** Require a non-empty string field from an operation input; else an error result. */
function requireString(
  input: Record<string, unknown>,
  key: string,
  op: string,
): { value: string } | { error: InteractiveToolResult } {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) {
    return { error: { output: `${op} requires a non-empty '${key}'`, isError: true } };
  }
  return { value };
}

/** Render a structured `graphAffected` result as readable text for the model. */
export function formatAffected(result: GraphAffectedResult): InteractiveToolResult {
  if (result.error !== undefined) {
    return { output: `graph_affected failed: ${result.error}`, isError: true };
  }
  if (result.affected.length === 0) {
    return { output: `No dependents found for ${result.target}.`, isError: false };
  }
  const header = `Blast radius of ${result.target} (depth ${result.depth ?? 1}, ${result.affected.length} dependent(s)):`;
  const lines = result.affected.map((node) => {
    const fanIn = node.fanIn !== undefined ? `, fanIn ${node.fanIn}` : "";
    return `  - ${node.path ?? node.id} (hop ${node.hop}${fanIn})`;
  });
  return { output: [header, ...lines].join("\n"), isError: false };
}

/** Render a structured `graphQuery` (cycles or orphans) result as readable text. */
export function formatQuery(result: GraphQueryResult): InteractiveToolResult {
  if (result.error !== undefined) {
    return { output: `graph_query failed: ${result.error}`, isError: true };
  }
  if (result.query === "orphans") {
    const orphans = result.orphans ?? [];
    if (orphans.length === 0) {
      return { output: "No orphan files found.", isError: false };
    }
    const lines = orphans.map((path) => `  - ${path}`);
    return { output: [`Orphan files (${orphans.length}):`, ...lines].join("\n"), isError: false };
  }
  const cycles = result.cycles ?? [];
  if (cycles.length === 0) {
    return { output: "No dependency cycles found.", isError: false };
  }
  const lines = cycles.map((cycle) => `  - ${cycle.join(" -> ")}`);
  return { output: [`Dependency cycles (${cycles.length}):`, ...lines].join("\n"), isError: false };
}

/** Render a structured `memorySearch` result as readable text for the model. */
export function formatMemory(result: MemorySearchResult): InteractiveToolResult {
  if (result.error !== undefined) {
    return { output: `memory_search failed: ${result.error}`, isError: true };
  }
  if (result.hits.length === 0) {
    return { output: `No memory entries matched "${result.query}".`, isError: false };
  }
  const header = `Memory hits for "${result.query}" (${result.hits.length}):`;
  const lines = result.hits.map((hit) => {
    const meta = [hit.type, hit.status].filter((v) => v !== undefined && v.length > 0).join("/");
    const suffix = meta.length > 0 ? ` [${meta}]` : "";
    const excerpt = hit.excerpt !== undefined && hit.excerpt.length > 0 ? ` — ${hit.excerpt}` : "";
    return `  - ${hit.title} (${hit.path}, score ${hit.score.toFixed(3)})${suffix}${excerpt}`;
  });
  return { output: [header, ...lines].join("\n"), isError: false };
}

/** Render a structured `readWiki` result as readable text for the model. */
export function formatWiki(result: WikiPageResult): InteractiveToolResult {
  if (result.isError) {
    return { output: result.error ?? `read_wiki failed for ${result.path}`, isError: true };
  }
  return { output: result.content.length > 0 ? result.content : "(empty page)", isError: false };
}

// --- object result schemas (structured tool output) ---------------------------

const AFFECTED_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    target: { type: "string" },
    depth: { type: "number" },
    ranked: { type: "boolean" },
    affected: { type: "array" },
    truncated: { type: "boolean" },
    error: { type: "string" },
  },
  required: ["target", "affected"],
};

const QUERY_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    query: { type: "string", enum: ["cycles", "orphans"] },
    orphans: { type: "array", items: { type: "string" } },
    cycles: { type: "array" },
    error: { type: "string" },
  },
  required: ["query"],
};

const MEMORY_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    query: { type: "string" },
    filters: { type: "object" },
    hits: { type: "array" },
    error: { type: "string" },
  },
  required: ["query", "hits"],
};

const WIKI_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    path: { type: "string" },
    content: { type: "string" },
    isError: { type: "boolean" },
    error: { type: "string" },
  },
  required: ["path", "content", "isError"],
};

const SEARCH_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    pattern: { type: "string" },
    path: { type: "string" },
    output: { type: "string" },
    isError: { type: "boolean" },
    truncated: { type: "boolean" },
  },
  required: ["pattern", "output", "isError"],
};

// --- the operation descriptors (single source of truth) -----------------------

/**
 * The metaproject operations, one descriptor each. Names + risk match the agent's
 * historical tools (search_code, graph_affected, memory_search) plus the two new
 * read operations (graph_query, read_wiki) that the port already backs.
 */
/** Render a `graphPath` result as readable text. */
export function formatPath(result: GraphPathResult): InteractiveToolResult {
  if (result.error !== undefined) {
    return { output: `graph_path failed: ${result.error}`, isError: true };
  }
  if (result.unresolved === true) {
    return { output: `graph_path: could not resolve ${result.from} or ${result.to}.`, isError: false };
  }
  if (result.nodes.length === 0) {
    return { output: `No path from ${result.from} to ${result.to}.`, isError: false };
  }
  return { output: `Path (${result.nodes.length} node(s)): ${result.nodes.join(" -> ")}`, isError: false };
}

/** Render a `testRelated` result as readable text. */
export function formatTestRelated(result: TestRelatedResult): InteractiveToolResult {
  if (result.error !== undefined) {
    return { output: `test_related failed: ${result.error}`, isError: true };
  }
  if (result.tests.length === 0) {
    return { output: `No related tests found for ${result.file}.`, isError: false };
  }
  const lines = result.tests.map((test) => `  - ${test}`);
  return { output: [`Related tests for ${result.file} (${result.tests.length}):`, ...lines].join("\n"), isError: false };
}

/** Render a `healthStatus` result as readable text. */
export function formatHealth(result: HealthStatusResult): InteractiveToolResult {
  if (result.error !== undefined) {
    return { output: `health_status failed: ${result.error}`, isError: true };
  }
  if (!result.enabled) {
    return { output: "Code Health is not enabled for this project.", isError: false };
  }
  const parts = [
    `gate: ${result.gate ?? "n/a"}`,
    `score: ${result.projectScore ?? "n/a"}`,
    `regressions: ${result.regressions}`,
    `last run: ${result.lastRunAt ?? "never"}`,
  ];
  return { output: `Code health — ${parts.join(", ")}.`, isError: false };
}

const PATH_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    from: { type: "string" },
    to: { type: "string" },
    nodes: { type: "array", items: { type: "string" } },
    unresolved: { type: "boolean" },
    error: { type: "string" },
  },
  required: ["from", "to", "nodes"],
};

const TEST_RELATED_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    file: { type: "string" },
    tests: { type: "array", items: { type: "string" } },
    error: { type: "string" },
  },
  required: ["file", "tests"],
};

const HEALTH_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    enabled: { type: "boolean" },
    lastRunAt: { type: ["string", "null"] },
    gate: { type: ["string", "null"] },
    sources: { type: "array" },
    projectScore: { type: ["number", "null"] },
    regressions: { type: "integer" },
    error: { type: "string" },
  },
  required: ["enabled", "lastRunAt", "gate", "sources", "projectScore", "regressions"],
};

export const METAPROJECT_OPERATIONS: MetaprojectOperation[] = [
  {
    name: "search_code",
    risk: "read",
    module: "gdctx",
    description:
      "Search the project's code/text (compact ripgrep via `keryx ctx rg`). Input: { pattern: string, path?: string } (path relative to the project root).",
    inputSchema: {
      type: "object",
      properties: { pattern: { type: "string" }, path: { type: "string" } },
      required: ["pattern"],
      additionalProperties: false,
    },
    outputSchema: SEARCH_OUTPUT_SCHEMA,
    invoke: async (port, input) => {
      const pattern = requireString(input, "pattern", "search_code");
      if ("error" in pattern) {
        return pattern.error;
      }
      const path = typeof input.path === "string" && input.path.length > 0 ? input.path : undefined;
      const result = await port.searchCode({
        pattern: pattern.value,
        ...(path !== undefined ? { path } : {}),
      });
      return { output: result.output, isError: result.isError };
    },
  },
  {
    name: "graph_affected",
    risk: "read",
    module: "gdgraph",
    description:
      "Show the blast radius (dependents) of a file via the code graph (`keryx gdgraph affected`). Input: { file: string } relative to the project root.",
    inputSchema: {
      type: "object",
      properties: { file: { type: "string" } },
      required: ["file"],
      additionalProperties: false,
    },
    outputSchema: AFFECTED_OUTPUT_SCHEMA,
    invoke: async (port, input) => {
      const file = requireString(input, "file", "graph_affected");
      if ("error" in file) {
        return file.error;
      }
      return formatAffected(await port.graphAffected({ target: file.value }));
    },
  },
  {
    name: "graph_query",
    risk: "read",
    module: "gdgraph",
    description:
      "Run a whole-graph query (`keryx gdgraph query`). Input: { query: \"cycles\" | \"orphans\" } — list dependency cycles or orphan files.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", enum: ["cycles", "orphans"] } },
      required: ["query"],
      additionalProperties: false,
    },
    outputSchema: QUERY_OUTPUT_SCHEMA,
    invoke: async (port, input) => {
      const query = input.query;
      if (query !== "cycles" && query !== "orphans") {
        return { output: "graph_query requires 'query' to be \"cycles\" or \"orphans\"", isError: true };
      }
      return formatQuery(await port.graphQuery({ query }));
    },
  },
  {
    name: "memory_search",
    risk: "read",
    module: "memory",
    description:
      "Search project memory — decisions, lessons, constraints (`keryx memory search`). Input: { query: string }.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
    outputSchema: MEMORY_OUTPUT_SCHEMA,
    invoke: async (port, input) => {
      const query = requireString(input, "query", "memory_search");
      if ("error" in query) {
        return query.error;
      }
      return formatMemory(await port.memorySearch({ query: query.value }));
    },
  },
  {
    name: "read_wiki",
    risk: "read",
    module: "gdwiki",
    description:
      "Read a project wiki page (architecture, domain, decisions) under .metaproject/wiki/. Input: { path: string } relative to the wiki root.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    outputSchema: WIKI_OUTPUT_SCHEMA,
    invoke: async (port, input) => {
      const path = requireString(input, "path", "read_wiki");
      if ("error" in path) {
        return path.error;
      }
      return formatWiki(await port.readWiki({ path: path.value }));
    },
  },
  {
    name: "graph_path",
    risk: "read",
    module: "gdgraph",
    description:
      "Show the dependency path between two files/symbols over the code graph (`keryx gdgraph path`). Input: { from: string, to: string }.",
    inputSchema: {
      type: "object",
      properties: { from: { type: "string" }, to: { type: "string" } },
      required: ["from", "to"],
      additionalProperties: false,
    },
    outputSchema: PATH_OUTPUT_SCHEMA,
    invoke: async (port, input) => {
      if (port.graphPath === undefined) {
        return { output: "graph_path is not available in this session.", isError: true };
      }
      const from = requireString(input, "from", "graph_path");
      if ("error" in from) {
        return from.error;
      }
      const to = requireString(input, "to", "graph_path");
      if ("error" in to) {
        return to.error;
      }
      return formatPath(await port.graphPath({ from: from.value, to: to.value }));
    },
  },
  {
    name: "test_related",
    risk: "read",
    module: "testing",
    description:
      "List the tests related to a file (naming + directory heuristic, `keryx test related`). Input: { file: string } relative to the project root.",
    inputSchema: {
      type: "object",
      properties: { file: { type: "string" } },
      required: ["file"],
      additionalProperties: false,
    },
    outputSchema: TEST_RELATED_OUTPUT_SCHEMA,
    invoke: async (port, input) => {
      if (port.testRelated === undefined) {
        return { output: "test_related is not available in this session.", isError: true };
      }
      const file = requireString(input, "file", "test_related");
      if ("error" in file) {
        return file.error;
      }
      return formatTestRelated(await port.testRelated({ file: file.value }));
    },
  },
  {
    name: "health_status",
    risk: "read",
    module: "health",
    description:
      "Show the latest code-health snapshot: gate, project score, regressions (`keryx health status`). No input.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: HEALTH_OUTPUT_SCHEMA,
    invoke: async (port) => {
      if (port.healthStatus === undefined) {
        return { output: "health_status is not available in this session.", isError: true };
      }
      return formatHealth(await port.healthStatus());
    },
  },
];

// --- pure projections ---------------------------------------------------------

/**
 * Project the descriptors into agent `InteractiveTool[]` bound to `port`. Each
 * tool's `invoke(input)` delegates to the descriptor's `invoke(port, input)`, so
 * the agent gets the same in-process, content-returning behavior with names/risk
 * carried straight from the descriptor.
 */
export function toInteractiveTools(
  ops: MetaprojectOperation[],
  port: MetaprojectPort,
): InteractiveTool[] {
  return ops.map((op) => ({
    definition: {
      name: op.name,
      description: op.description,
      inputSchema: op.inputSchema,
      risk: op.risk,
    },
    invoke: (input) => op.invoke(port, input),
  }));
}

/** Default per-operation budget for the harness registry projection. */
const OPERATION_LIMITS = {
  timeoutMs: 10_000,
  maxOutputBytes: 65_536,
} as const;

/**
 * Project the descriptors into harness `ToolDefinition[]` (ToolRegistry-ready).
 * `toolId` is namespaced `metaproject:<name>`; input/output schemas, risk, and
 * sane read-only limits/replay/capabilities are carried from the descriptor. Pure
 * and deterministic — no `port` and no side effects.
 */
export function toToolDefinitions(ops: MetaprojectOperation[]): ToolDefinition[] {
  return ops.map((op) => ({
    schemaVersion: 1,
    toolId: `metaproject:${op.name}`,
    version: "0.1.0",
    description: op.description,
    inputSchema: op.inputSchema,
    outputSchema: op.outputSchema,
    risk: op.risk,
    capabilities: ["read"],
    limits: {
      timeoutMs: OPERATION_LIMITS.timeoutMs,
      maxOutputBytes: OPERATION_LIMITS.maxOutputBytes,
      concurrencyKey: `metaproject:${op.name}`,
    },
    replay: { deterministic: true, recordedResultSupported: true },
    classification: {
      read: true,
      write: false,
      network: false,
      subprocess: false,
      credential: false,
    },
  }));
}
