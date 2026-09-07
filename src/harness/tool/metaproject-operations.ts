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

import { STALE_NOTE, UNKNOWN_NOTE } from "../../gdgraph/staleness";
import type {
  FlowStatusResult,
  GraphAffectedResult,
  GraphPathResult,
  GraphQueryResult,
  GraphStaleness,
  GraphSymbolResult,
  HealthStatusResult,
  MemorySearchResult,
  MetaprojectPort,
  RepomapResult,
  SkillLoadResult,
  SkillsCatalogResult,
  TestRelatedResult,
  WikiAskResult,
  WikiBacklinksResult,
  WikiPageResult,
  WikiFreshnessResult,} from "./metaproject-port";
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
  // Note: the wiki facade is "gdwiki" internally but this tag deliberately uses the MCP
  // discovery layer's alias "wiki" (src/mcp/discovery.ts MODULE_MANIFEST_KEY, mirroring
  // "flow" -> "tasks") — the same convention every wiki-related MCP tool already follows.
  module: "gdgraph" | "gdctx" | "wiki" | "memory" | "health" | "testing" | "flow" | "gdskills";
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

/**
 * Render the tri-state graph freshness exactly as the command line does
 * (`printStaleNote`, `src/commands/gdgraph.ts`), reusing `STALE_NOTE` /
 * `UNKNOWN_NOTE` verbatim rather than re-wording them here — an `unknown`
 * check must never read as the confident "the repo moved" claim, and a fresh
 * graph must add no noise at all.
 */
function stalenessLines(staleness: GraphStaleness | undefined): string[] {
  if (staleness === undefined || staleness.status === "fresh") {
    return [];
  }
  return [
    "",
    staleness.status === "unknown" ? UNKNOWN_NOTE : STALE_NOTE,
    ...staleness.reasons.map((reason) => `  - ${reason}`),
  ];
}

/** Append the freshness note (if any) to an already-rendered graph result. */
function withStaleness(
  result: InteractiveToolResult,
  staleness: GraphStaleness | undefined,
): InteractiveToolResult {
  const extra = stalenessLines(staleness);
  return extra.length === 0 ? result : { ...result, output: [result.output, ...extra].join("\n") };
}

/** Render a structured `graphAffected` result as readable text for the model. */
export function formatAffected(result: GraphAffectedResult): InteractiveToolResult {
  if (result.error !== undefined) {
    return withStaleness({ output: `graph_affected failed: ${result.error}`, isError: true }, result.staleness);
  }
  const dependencies = result.dependencies ?? [];
  // The dependencies half is printed by the CLI and by MCP `gdgraph.affected`;
  // this boundary used to return dependents only, so "no dependents" read as
  // "nothing to see" even when the target imported a dozen files.
  const dependencyLines =
    dependencies.length > 0
      ? [`Dependencies of ${result.target} (${dependencies.length}):`, ...dependencies.map((path) => `  - ${path}`), ""]
      : [];
  if (result.affected.length === 0) {
    return withStaleness(
      { output: [...dependencyLines, `No dependents found for ${result.target}.`].join("\n"), isError: false },
      result.staleness,
    );
  }
  const header = `Blast radius of ${result.target} (depth ${result.depth ?? 1}, ${result.affected.length} dependent(s)):`;
  const lines = result.affected.map((node) => {
    const fanIn = node.fanIn !== undefined ? `, fanIn ${node.fanIn}` : "";
    return `  - ${node.path ?? node.id} (hop ${node.hop}${fanIn})`;
  });
  return withStaleness(
    { output: [...dependencyLines, header, ...lines].join("\n"), isError: false },
    result.staleness,
  );
}

/** Render a structured `graphQuery` (cycles or orphans) result as readable text. */
export function formatQuery(result: GraphQueryResult): InteractiveToolResult {
  if (result.error !== undefined) {
    return withStaleness({ output: `graph_query failed: ${result.error}`, isError: true }, result.staleness);
  }
  if (result.query === "orphans") {
    const orphans = result.orphans ?? [];
    if (orphans.length === 0) {
      return withStaleness({ output: "No orphan files found.", isError: false }, result.staleness);
    }
    const lines = orphans.map((path) => `  - ${path}`);
    return withStaleness(
      { output: [`Orphan files (${orphans.length}):`, ...lines].join("\n"), isError: false },
      result.staleness,
    );
  }
  const cycles = result.cycles ?? [];
  if (cycles.length === 0) {
    return withStaleness({ output: "No dependency cycles found.", isError: false }, result.staleness);
  }
  const lines = cycles.map((cycle) => `  - ${cycle.join(" -> ")}`);
  return withStaleness(
    { output: [`Dependency cycles (${cycles.length}):`, ...lines].join("\n"), isError: false },
    result.staleness,
  );
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
  const lines = result.hits.flatMap((hit) => {
    const meta = [hit.type, hit.status].filter((v) => v !== undefined && v.length > 0).join("/");
    const suffix = meta.length > 0 ? ` [${meta}]` : "";
    const excerpt = hit.excerpt !== undefined && hit.excerpt.length > 0 ? ` — ${hit.excerpt}` : "";
    const rows = [`  - ${hit.title} (${hit.path}, score ${hit.score.toFixed(3)})${suffix}${excerpt}`];
    // F-002 (flow 234 review, BLOCKER) / AFC-25 / AC6: provenance always
    // renders on its own line when the adapter populated it — mirroring
    // memory/report.ts's renderMemorySearchReportMarkdown shape rather than
    // inventing a second one — so a council-confirmed, sourced, versioned
    // entry reads as visibly distinct from an unsourced one instead of
    // arriving byte-identical. A hit built by a port implementation that
    // predates this field (no `version`/`provenance`/`author`/`confirmedBy`
    // at all) still renders as before — this is additive, not a new
    // required shape.
    if (hit.version !== undefined || hit.provenance !== undefined || hit.author !== undefined || hit.confirmedBy !== undefined) {
      rows.push(
        `    version: ${hit.version ?? "unknown"} | provenance: source=${hit.provenance?.source ?? "unknown"} link=${hit.provenance?.link ?? "unknown"} author=${hit.author ?? "unknown"} confirmedBy=${hit.confirmedBy ?? "unknown"}`,
      );
      if (hit.caveat) {
        rows.push(`    caveat: ${hit.caveat}`);
      }
    }
    return rows;
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

/** Render a structured `skillsCatalog` result as readable text for the model. */
export function formatSkillsCatalog(result: SkillsCatalogResult): InteractiveToolResult {
  if (result.skills.length === 0) {
    return { output: "No skills found under .metaproject/skills/gdskills/.", isError: false };
  }
  const lines = result.skills.map((skill) => {
    const triggers = skill.triggers !== undefined && skill.triggers.length > 0 ? ` [triggers: ${skill.triggers.join(", ")}]` : "";
    return `  - ${skill.name} (${skill.category}) — ${skill.description || "(no description)"}${triggers}\n    ${skill.path}`;
  });
  return { output: [`Skills (${result.skills.length}):`, ...lines].join("\n"), isError: false };
}

/** Render a structured `skillLoad` result as readable text for the model. */
export function formatSkillLoad(result: SkillLoadResult): InteractiveToolResult {
  if (!result.found) {
    return { output: `skill_load: no skill found for '${result.name}'.`, isError: true };
  }
  return { output: result.content, isError: false };
}

// --- object result schemas (structured tool output) ---------------------------

/**
 * Tri-state graph freshness on every graph-backed result (flow 235 T8).
 * Declared once and spread into each graph output schema, so a new graph
 * operation cannot quietly ship without it.
 */
const STALENESS_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["fresh", "stale", "unknown"] },
    reasons: { type: "array", items: { type: "string" } },
  },
  required: ["status", "reasons"],
};

const AFFECTED_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    target: { type: "string" },
    depth: { type: "number" },
    ranked: { type: "boolean" },
    affected: { type: "array" },
    dependencies: { type: "array", items: { type: "string" } },
    truncated: { type: "boolean" },
    staleness: STALENESS_OUTPUT_SCHEMA,
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
    staleness: STALENESS_OUTPUT_SCHEMA,
    error: { type: "string" },
  },
  required: ["query"],
};

const MEMORY_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    query: { type: "string" },
    filters: { type: "object" },
    hits: {
      type: "array",
      // F-002 (flow 234 review, BLOCKER): widened alongside MemorySearchHit —
      // provenance fields are additive and optional (a hit predating this fix
      // still validates), never a second, divergent output shape.
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          title: { type: "string" },
          type: { type: "string" },
          status: { type: "string" },
          score: { type: "number" },
          excerpt: { type: "string" },
          version: { type: "string" },
          provenance: {
            type: "object",
            properties: { source: { type: "string" }, link: { type: "string" } },
          },
          author: { type: "string" },
          confirmedBy: { type: "string" },
          caveat: { type: ["string", "null"] },
        },
        required: ["path", "title", "score"],
      },
    },
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
    return withStaleness({ output: `graph_path failed: ${result.error}`, isError: true }, result.staleness);
  }
  if (result.unresolved === true) {
    return withStaleness(
      { output: `graph_path: could not resolve ${result.from} or ${result.to}.`, isError: false },
      result.staleness,
    );
  }
  if (result.nodes.length === 0) {
    return withStaleness(
      { output: `No path from ${result.from} to ${result.to}.`, isError: false },
      result.staleness,
    );
  }
  return withStaleness(
    { output: `Path (${result.nodes.length} node(s)): ${result.nodes.join(" -> ")}`, isError: false },
    result.staleness,
  );
}

/** Render a `testRelated` result as readable text. */
export function formatTestRelated(result: TestRelatedResult): InteractiveToolResult {
  if (result.error !== undefined) {
    return { output: `test_related failed: ${result.error}`, isError: true };
  }
  const lines: string[] = [];
  // F-003 (flow 234 review, MAJOR) / AC2: branch on an incomplete
  // testing-context refresh BEFORE the "no related tests" empty branch below.
  // An agent asking which tests cover a file, over a subtree the walk could
  // not read, must be told the answer may be missing tests — never handed a
  // legitimate-looking empty result with no error and nothing to distinguish
  // it from "this file genuinely has none".
  if (result.context?.status === "incomplete") {
    lines.push(
      "INCOMPLETE: the testing context could not be fully refreshed — this answer may be missing tests:",
      ...result.context.incompleteReasons.map((reason) => `  - ${reason}`),
      "",
    );
  }
  if (result.tests.length === 0) {
    lines.push(`No related tests found for ${result.file}.`);
    return { output: lines.join("\n"), isError: false };
  }
  lines.push(`Related tests for ${result.file} (${result.tests.length}):`, ...result.tests.map((test) => `  - ${test}`));
  return { output: lines.join("\n"), isError: false };
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
    // `regressions` is the deprecated alias; print the two real counters
    // alongside it rather than letting the alias stand in for both.
    `declining scopes: ${result.decliningScopes ?? result.regressions}`,
    `regressed scopes: ${result.regressedScopes ?? "n/a"}`,
    `last run: ${result.lastRunAt ?? "never"}`,
  ];
  return { output: `Code health — ${parts.join(", ")}.`, isError: false };
}

/** Render a `flowStatus` result as readable text. */
export function formatFlowStatus(result: FlowStatusResult): InteractiveToolResult {
  if (result.error !== undefined) {
    return { output: `flow_status failed: ${result.error}`, isError: true };
  }
  if (result.flows.length === 0) {
    return { output: "No matching flows.", isError: false };
  }
  const lines = result.flows.map(
    (f) =>
      `  - ${f.id}${f.slug !== undefined ? ` (${f.slug})` : ""} [${f.status}] ${f.title} ` +
      `(${f.tasksDone}/${f.tasksTotal} tasks)`,
  );
  return { output: [`Flows (${result.flows.length}):`, ...lines].join("\n"), isError: false };
}

/** Render a `graphSymbol` result as readable text. */
export function formatSymbol(result: GraphSymbolResult): InteractiveToolResult {
  if (result.error !== undefined) {
    return withStaleness({ output: `graph_symbol failed: ${result.error}`, isError: true }, result.staleness);
  }
  if (result.definitions.length === 0) {
    return withStaleness(
      { output: `No symbol definition found for ${result.name}.`, isError: false },
      result.staleness,
    );
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
  return withStaleness({ output: lines.join("\n"), isError: false }, result.staleness);
}

/** Render a `repomap` result as readable text. */
export function formatRepomap(result: RepomapResult): InteractiveToolResult {
  if (result.error !== undefined) {
    return withStaleness({ output: `repomap failed: ${result.error}`, isError: true }, result.staleness);
  }
  // AFC-12: a required entry that does not fit is `budget-exceeded`, NOT a
  // success with a truncated required set. Before this branch existed the
  // adapter dropped `overflow` entirely and an overflow rendered as the same
  // "Repomap is empty (no ranked files)." text as a genuinely empty map.
  if (result.overflow !== undefined) {
    return withStaleness(
      {
        output: [
          `repomap: ${result.overflow.code} — the required entry "${result.overflow.requiredId}" does not fit within the ${result.budget}-token budget.`,
          "No entries were returned: a partial required set is never reported as a map.",
          "Raise `budget`, or narrow `seed`, and retry.",
        ].join("\n"),
        isError: true,
      },
      result.staleness,
    );
  }
  if (result.files.length === 0) {
    return withStaleness({ output: "Repomap is empty (no ranked files).", isError: false }, result.staleness);
  }
  const partial = result.partial === true;
  const header =
    `Repomap${partial ? " [PARTIAL]" : ""} (${result.files.length} file(s), ~${result.tokens} tokens, ` +
    `${result.omitted} omitted):`;
  const lines = result.files.map((file) => {
    const symbols = file.symbols.length > 0 ? ` — ${file.symbols.join(", ")}` : "";
    // `required` is why the entry survived; without it a protected seed and a
    // high-scoring incidental file were indistinguishable.
    const marker = file.required === true ? " [required]" : "";
    return `  - ${file.path} (score ${file.score.toFixed(4)})${marker}${symbols}`;
  });
  const omittedOptional = result.omittedOptional ?? [];
  const lossLines =
    omittedOptional.length > 0
      ? [
          "",
          `PARTIAL — ${omittedOptional.length} optional entr${omittedOptional.length === 1 ? "y" : "ies"} omitted for budget:`,
          ...omittedOptional.slice(0, 40).map((path) => `  - ${path}`),
          ...(omittedOptional.length > 40 ? [`  - … +${omittedOptional.length - 40} more`] : []),
        ]
      : [];
  return withStaleness(
    { output: [header, ...lines, ...lossLines].join("\n"), isError: false },
    result.staleness,
  );
}

/** Render a `wikiAsk` result as readable text. */
export function formatWikiAsk(result: WikiAskResult): InteractiveToolResult {
  if (result.error !== undefined) {
    return { output: `wiki_ask failed: ${result.error}`, isError: true };
  }
  const lines: string[] = [];
  // AFC-M03: the retrieval outcome is a CODE, and it must be legible as one
  // rather than only inferable from the prose. A stop-word-only query and a
  // real answer used to be the same shape at this boundary.
  if (result.status !== undefined && result.status !== "ok") {
    lines.push(
      `RETRIEVAL: ${result.status}${result.reason !== undefined ? ` — ${result.reason}` : ""}`,
      "",
    );
  }
  lines.push(result.answer.length > 0 ? result.answer : "(no answer)");
  // AFC-06: the CLI marks a non-current citation `[HISTORICAL — not current]`.
  // These fields used to be dropped by the adapter's five-field re-map, so the
  // agent surface presented superseded guidance as current.
  const historical = result.citations.filter((citation) => citation.historical === true);
  if (historical.length > 0) {
    lines.push(
      "",
      `NOT CURRENT — ${historical.length} of ${result.citations.length} citation(s) are historical and are not confirmed guidance:`,
      ...historical.map((citation) => {
        const state = citation.lifecycleState !== undefined ? ` [${citation.lifecycleState}]` : "";
        const why =
          citation.lifecycleReasons !== undefined && citation.lifecycleReasons.length > 0
            ? ` — ${citation.lifecycleReasons.join("; ")}`
            : "";
        return `  - ${citation.sectionRef ?? citation.path}${state}${why}`;
      }),
    );
  }
  return { output: lines.join("\n"), isError: false };
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
    staleness: STALENESS_OUTPUT_SCHEMA,
    error: { type: "string" },
  },
  required: ["from", "to", "nodes"],
};

const TEST_RELATED_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    file: { type: "string" },
    tests: { type: "array", items: { type: "string" } },
    // F-003 (flow 234 review, MAJOR): widened alongside TestRelatedResult —
    // an incomplete testing-context refresh must be visible in the
    // structured result, not just the rendered text.
    context: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["complete", "incomplete"] },
        incompleteReasons: { type: "array", items: { type: "string" } },
      },
    },
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
    decliningScopes: { type: "integer" },
    regressedScopes: { type: "integer" },
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
    staleness: STALENESS_OUTPUT_SCHEMA,
    error: { type: "string" },
  },
  required: ["name", "definitions", "callers", "callees"],
};

const REPOMAP_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    budget: { type: "number" },
    files: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          score: { type: "number" },
          symbols: { type: "array", items: { type: "string" } },
          // AFC-12: protected from budget/rank eviction, not merely top-ranked.
          required: { type: "boolean" },
        },
        required: ["path", "score", "symbols"],
      },
    },
    tokens: { type: "integer" },
    omitted: { type: "integer" },
    seed: { type: "array", items: { type: "string" } },
    // AFC-12 loss markers — named loss, the partial flag, and the mandatory
    // overflow that must never render as an ordinary success.
    omittedOptional: { type: "array", items: { type: "string" } },
    partial: { type: "boolean" },
    overflow: {
      type: "object",
      properties: {
        code: { type: "string", enum: ["context_overflow"] },
        requiredId: { type: "string" },
      },
      required: ["code", "requiredId"],
    },
    staleness: STALENESS_OUTPUT_SCHEMA,
    error: { type: "string" },
  },
  required: ["budget", "files", "tokens", "omitted"],
};

const WIKI_ASK_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    question: { type: "string" },
    // AFC-M03: the retrieval outcome as a code, not a shape to infer.
    status: { type: "string", enum: ["ok", "no-match", "insufficient-evidence"] },
    reason: { type: "string" },
    citations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          title: { type: "string" },
          excerpt: { type: "string" },
          score: { type: "number" },
          source: { type: "string", enum: ["wiki", "memory"] },
          matched: { type: "array", items: { type: "string" } },
          sectionId: { type: "string" },
          sectionRef: { type: "string" },
          sectionTitle: { type: "string" },
          sectionStability: { type: "string", enum: ["stable", "version-bound"] },
          contentClass: { type: "string", enum: ["substantive", "scaffold", "reference"] },
          domain: { type: "string" },
          startLine: { type: "integer" },
          endLine: { type: "integer" },
          // AFC-06: the "not current" signal the CLI renders.
          historical: { type: "boolean" },
          lifecycleState: { type: "string" },
          lifecycleReasons: { type: "array", items: { type: "string" } },
        },
        required: ["path", "title", "excerpt", "score", "source"],
      },
    },
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

const FLOW_STATUS_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    flows: { type: "array" },
    error: { type: "string" },
  },
  required: ["flows"],
};

// Mirrors docs/requirements/keryx-skills-runtime-tools/schemas/skills-catalog-result.schema.json
const SKILLS_CATALOG_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    skills: { type: "array" },
    generatedAt: { type: "string" },
  },
  required: ["skills", "generatedAt"],
};

// Mirrors docs/requirements/keryx-skills-runtime-tools/schemas/skill-load-result.schema.json
const SKILL_LOAD_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    name: { type: "string" },
    path: { type: "string" },
    content: { type: "string" },
    found: { type: "boolean" },
  },
  required: ["name", "path", "content", "found"],
};

export const METAPROJECT_OPERATIONS: MetaprojectOperation[] = [
  {
    name: "search_code",
    risk: "read",
    module: "gdctx",
    description:
      "Search the project's code/text with ripgrep. Input: { pattern: string, path?: string } (path relative " +
      "to the project root). A completed search with no hits comes back as a SUCCESS whose output says so — " +
      "an `isError` result means the search could not run (bad regex, ripgrep missing, path outside the " +
      "project), never that there was nothing to find.",
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
      "Show the blast radius of a file via the code graph (`keryx gdgraph affected`): its dependents AND " +
      "its dependencies. Input: { file: string } relative to the project root, plus the same knobs the CLI " +
      "takes — { depth?: integer } to widen the transitive closure and { ranked?: boolean } to turn off the " +
      "hop/fanIn ranking. The result carries the graph's freshness: read `staleness` before quoting it, and " +
      "treat `unknown` as \"could not be determined\", never as fresh.",
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
    invoke: async (port, input) => {
      const file = requireString(input, "file", "graph_affected");
      if ("error" in file) {
        return file.error;
      }
      // `depth`/`ranked` have always been on the port and on the CLI; this
      // dispatch used to drop them, so a caller could never widen the closure.
      const depth = typeof input.depth === "number" && input.depth > 0 ? input.depth : undefined;
      const ranked = typeof input.ranked === "boolean" ? input.ranked : undefined;
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
      "Search project memory — decisions, lessons, constraints (`keryx memory search`). Input: " +
      "{ query: string, module?: string, class?: \"semantic\"|\"episodic\"|\"procedural\", limit?: integer } — " +
      "the same narrowing the CLI offers. Automatic recall is always bounded to accepted, current entries.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        module: { type: "string" },
        class: { type: "string", enum: ["semantic", "episodic", "procedural"] },
        limit: { type: "integer", minimum: 1 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    outputSchema: MEMORY_OUTPUT_SCHEMA,
    invoke: async (port, input) => {
      const query = requireString(input, "query", "memory_search");
      if ("error" in query) {
        return query.error;
      }
      // The port has accepted module/class/limit since flow 037; only this
      // dispatch's schema withheld them, so no agent could narrow a search.
      // `status` is deliberately NOT exposed: the adapter admits `accepted`
      // only, so a knob with one legal value would be a false affordance.
      const module = typeof input.module === "string" && input.module.length > 0 ? input.module : undefined;
      const cls = typeof input.class === "string" && input.class.length > 0 ? input.class : undefined;
      const limit = typeof input.limit === "number" ? input.limit : undefined;
      return formatMemory(
        await port.memorySearch({
          query: query.value,
          ...(module !== undefined ? { module } : {}),
          ...(cls !== undefined ? { class: cls } : {}),
          ...(limit !== undefined ? { limit } : {}),
        }),
      );
    },
  },
  {
    name: "read_wiki",
    risk: "read",
    module: "wiki",
    description:
      "Read a project wiki page (architecture, domain, decisions) under .metaproject/wiki/. Input: { path: string } " +
      "relative to the wiki root — you must already know the EXACT page path. If you don't, use wiki_ask with a " +
      "plain-language question instead: it finds and cites the right page(s) for you.",
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
    name: "wiki_freshness",
    risk: "read",
    module: "wiki",
    description:
      "Ask whether wiki pages are current before trusting one as context. Returns the LAST freshness report: " +
      "per-page category (stale-reference | stale-prose | undocumented | orphan | unknown), confidence, how many " +
      "commits behind, and why. ALWAYS read `limitations` — an empty finding list with a non-empty `limitations` " +
      "means the check could not run, not that the wiki is fresh. A page reported `stale-*` may describe code that " +
      "no longer exists; say so rather than generating against it. Input: { page?: string } to ask about one page.",
    inputSchema: {
      type: "object",
      properties: { page: { type: "string" } },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        status: { type: "string" },
        reason: { type: "string" },
        generatedAt: { type: "string" },
        totals: { type: "object" },
        pages: { type: "array" },
        limitations: { type: "array" },
      },
      additionalProperties: true,
    },
    invoke: async (port, input) => {
      if (!port.wikiFreshness) {
        // Said plainly rather than answered with an empty report. A caller
        // that cannot tell "no data" from "nothing is stale" will assume the
        // second, which is the failure this tool exists to prevent.
        return {
          output:
            "wiki freshness is unavailable from this port; run `keryx wiki freshness` directly. This is NOT evidence that the wiki is fresh.",
          isError: false,
        };
      }
      const page = typeof input?.page === "string" ? input.page : undefined;
      return formatFreshness(await port.wikiFreshness(page === undefined ? {} : { page }));
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
  {
    name: "graph_symbol",
    risk: "read",
    module: "gdgraph",
    description:
      "Look up where a symbol is defined plus its callers/callees over the code-graph symbol layer (`keryx gdgraph " +
      "symbol`). Input: { name: string }. This is the FIRST tool to try for 'where is X defined' — it returns the " +
      "exact file + line, no guessing a range in read_file needed. Empty definitions means the symbol layer has no " +
      "entry for that name here (tree-sitter grammar missing for this language, or the graph is stale) — fall back " +
      "to search_code with the same name as a text pattern rather than retrying this with a reworded name.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
    outputSchema: SYMBOL_OUTPUT_SCHEMA,
    invoke: async (port, input) => {
      if (port.graphSymbol === undefined) {
        return { output: "graph_symbol is not available in this session.", isError: true };
      }
      const name = requireString(input, "name", "graph_symbol");
      if ("error" in name) {
        return name.error;
      }
      return formatSymbol(await port.graphSymbol({ name: name.value }));
    },
  },
  {
    name: "repomap",
    risk: "read",
    module: "gdgraph",
    description:
      "Produce a ranked, token-budgeted repo map (top files + symbols by PageRank, `keryx gdgraph repomap`). " +
      "Input: { budget?: integer, seed?: string[] }. `seed` is what makes this useful for a change intent: " +
      "a seeded file and its direct consumers/tests become REQUIRED and are protected from rank eviction, " +
      "and each entry says whether it was `required`. If the required set does not fit, the result is a " +
      "`context_overflow` refusal naming the entry that did not fit — not a shorter map. Optional entries " +
      "dropped for budget are named in `omittedOptional` with `partial: true`.",
    inputSchema: {
      type: "object",
      properties: {
        budget: { type: "integer", minimum: 1 },
        seed: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    },
    outputSchema: REPOMAP_OUTPUT_SCHEMA,
    invoke: async (port, input) => {
      if (port.repomap === undefined) {
        return { output: "repomap is not available in this session.", isError: true };
      }
      const budget = typeof input.budget === "number" && input.budget > 0 ? input.budget : undefined;
      const seed = Array.isArray(input.seed)
        ? input.seed.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
        : undefined;
      return formatRepomap(
        await port.repomap({
          ...(budget !== undefined ? { budget } : {}),
          ...(seed !== undefined && seed.length > 0 ? { seed } : {}),
        }),
      );
    },
  },
  {
    name: "wiki_ask",
    risk: "read",
    module: "wiki",
    description:
      "Ask a question answered deterministically from the project's own wiki + memory with citations " +
      "(`keryx wiki ask`). Input: { question: string, k?: integer } — `k` caps the citations, exactly as " +
      "`--k` does. Read `status` before the prose: `no-match` and `insufficient-evidence` mean the answer " +
      "is NOT evidence for the question. A citation marked `historical` is superseded/expired guidance and " +
      "is not a current constraint.",
    inputSchema: {
      type: "object",
      properties: { question: { type: "string" }, k: { type: "integer", minimum: 1 } },
      required: ["question"],
      additionalProperties: false,
    },
    outputSchema: WIKI_ASK_OUTPUT_SCHEMA,
    invoke: async (port, input) => {
      if (port.wikiAsk === undefined) {
        return { output: "wiki_ask is not available in this session.", isError: true };
      }
      const question = requireString(input, "question", "wiki_ask");
      if ("error" in question) {
        return question.error;
      }
      const k = typeof input.k === "number" && input.k > 0 ? input.k : undefined;
      return formatWikiAsk(
        await port.wikiAsk({ question: question.value, ...(k !== undefined ? { k } : {}) }),
      );
    },
  },
  {
    name: "wiki_backlinks",
    risk: "read",
    module: "wiki",
    description:
      "List the wiki pages that reference a repo file — the reverse \"documented in\" lookup (`keryx wiki backlinks`). Input: { file: string } relative to the project root.",
    inputSchema: {
      type: "object",
      properties: { file: { type: "string" } },
      required: ["file"],
      additionalProperties: false,
    },
    outputSchema: WIKI_BACKLINKS_OUTPUT_SCHEMA,
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
  {
    name: "flow_status",
    risk: "read",
    module: "flow",
    description:
      "List Task Manager flows with their status and task progress (`keryx flow list`). Input: { id?: string } " +
      "to filter to one flow. Use this instead of `shell_exec`'ing `keryx flow list`/`keryx flow status` — same " +
      "data, no non-read budget cost.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      additionalProperties: false,
    },
    outputSchema: FLOW_STATUS_OUTPUT_SCHEMA,
    invoke: async (port, input) => {
      if (port.flowStatus === undefined) {
        return { output: "flow_status is not available in this session.", isError: true };
      }
      const id = typeof input.id === "string" && input.id.trim().length > 0 ? input.id.trim() : undefined;
      return formatFlowStatus(await port.flowStatus(id !== undefined ? { id } : {}));
    },
  },
  {
    name: "skills_catalog",
    risk: "read",
    module: "gdskills",
    description:
      "List every skill discovered under .metaproject/skills/gdskills/ — name, category, description, and " +
      "triggers for each. Use this instead of reading .metaproject/index.md or catalog.md to find which skill " +
      "applies to a task. No input.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    outputSchema: SKILLS_CATALOG_OUTPUT_SCHEMA,
    invoke: async (port) => {
      if (port.skillsCatalog === undefined) {
        return { output: "skills_catalog is not available in this session.", isError: true };
      }
      return formatSkillsCatalog(await port.skillsCatalog({}));
    },
  },
  {
    name: "skill_load",
    risk: "read",
    module: "gdskills",
    description:
      "Load one skill's full SKILL.md content by name (e.g. \"flow-orchestrator\") or exact project-relative " +
      "path, as returned by `skills_catalog`. Input: { name: string }.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
    outputSchema: SKILL_LOAD_OUTPUT_SCHEMA,
    invoke: async (port, input) => {
      if (port.loadSkill === undefined) {
        return { output: "skill_load is not available in this session.", isError: true };
      }
      const name = requireString(input, "name", "skill_load");
      if ("error" in name) {
        return name.error;
      }
      return formatSkillLoad(await port.loadSkill({ name: name.value }));
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


/**
 * Render a freshness result for a model.
 *
 * `limitations` are printed FIRST and unconditionally. An agent that skims
 * will read the top of the block, and the one thing it must not miss is that
 * a short finding list may mean the check could not run rather than that
 * nothing is stale.
 */
function formatFreshness(result: WikiFreshnessResult): InteractiveToolResult {
  const lines: string[] = [];

  if (result.status !== "measured") {
    lines.push(`STATUS: ${result.status.toUpperCase()} — ${result.reason ?? "no reason recorded"}`);
    lines.push("");
  }
  if (result.limitations.length > 0) {
    lines.push("THIS REPORT IS INCOMPLETE — an empty finding list below does not mean the wiki is fresh:");
    for (const limitation of result.limitations) {
      lines.push(`  - ${limitation.code}: ${limitation.detail}`);
    }
    lines.push("");
  }
  if (result.totals) {
    const t = result.totals;
    lines.push(
      `pages: ${t.pagesTotal ?? "?"} total, ${t.pagesFresh ?? "?"} fresh, ` +
        `${t.pagesUndecidable ?? 0} undecidable (excluded from scoring)`,
    );
    lines.push("");
  }
  if (result.pages.length === 0) {
    lines.push("No page is reported as needing attention in the last report's range.");
  } else {
    lines.push("Pages in doubt (do not treat these as current without checking):");
    for (const page of result.pages.slice(0, 40)) {
      lines.push(
        `  - ${page.path}: ${page.category}, ${page.confidence}, ${page.commitsBehind} commit(s) behind`,
      );
    }
  }
  if (result.generatedAt) {
    lines.push("", `report generated: ${result.generatedAt}`);
  }
  return { output: lines.join("\n"), isError: false };
}
