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
  GraphSymbolResult,
  HealthStatusResult,
  MemorySearchResult,
  MetaprojectPort,
  RepomapResult,
  TestRelatedResult,
  WikiAskResult,
  WikiBacklinksResult,
  WikiPageResult,
} from "./metaproject-port";
import type { ToolDefinition } from "./types";
import type { InteractiveTool, InteractiveToolResult } from "./builtin/interactive-tools";

/**
 * Where the CLI verb an operation wraps is implemented, so the parity test can
 * read the verb's real option set out of the source instead of trusting a table.
 * `fn` names a top-level handler function; `guard` names the `if (...)` condition
 * of a verb dispatched inline in its command's router.
 */
export type CliHandlerLocation = { fn: string } | { guard: string };

/**
 * The declared parameter-parity contract between a metaproject tool and the
 * `keryx` verb it wraps.
 *
 * The rule this encodes (tool-surface.md §P4.1): **a tool that wraps a CLI verb
 * exposes that verb's arguments.** A tool weaker than its own CLI teaches the
 * model to bypass it through a default-deny shell — which is exactly what
 * benchmark case A1 recorded.
 *
 * `metaproject-operations.parity.test.ts` reads `source`/`handler` and fails when
 * the handler reads an option that is neither mapped in `expresses` nor listed
 * in `presentation`, so adding a CLI flag without widening the tool breaks the
 * build rather than the model's next run.
 */
export type MetaprojectCliParity =
  | {
      /** This operation wraps no CLI verb. */
      verb: null;
      /** Why there is nothing to be at parity with. */
      reason: string;
    }
  | {
      /** The wrapped verb, e.g. `gdgraph affected`. */
      verb: string;
      /** The file implementing the verb (repo-relative). */
      source: string;
      /** Where in `source` the verb's options are read. */
      handler: CliHandlerLocation;
      /** Extra helper functions in `source` that also read the verb's options. */
      helpers?: string[];
      /** CLI option → the input-schema property that expresses it. */
      expresses: Record<string, string>;
      /**
       * Options that shape only the CLI's own rendering (`--json`, …). A tool
       * returns structured data already, so these have no tool equivalent.
       */
      presentation?: string[];
    };

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
  /** The wrapped CLI verb and the parity contract with it (enforced by a test). */
  cliParity: MetaprojectCliParity;
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

/**
 * Read an optional positive integer (the shape every `--depth`/`--budget`/`--k`
 * style option has). A present-but-nonsensical value is dropped rather than
 * passed on, so the port sees "not asked for" instead of `depth: -1`.
 */
function optionalPositiveInt(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

/** Read an optional boolean field; anything else reads as "not asked for". */
function optionalBoolean(input: Record<string, unknown>, key: string): boolean | undefined {
  const value = input[key];
  return typeof value === "boolean" ? value : undefined;
}

/** Read an optional non-empty string field. */
function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Read an optional array of non-empty strings (empty ⇒ "not asked for"). */
function optionalStringArray(input: Record<string, unknown>, key: string): string[] | undefined {
  const value = input[key];
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value.filter((item): item is string => typeof item === "string" && item.length > 0);
  return items.length > 0 ? items : undefined;
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

/** Render a `graphSymbol` result as readable text. */
export function formatSymbol(result: GraphSymbolResult): InteractiveToolResult {
  if (result.error !== undefined) {
    return { output: `graph_symbol failed: ${result.error}`, isError: true };
  }
  if (result.definitions.length === 0) {
    return { output: `No symbol definition found for ${result.name}.`, isError: false };
  }
  const defs = result.definitions.map(
    (def) => `  - ${def.name} (${def.kind}) at ${def.path}:${def.startLine}`,
  );
  const lines = [`Symbol ${result.name} (${result.definitions.length} definition(s)):`, ...defs];
  if (result.callers.length > 0) {
    lines.push(`Callers (${result.callers.length}):`, ...result.callers.map((c) => `  - ${c}`));
  }
  if (result.callees.length > 0) {
    lines.push(`Callees (${result.callees.length}):`, ...result.callees.map((c) => `  - ${c}`));
  }
  if (result.impact !== undefined) {
    lines.push(
      `Impact — transitive callers, depth ${result.impactDepth ?? "?"} (${result.impact.length}):`,
      ...(result.impact.length > 0
        ? result.impact.map((node) => `  - [hop ${node.hop}] ${node.label}`)
        : ["  - none"]),
    );
  }
  return { output: lines.join("\n"), isError: false };
}

/** Render a `repomap` result as readable text. */
export function formatRepomap(result: RepomapResult): InteractiveToolResult {
  if (result.error !== undefined) {
    return { output: `repomap failed: ${result.error}`, isError: true };
  }
  if (result.files.length === 0) {
    return { output: "Repomap is empty (no ranked files).", isError: false };
  }
  const header = `Repomap (${result.files.length} file(s), ~${result.tokens} tokens, ${result.omitted} omitted):`;
  const lines = result.files.map((file) => {
    const symbols = file.symbols.length > 0 ? ` — ${file.symbols.join(", ")}` : "";
    return `  - ${file.path} (score ${file.score.toFixed(4)})${symbols}`;
  });
  return { output: [header, ...lines].join("\n"), isError: false };
}

/** Render a `wikiAsk` result as readable text. */
export function formatWikiAsk(result: WikiAskResult): InteractiveToolResult {
  if (result.error !== undefined) {
    return { output: `wiki_ask failed: ${result.error}`, isError: true };
  }
  return { output: result.answer.length > 0 ? result.answer : "(no answer)", isError: false };
}

/** Render a `wikiBacklinks` result as readable text. */
export function formatBacklinks(result: WikiBacklinksResult): InteractiveToolResult {
  if (result.error !== undefined) {
    return { output: `wiki_backlinks failed: ${result.error}`, isError: true };
  }
  if (result.backlinks.length === 0) {
    return { output: `No wiki pages reference ${result.file}.`, isError: false };
  }
  const lines = result.backlinks.map((page) => `  - ${page}`);
  return {
    output: [`Wiki pages referencing ${result.file} (${result.backlinks.length}):`, ...lines].join("\n"),
    isError: false,
  };
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

const SYMBOL_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    name: { type: "string" },
    definitions: { type: "array" },
    callers: { type: "array", items: { type: "string" } },
    callees: { type: "array", items: { type: "string" } },
    impact: { type: "array" },
    impactDepth: { type: "integer" },
    error: { type: "string" },
  },
  required: ["name", "definitions", "callers", "callees"],
};

const REPOMAP_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    budget: { type: "number" },
    files: { type: "array" },
    tokens: { type: "integer" },
    omitted: { type: "integer" },
    error: { type: "string" },
  },
  required: ["budget", "files", "tokens", "omitted"],
};

const WIKI_ASK_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    question: { type: "string" },
    citations: { type: "array" },
    answer: { type: "string" },
    error: { type: "string" },
  },
  required: ["question", "citations", "answer"],
};

const WIKI_BACKLINKS_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    file: { type: "string" },
    backlinks: { type: "array", items: { type: "string" } },
    error: { type: "string" },
  },
  required: ["file", "backlinks"],
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
    cliParity: {
      verb: "ctx rg",
      source: "src/commands/ctx.ts",
      handler: { fn: "rgAndSummarize" },
      expresses: {},
      presentation: ["--json"],
    },
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
      'Answer "what breaks if I change X" / "what depends on X, directly and transitively" from the code graph (`keryx gdgraph affected`). ' +
      "Input: { file: string, depth?: number, ranked?: boolean } — `file` relative to the project root, `depth` the number of dependency hops " +
      "(1 = direct dependents only; use 2+ for transitive), `ranked` to order the blast radius by hop then fan-in.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string" },
        depth: { type: "integer", minimum: 1 },
        ranked: { type: "boolean" },
      },
      required: ["file"],
      additionalProperties: false,
    },
    outputSchema: AFFECTED_OUTPUT_SCHEMA,
    cliParity: {
      verb: "gdgraph affected",
      source: "src/commands/gdgraph.ts",
      handler: { fn: "runAffected" },
      expresses: { "--depth": "depth", "--ranked": "ranked" },
      presentation: ["--json"],
    },
    invoke: async (port, input) => {
      const file = requireString(input, "file", "graph_affected");
      if ("error" in file) {
        return file.error;
      }
      const depth = optionalPositiveInt(input, "depth");
      const ranked = optionalBoolean(input, "ranked");
      return formatAffected(
        await port.graphAffected({
          target: file.value,
          ...(depth !== undefined ? { depth } : {}),
          ...(ranked !== undefined ? { ranked } : {}),
        }),
      );
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
    cliParity: {
      verb: "gdgraph query",
      source: "src/commands/gdgraph.ts",
      // Dispatched inline in the gdgraph router rather than via a named handler.
      handler: { guard: 'command === "query"' },
      expresses: {},
      presentation: ["--json"],
    },
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
      'Answer "was this decided before" / "what did we learn about X" from project memory — decisions, lessons, constraints, known mistakes ' +
      "(`keryx memory search`). Input: { query: string, module?: string, entity?: string, status?: string, class?: string, limit?: number, " +
      'asOf?: string (YYYY-MM-DD), semantic?: boolean }. Use `status: "accepted"` for settled decisions.',
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        module: { type: "string" },
        entity: { type: "string" },
        status: { type: "string" },
        class: { type: "string", enum: ["semantic", "episodic", "procedural"] },
        limit: { type: "integer", minimum: 1 },
        asOf: { type: "string" },
        semantic: { type: "boolean" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    outputSchema: MEMORY_OUTPUT_SCHEMA,
    cliParity: {
      verb: "memory search",
      source: "src/commands/memory.ts",
      handler: { fn: "runSearch" },
      expresses: {
        "--module": "module",
        "--entity": "entity",
        "--status": "status",
        "--class": "class",
        "--limit": "limit",
        "--as-of": "asOf",
        "--semantic": "semantic",
      },
      presentation: ["--json"],
    },
    invoke: async (port, input) => {
      const query = requireString(input, "query", "memory_search");
      if ("error" in query) {
        return query.error;
      }
      const module = optionalString(input, "module");
      const entity = optionalString(input, "entity");
      const status = optionalString(input, "status");
      const cls = optionalString(input, "class");
      const limit = optionalPositiveInt(input, "limit");
      const asOf = optionalString(input, "asOf");
      const semantic = optionalBoolean(input, "semantic");
      return formatMemory(
        await port.memorySearch({
          query: query.value,
          ...(module !== undefined ? { module } : {}),
          ...(entity !== undefined ? { entity } : {}),
          ...(status !== undefined ? { status } : {}),
          ...(cls !== undefined ? { class: cls } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(asOf !== undefined ? { asOf } : {}),
          ...(semantic !== undefined ? { semantic } : {}),
        }),
      );
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
    cliParity: {
      verb: null,
      reason:
        "read_wiki is a root-confined file read under .metaproject/wiki/, not a wrapper around a `keryx wiki` verb.",
    },
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
    cliParity: {
      verb: "gdgraph path",
      source: "src/commands/gdgraph.ts",
      handler: { fn: "runPath" },
      expresses: {},
    },
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
    cliParity: {
      verb: "test related",
      source: "src/commands/test.ts",
      handler: { fn: "runRelated" },
      expresses: {},
    },
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
    cliParity: {
      verb: "health status",
      source: "src/commands/health.ts",
      handler: { fn: "runStatus" },
      expresses: {},
    },
    invoke: async (port) => {
      if (port.healthStatus === undefined) {
        return { output: "health_status is not available in this session.", isError: true };
      }
      return formatHealth(await port.healthStatus());
    },
  },
  {
    name: "graph_symbol",
    risk: "read",
    module: "gdgraph",
    description:
      'Answer "where is this function defined" / "who calls it" over the code-graph symbol layer (`keryx gdgraph symbol`). ' +
      "Input: { name: string, impact?: boolean, depth?: number } — set `impact` for the transitive-caller blast radius, " +
      "`depth` for how many call hops it walks (default 3).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        impact: { type: "boolean" },
        depth: { type: "integer", minimum: 1 },
      },
      required: ["name"],
      additionalProperties: false,
    },
    outputSchema: SYMBOL_OUTPUT_SCHEMA,
    cliParity: {
      verb: "gdgraph symbol",
      source: "src/commands/gdgraph.ts",
      handler: { fn: "runSymbol" },
      expresses: { "--impact": "impact", "--depth": "depth" },
    },
    invoke: async (port, input) => {
      if (port.graphSymbol === undefined) {
        return { output: "graph_symbol is not available in this session.", isError: true };
      }
      const name = requireString(input, "name", "graph_symbol");
      if ("error" in name) {
        return name.error;
      }
      const impact = optionalBoolean(input, "impact");
      const depth = optionalPositiveInt(input, "depth");
      return formatSymbol(
        await port.graphSymbol({
          name: name.value,
          ...(impact !== undefined ? { impact } : {}),
          ...(depth !== undefined ? { depth } : {}),
        }),
      );
    },
  },
  {
    name: "repomap",
    risk: "read",
    module: "gdgraph",
    description:
      'Answer "give me a map of this repo in N tokens" — ranked top files + symbols by PageRank (`keryx gdgraph repomap`). ' +
      "Input: { budget?: number, seed?: string[] } — `budget` the token budget, `seed` files to bias the ranking towards " +
      "(pass the files you are working on).",
    inputSchema: {
      type: "object",
      properties: {
        budget: { type: "integer", minimum: 1 },
        seed: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    },
    outputSchema: REPOMAP_OUTPUT_SCHEMA,
    cliParity: {
      verb: "gdgraph repomap",
      source: "src/commands/gdgraph.ts",
      handler: { fn: "runRepomap" },
      helpers: ["collectSeeds"],
      expresses: {
        "--budget": "budget",
        "--seed": "seed",
        // `--changed` is CLI sugar: it seeds the ranking with the git-changed
        // files. A tool caller passes those files to `seed` directly, so the
        // question the flag asks is expressible — running git is not the tool's
        // job, and a `risk: "read"` tool must not shell out to find out.
        "--changed": "seed",
      },
    },
    invoke: async (port, input) => {
      if (port.repomap === undefined) {
        return { output: "repomap is not available in this session.", isError: true };
      }
      const budget = optionalPositiveInt(input, "budget");
      const seed = optionalStringArray(input, "seed");
      return formatRepomap(
        await port.repomap({
          ...(budget !== undefined ? { budget } : {}),
          ...(seed !== undefined ? { seed } : {}),
        }),
      );
    },
  },
  {
    name: "wiki_ask",
    risk: "read",
    module: "gdwiki",
    description:
      'Answer "how does X work here" / "why was it built this way" from the project\'s own wiki + memory, with citations ' +
      "(`keryx wiki ask`). Input: { question: string, k?: number, rerank?: boolean } — `k` how many citations to consider, " +
      "`rerank` to apply the embedding rerank over the lexical set.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string" },
        k: { type: "integer", minimum: 1 },
        rerank: { type: "boolean" },
      },
      required: ["question"],
      additionalProperties: false,
    },
    outputSchema: WIKI_ASK_OUTPUT_SCHEMA,
    cliParity: {
      verb: "wiki ask",
      source: "src/commands/wiki.ts",
      handler: { fn: "runAsk" },
      expresses: { "--k": "k", "--rerank": "rerank" },
    },
    invoke: async (port, input) => {
      if (port.wikiAsk === undefined) {
        return { output: "wiki_ask is not available in this session.", isError: true };
      }
      const question = requireString(input, "question", "wiki_ask");
      if ("error" in question) {
        return question.error;
      }
      const k = optionalPositiveInt(input, "k");
      const rerank = optionalBoolean(input, "rerank");
      return formatWikiAsk(
        await port.wikiAsk({
          question: question.value,
          ...(k !== undefined ? { k } : {}),
          ...(rerank !== undefined ? { rerank } : {}),
        }),
      );
    },
  },
  {
    name: "wiki_backlinks",
    risk: "read",
    module: "gdwiki",
    description:
      "List the wiki pages that reference a repo file — the reverse \"documented in\" lookup (`keryx wiki backlinks`). Input: { file: string } relative to the project root.",
    inputSchema: {
      type: "object",
      properties: { file: { type: "string" } },
      required: ["file"],
      additionalProperties: false,
    },
    outputSchema: WIKI_BACKLINKS_OUTPUT_SCHEMA,
    cliParity: {
      verb: "wiki backlinks",
      source: "src/commands/wiki.ts",
      handler: { fn: "runBacklinks" },
      expresses: {},
    },
    invoke: async (port, input) => {
      if (port.wikiBacklinks === undefined) {
        return { output: "wiki_backlinks is not available in this session.", isError: true };
      }
      const file = requireString(input, "file", "wiki_backlinks");
      if ("error" in file) {
        return file.error;
      }
      return formatBacklinks(await port.wikiBacklinks({ file: file.value }));
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
