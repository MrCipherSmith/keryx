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
import {
  RANKING_SCORE_LABEL,
  formatRankingScore,
  normalizeRetrievalCode,
  retrievalStatus,
} from "../../lib/retrieval-codes";
import type { EvidenceItem, EvidencePackage } from "../../wiki/evidence";
import type {
  FlowStatusResult,
  GraphAffectedResult,
  GraphFindResult,
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
  WikiEvidenceResult,
  WikiPageResult,
  WikiFreshnessResult,
  WikiResolveResult,} from "./metaproject-port";
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

/**
 * Render a structured `graphAffected` result as readable text for the model.
 *
 * `truncated` is a DISPLAY fact — "an output bound cut this list" — and it was
 * declared on `GraphAffectedResult` and in `AFFECTED_OUTPUT_SCHEMA` while this
 * renderer dropped it on the floor. A capped list therefore rendered
 * byte-identically to a complete one, and a capped list that happened to come
 * back empty rendered as the flat corpus claim "No dependents found for X".
 * The reference adapter does not set the flag today, so this is the shape
 * caught before it fired rather than after — but the field exists, a
 * `MetaprojectPort` is an interface, and a renderer that silently discards a
 * truncation marker is the same defect either way.
 */
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
  const truncated = result.truncated === true;
  if (result.affected.length === 0) {
    return withStaleness(
      {
        output: [
          ...dependencyLines,
          truncated
            ? `No dependents are SHOWN for ${result.target} — this result was capped by an output bound ` +
              "(`truncated`). That is a display decision about this page, not a claim that the target has " +
              "no dependents."
            : `No dependents found for ${result.target}.`,
        ].join("\n"),
        isError: false,
      },
      result.staleness,
    );
  }
  const header = truncated
    ? `Blast radius of ${result.target} (depth ${result.depth ?? 1}, showing ${result.affected.length} dependent(s) ` +
      "— TRUNCATED by an output bound, so this is a page and not the whole set):"
    : `Blast radius of ${result.target} (depth ${result.depth ?? 1}, ${result.affected.length} dependent(s)):`;
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
    // Flow 242 T9/F3: this line was the whole answer both for a memory entry
    // that had been deleted and for a phrase that never named anything — the
    // same collapse `formatWiki`/`formatWikiResolve` already fixed for the wiki,
    // fixed here with the same device: the verdict as a bracketed tag, so
    // "removed, on record" and "nothing here records a removal" are visibly
    // different answers rather than one string with different prose under it.
    //
    // `removalTrail` is absent when the port implementation predates the field;
    // the line then reads exactly as it always did.
    const trail = result.removalTrail;
    if (trail === undefined) {
      return { output: `No memory entries matched "${result.query}".`, isError: false };
    }
    const lines = [`No memory entries matched "${result.query}".`, `[${trail.verdict}] ${trail.summary}`];
    for (const removal of trail.removals ?? []) {
      const title = removal.title !== undefined ? ` "${removal.title}"` : "";
      const page = removal.page !== undefined ? ` in ${removal.page}` : "";
      lines.push(
        `  - [${removal.layer}] ${removal.ref}${title}${page} — removed ${removal.removedAt}, observed by ` +
          `\`${removal.observedBy}\` (matched on ${removal.matchedOn})`,
        `      requested by: ${removal.requestedBy}`,
        `      grounds: ${removal.grounds}`,
      );
    }
    if (trail.totalRemovals !== undefined && trail.totalRemovals > (trail.removals ?? []).length) {
      lines.push(
        `  … ${trail.totalRemovals - (trail.removals ?? []).length} further recorded removal(s) not shown ` +
          "(bounded output) — `keryx forgetting lookup --search` lists them all.",
      );
    }
    // Not an error: the search completed, and "this was removed" is an answer.
    return { output: lines.join("\n"), isError: false };
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

/**
 * Render a structured `readWiki` result as readable text for the model.
 *
 * Flow 242 (forgetting) lane C / AC5: `outcome` is printed as a bracketed tag
 * so "never existed" (`absent`), "existed and was removed" (`tombstoned` /
 * `pending-tombstone`) and "cannot tell" (`store-unreadable`) read as three
 * visibly different answers here, not one generic failure string with the
 * reason varying underneath.
 */
export function formatWiki(result: WikiPageResult): InteractiveToolResult {
  if (result.isError) {
    const tag = result.outcome !== undefined ? `[${result.outcome}] ` : "";
    return { output: `${tag}${result.error ?? `read_wiki failed for ${result.path}`}`, isError: true };
  }
  return { output: result.content.length > 0 ? result.content : "(empty page)", isError: false };
}

/**
 * Render a structured `wikiResolve` result as readable text for the model.
 *
 * Flow 242 (forgetting) lane C / AC2 + AC5: NEVER a same-name substitute — a
 * `reoccupied` identity is printed with its evidence and BOTH the tombstone
 * and whatever now occupies the address, never folded into an ordinary
 * "found".
 */
function formatWikiResolve(result: WikiResolveResult): InteractiveToolResult {
  const { resolution } = result;
  const prefix = `wiki_resolve ${result.ref}: `;
  switch (resolution.kind) {
    case "found":
      return {
        output:
          `${prefix}[found] ${resolution.section.pageRelativePath} "${resolution.section.title}" ` +
          `(lines ${resolution.section.bodyRange.startLine}-${resolution.section.bodyRange.endLine})` +
          (resolution.history
            ? `\n  history: removed ${resolution.history.removedAt} — ${resolution.history.reason}` +
              (resolution.history.restoredAt === null
                ? " (restored with byte-identical content; the tombstone is still on disk)."
                : ` (restored ${resolution.history.restoredAt}; the tombstone is retained).`)
            : ""),
        isError: false,
      };
    case "page-found":
      return {
        output:
          `${prefix}[page-found] ${resolution.page}` +
          (resolution.history ? `\n  history: removed ${resolution.history.removedAt} — ${resolution.history.reason}` : ""),
        isError: false,
      };
    case "tombstoned":
      return {
        output:
          `${prefix}[tombstoned] removed ${resolution.tombstone.removedAt} — ${resolution.tombstone.reason}. ` +
          "There is no redirect: a section with the same heading elsewhere is NOT this one.",
        isError: true,
      };
    case "reoccupied":
      return {
        output: `${prefix}[reoccupied, ${resolution.evidence}] ${resolution.reason}`,
        isError: true,
      };
    case "pending-tombstone":
      return { output: `${prefix}[pending-tombstone] ${resolution.reason}`, isError: true };
    case "stale-locator":
      return { output: `${prefix}[stale-locator] ${resolution.reason}`, isError: true };
    case "registry-unreadable":
      return { output: `${prefix}[registry-unreadable] ${resolution.reason}`, isError: true };
    case "store-unreadable":
      return { output: `${prefix}[store-unreadable] ${resolution.reason}`, isError: true };
    default:
      return { output: `${prefix}[unknown] ${resolution.reason}`, isError: true };
  }
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
    // Flow 242 T9/F3: additive and optional, exactly like the provenance fields
    // above — a result produced before this field still validates. `verdict` is
    // enumerated because it is the field a consumer branches on, and the enum is
    // the enforceable statement that `never-existed` is not among the answers
    // this tool can give.
    removalTrail: {
      type: "object",
      properties: {
        verdict: {
          type: "string",
          enum: ["recorded-removed", "no-removal-recorded", "trail-absent", "trail-unreadable"],
        },
        summary: { type: "string" },
        totalRemovals: { type: "integer" },
        removals: {
          type: "array",
          items: {
            type: "object",
            properties: {
              layer: { type: "string" },
              ref: { type: "string" },
              title: { type: "string" },
              page: { type: "string" },
              removedAt: { type: "string" },
              observedBy: { type: "string" },
              requestedBy: { type: "string" },
              grounds: { type: "string" },
              matchedOn: { type: "string" },
            },
            required: ["layer", "ref", "removedAt", "requestedBy", "grounds"],
          },
        },
      },
      required: ["verdict", "summary"],
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
    outcome: { type: "string" },
  },
  required: ["path", "content", "isError"],
};

/** Flow 242 (forgetting) lane C: `wiki_resolve`'s output — `WikiResolveResult` verbatim. */
const WIKI_RESOLVE_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    ref: { type: "string" },
    resolution: { type: "object" },
  },
  required: ["ref", "resolution"],
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

/**
 * Render a `graphSymbol` result as readable text.
 *
 * `definitions` is a PAGE, not the match set: `querySymbol` resolves through
 * `resolveSymbolCandidates` (`src/gdgraph/symbol.ts`), whose `limit` defaults to
 * 25 and which `querySymbol` never overrides. Measured on a synthetic graph of
 * sixty symbols whose names all contain `handle`, `graph_symbol` returns
 * twenty-five of them — and this header used to read "Symbol handle (25
 * definition(s)):", a page size stated as a count of what the graph holds.
 *
 * The count is therefore labelled as what it is. It cannot be stated against
 * the corpus here, because `GraphSymbolResult` carries no total and this
 * renderer must never invent one; that missing field is a named residual of
 * this task, not something the wording is pretending to cover.
 */
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
  const lines = [`Symbol ${result.name} (${result.definitions.length} definition(s) shown):`, ...defs];
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
  const omittedOptional = result.omittedOptional ?? [];
  if (result.files.length === 0) {
    // A budget that fits nothing is a DISPLAY decision. "no ranked files" is a
    // claim about the graph, and it was being made from an empty page:
    // measured on a five-file graph at `budget: 15`, `computeRepomap` returned
    // `entries: []`, `omitted: 5`, `partial: true` and named all five paths in
    // `omittedOptional` — and this branch printed "Repomap is empty (no ranked
    // files)." and returned before the loss lines below could name any of them.
    // The genuinely-empty sentence is kept for the case that is genuinely
    // empty; it is not deleted wholesale.
    if (result.omitted > 0 || omittedOptional.length > 0) {
      return withStaleness(
        {
          output: [
            `Repomap shows 0 entries: ${result.omitted} ranked entr${result.omitted === 1 ? "y" : "ies"} ` +
              `did not fit the ${result.budget}-token budget. That is a budget decision about this map, ` +
              "not a claim that the graph holds no ranked files.",
            ...(omittedOptional.length > 0
              ? [
                  "",
                  `Omitted for budget (${omittedOptional.length}):`,
                  ...omittedOptional.slice(0, 40).map((path) => `  - ${path}`),
                  ...(omittedOptional.length > 40
                    ? [`  - … +${omittedOptional.length - 40} more`]
                    : []),
                ]
              : []),
            "Raise `budget`, or narrow `seed`, and retry.",
          ].join("\n"),
          isError: false,
        },
        result.staleness,
      );
    }
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

/**
 * The line that separates what MATCHED from what is SHOWN, in `formatFind`'s
 * output.
 *
 * THE FIFTH INSTANCE (flow 235, T18)
 *
 * `src/gdgraph/find.ts` and `src/mcp/tools.ts` were fixed so a page size can
 * never be printed as a fact about the corpus — inside the PAYLOAD. This
 * renderer prints prose BESIDE that payload and had never been audited. It
 * branched on the page:
 *
 *   result.files.length === 0 && result.symbols.length === 0
 *     -> "No candidates. …"
 *
 * which is a claim about the corpus made from a display decision. Reproduced
 * on 2026-09-08 through this function, on a 100-file corpus with 40 genuine
 * matches at `fileLimit: 0`:
 *
 *   code: ok
 *   reason: 40 files and 0 symbols matched. Showing 0 of 40 files — …
 *   No candidates. The code above says whether that is an answer or a failure.
 *
 * — the payload and the prose one line apart, contradicting each other. The
 * same line fired for the `insufficient-evidence` corpus where fourteen files
 * matched and all scored zero.
 *
 * The rule, identical to the payload's: what MATCHED is stated only above this
 * boundary, from `code`/`reason`; what is SHOWN is stated only below it, and
 * every count below it is labelled `shown`.
 */
export const FIND_PAGE_BOUNDARY =
  "Below this line is the PAGE — candidates ranked and cut to the display limit. " +
  "Only `code` and `reason` above say what matched:";

/**
 * Render a `graphFind` result — `keryx gdgraph find`, for an agent.
 *
 * The CODE comes first and on its own line, exactly as `formatRetrievalOutcome`
 * (`../../lib/retrieval-codes.ts`) renders it for the command line, so the two
 * surfaces cannot drift into different spellings of the same answer.
 *
 * `normalizeRetrievalCode` is applied HERE as well as in the adapter, and that
 * is not belt-and-braces: this is the second transport hop (port result → the
 * text a model reads), and `MetaprojectPort` is an interface — a stub, a
 * recorded replay result, or a future non-reference implementation can put any
 * string in `code`. A code outside the shared vocabulary collapses to
 * `capability-unavailable` rather than being printed as if a caller could
 * branch on it.
 */
export function formatFind(result: GraphFindResult): InteractiveToolResult {
  const code = normalizeRetrievalCode(result.code);
  const lines = [`code: ${code}`, `reason: ${result.reason}`];
  if (result.error !== undefined) {
    lines.push(`error: ${result.error}`);
  }
  if (result.queryTerms.length > 0) {
    lines.push(`terms: ${result.queryTerms.join(", ")}`);
  }
  if (result.ubiquitousTerms.length > 0) {
    // Named explicitly: these are the terms that made the ranking weak, and a
    // reader who cannot see them will re-run the same useless query.
    lines.push(
      `corpus-wide terms (these narrow nothing): ${result.ubiquitousTerms.join(", ")}`,
    );
  }
  if (result.nextActions.length > 0) {
    lines.push("next:", ...result.nextActions.map((action) => `  - ${action}`));
  }
  // Everything from here down is the PAGE. Nothing above the boundary may be
  // derived from `files`/`symbols`, and nothing below it may be read as a
  // statement about the corpus — `find-display-truth.test.ts` pins the same
  // split inside the payload, and `metaproject-display-truth.test.ts` pins it
  // here by asserting the text ABOVE this line is byte-identical across page
  // sizes for every retrieval code.
  lines.push("", FIND_PAGE_BOUNDARY);
  if (result.files.length > 0) {
    lines.push(`Files shown (${result.files.length}):`);
    for (const file of result.files) {
      lines.push(
        `  - ${file.path} (${RANKING_SCORE_LABEL} ${formatRankingScore(file.score)})`,
        `      ${file.reason}`,
      );
    }
  }
  if (result.symbols.length > 0) {
    if (result.files.length > 0) {
      lines.push("");
    }
    lines.push(`Symbols shown (${result.symbols.length}):`);
    for (const symbol of result.symbols) {
      lines.push(
        `  - ${symbol.name} (${symbol.kind}) at ${symbol.path}:${symbol.startLine} ` +
          `(${RANKING_SCORE_LABEL} ${formatRankingScore(symbol.score)})`,
        `      ${symbol.reason}`,
      );
    }
  }
  if (result.files.length === 0 && result.symbols.length === 0) {
    lines.push(
      "Nothing is shown on this page. An empty page is a ranking-and-limit decision; " +
        "`reason` above is the only statement here about what matched.",
    );
  }
  return withStaleness(
    { output: lines.join("\n"), isError: retrievalStatus(code) === "error" },
    result.staleness,
  );
}

// --- the evidence field registry: the anti-drop guard --------------------------
//
// The measured defect this exists to stop: a previous lane measured this
// boundary and found six unreported gaps, the largest dropping THIRTEEN fields
// from a wiki answer, because the projection was a hand-written list of the
// fields somebody remembered. So the projection here is not a hand-written
// list. It is a registry that the compiler checks against the envelope type,
// walked by a value-driven renderer.
//
// Two independent checks, both at compile time:
//
//   1. `satisfies readonly (keyof EvidenceItem)[]` — nothing in the registry
//      may be a field the envelope does not have (catches a rename/removal).
//   2. `EveryEvidenceItemFieldIsProjected` below — nothing in the envelope may
//      be missing from the registry (catches an ADDITION, which is the
//      direction that actually bit). A new field on `EvidenceItem` fails to
//      compile here until it is listed.
//
// And nested values are never hand-listed at all: `renderValue` walks
// `Object.entries` of whatever it is given, so a field added inside `scope`,
// `provenance`, `lifecycle`, `freshness`, a caveat or a conflict ref is
// rendered without any edit to this file.

export const EVIDENCE_ITEM_FIELDS = [
  "contractVersion",
  "scope",
  "pageRef",
  "pageVersion",
  "sectionId",
  "sectionVersion",
  "title",
  "contentClass",
  "excerpt",
  "lifecycle",
  "freshness",
  "provenance",
  "caveats",
  "bindings",
  "conflictRefs",
] as const satisfies readonly (keyof EvidenceItem)[];

export type EvidenceItemField = (typeof EVIDENCE_ITEM_FIELDS)[number];

/** Fails to compile when `T` is anything but `never`. */
type AssertNever<T extends never> = T;

/**
 * Exhaustiveness in the direction that matters: a field ADDED to `EvidenceItem`
 * and not added to `EVIDENCE_ITEM_FIELDS` makes `Exclude<…>` a real key, which
 * violates `T extends never` and fails the build. Exported so it is not pruned
 * as an unused local.
 */
export type EveryEvidenceItemFieldIsProjected = AssertNever<
  Exclude<keyof EvidenceItem, EvidenceItemField>
>;

/**
 * Every key ANY `EvidencePackage` variant can carry.
 *
 * `keyof EvidencePackage` on the union directly yields only the keys COMMON to
 * every variant, which silently loses `requiredRef` — it lives on the
 * `budget-exceeded` branch alone, and that branch is the one a caller must not
 * mistake for a short success. The naked type parameter is what makes the
 * conditional distribute over the union; without it this guard would have been
 * blind to exactly the field that matters most.
 */
type KeysOfUnion<T> = T extends unknown ? keyof T : never;
export type EvidencePackageField = KeysOfUnion<EvidencePackage>;

const EVIDENCE_PACKAGE_FIELDS = [
  "status",
  "reason",
  "suggestion",
  "partial",
  "omittedOptional",
  "refused",
  "overflow",
  "requiredRef",
  "items",
] as const satisfies readonly EvidencePackageField[];

/** Same guard, for the envelope's own top level. */
export type EveryEvidencePackageFieldIsProjected = AssertNever<
  Exclude<EvidencePackageField, (typeof EVIDENCE_PACKAGE_FIELDS)[number]>
>;

/**
 * Fields deliberately NOT projected, each with the reason.
 *
 * Empty on purpose: every field of the envelope reaches the model today. The
 * record exists so that a future omission has to be a NAMED DECISION with a
 * stated reason — the renderer prints the reason in place of the value, so an
 * omission is visible to the reader rather than being an absence nobody can
 * see. `wiki-evidence-projection.test.ts` asserts every field is either
 * rendered or named here.
 */
export const EVIDENCE_FIELDS_NOT_PROJECTED: Readonly<
  Partial<Record<EvidenceItemField | (typeof EVIDENCE_PACKAGE_FIELDS)[number], string>>
> = {};

/**
 * Render any value as readable, indented text WITHOUT a per-field hand list.
 *
 * Objects are walked with `Object.entries`, so a nested field cannot be
 * silently dropped: whatever the value carries at runtime is what is rendered.
 * `undefined` renders as `(absent)` and `null` as `null` — the envelope uses
 * `null` to mean "this was not claimed" (`confirmedBy`, `acceptanceBasisRef`,
 * `snapshotVersion`), and collapsing that into a blank line would erase the
 * distinction the envelope is built on.
 */
function renderValue(value: unknown, indent: string): string[] {
  if (value === undefined) {
    return [`${indent}(absent)`];
  }
  if (value === null) {
    return [`${indent}null`];
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return [`${indent}(none)`];
    }
    return value.flatMap((entry) => {
      const [first = "", ...rest] = renderValue(entry, `${indent}  `);
      return [`${indent}- ${first.trimStart()}`, ...rest];
    });
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      return [`${indent}(empty)`];
    }
    return entries.flatMap(([key, entryValue]) => {
      const rendered = renderValue(entryValue, `${indent}  `);
      const only = rendered.length === 1 ? rendered[0] : undefined;
      return only !== undefined
        ? [`${indent}${key}: ${only.trimStart()}`]
        : [`${indent}${key}:`, ...rendered];
    });
  }
  const text = String(value);
  return text.includes("\n")
    ? text.split("\n").map((line) => `${indent}${line}`)
    : [`${indent}${text}`];
}

function renderField(name: string, value: unknown, indent: string): string[] {
  const omissionReason = (
    EVIDENCE_FIELDS_NOT_PROJECTED as Readonly<Record<string, string | undefined>>
  )[name];
  if (omissionReason !== undefined) {
    // A named omission is PRINTED, not skipped. An absence a reader cannot see
    // is the defect; an absence with a reason attached is a decision.
    return [`${indent}${name}: (not projected — ${omissionReason})`];
  }
  const rendered = renderValue(value, `${indent}  `);
  const only = rendered.length === 1 ? rendered[0] : undefined;
  return only !== undefined
    ? [`${indent}${name}: ${only.trimStart()}`]
    : [`${indent}${name}:`, ...rendered];
}

/** Render one evidence item, every registry field, in registry order. */
export function renderEvidenceItem(item: EvidenceItem, indent: string): string[] {
  return EVIDENCE_ITEM_FIELDS.flatMap((field) => renderField(field, item[field], indent));
}

/**
 * Render a `wikiEvidence` result.
 *
 * `budget-exceeded` is an ERROR result, not a shorter success: the whole point
 * of the envelope's overflow branch is that a required item is delivered whole
 * or not at all, and rendering it as an ordinary empty answer would reintroduce
 * the "shortened rule" the contract forbids. `no-match` and
 * `insufficient-evidence` are NOT errors — they are completed operations whose
 * result is empty, which `retrievalStatus` already encodes.
 */
export function formatWikiEvidence(result: WikiEvidenceResult): InteractiveToolResult {
  if (result.envelope === undefined) {
    return {
      output: `wiki_evidence failed: ${result.error ?? "no envelope was produced"}`,
      isError: true,
    };
  }
  const envelope = result.envelope;
  const code = normalizeRetrievalCode(envelope.status);
  const lines = [`Evidence for ${JSON.stringify(result.question)}`, `code: ${code}`];
  const record = envelope as unknown as Record<string, unknown>;

  for (const field of EVIDENCE_PACKAGE_FIELDS) {
    if (field === "status") {
      continue; // already printed above, as the code line
    }
    if (field === "items") {
      const items = envelope.items;
      lines.push(`items (${items.length}):`);
      items.forEach((item, index) => {
        lines.push(`  [${index + 1}] ${item.title}`);
        lines.push(...renderEvidenceItem(item, "    "));
      });
      if (items.length === 0) {
        lines.push("  (none)");
      }
      continue;
    }
    if (!(field in record)) {
      // `requiredRef` exists only on the overflow variant. Absent by shape, not
      // dropped by this renderer — and the test that walks a real overflow
      // envelope proves it is rendered when it IS present.
      continue;
    }
    lines.push(...renderField(field, record[field], ""));
  }

  return { output: lines.join("\n"), isError: retrievalStatus(code) === "error" };
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

const GRAPH_FIND_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    query: { type: "string" },
    // The closed AC5 vocabulary, not an open string: a caller branches on this.
    code: { type: "string" },
    reason: { type: "string" },
    nextActions: { type: "array", items: { type: "string" }, maxItems: 3 },
    files: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          score: { type: "number" },
          matched: { type: "array", items: { type: "string" } },
          discriminating: { type: "array", items: { type: "string" } },
          dependents: { type: "integer" },
          reason: { type: "string" },
        },
        required: ["path", "score", "matched", "discriminating", "reason"],
      },
    },
    symbols: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          kind: { type: "string" },
          path: { type: "string" },
          startLine: { type: "integer" },
          score: { type: "number" },
          matched: { type: "array", items: { type: "string" } },
          discriminating: { type: "array", items: { type: "string" } },
          reason: { type: "string" },
        },
        required: ["id", "name", "path", "score"],
      },
    },
    queryTerms: { type: "array", items: { type: "string" } },
    ubiquitousTerms: { type: "array", items: { type: "string" } },
    staleness: STALENESS_OUTPUT_SCHEMA,
    error: { type: "string" },
  },
  required: ["query", "code", "reason", "nextActions", "files", "symbols"],
};

// Deliberately NOT an exhaustive re-listing of the evidence envelope.
//
// `wiki-evidence.schema.json` is the contract for the envelope's shape, and a
// second hand-maintained copy of it here is precisely the drift that dropped
// thirteen fields at this boundary before. `additionalProperties: true` says
// "the envelope is carried whole"; the anti-drop guarantee is enforced by
// `EVIDENCE_ITEM_FIELDS` at compile time and by `wiki-evidence-projection.test.ts`
// at runtime, not by re-typing field names into a JSON Schema literal.
const WIKI_EVIDENCE_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    question: { type: "string" },
    envelope: {
      type: "object",
      properties: { status: { type: "string" } },
      required: ["status"],
      additionalProperties: true,
    },
    error: { type: "string" },
  },
  required: ["question"],
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
      "the same narrowing the CLI offers. Automatic recall is always bounded to accepted, current entries. " +
      "An empty result is NOT proof the knowledge never existed: it carries the deletion trail's verdict — " +
      "recorded-removed (with when, at whose request and on what basis) / no-removal-recorded / trail-absent / " +
      "trail-unreadable. Read that tag before concluding anything from zero hits.",
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
    name: "graph_find",
    risk: "read",
    module: "gdgraph",
    description:
      "Find the files and symbols a plain-language question is about, over the code graph " +
      "(`keryx gdgraph find`). Input: { query: string, fileLimit?: integer, symbolLimit?: integer }. " +
      "This is the tool to reach for when you do NOT yet know a path — graph_affected and " +
      "read_file both need one. READ `code` BEFORE the candidates: `ok` means the ranking is " +
      "evidence; `no-match` means the search ran over the index and nothing contains your terms; " +
      "`insufficient-evidence` means every candidate matched only on terms that appear across " +
      "this whole corpus, so the list below is NOT evidence for your question; " +
      "`index-incomplete` means the graph could not answer at all and says nothing about whether " +
      "the code exists. Each candidate carries `matched` (which terms hit) and `discriminating` " +
      "(which of those actually narrow the corpus) — a candidate with an empty `discriminating` " +
      "matched only noise. Fan-in is a tie-break, never evidence.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        fileLimit: { type: "integer", minimum: 1 },
        symbolLimit: { type: "integer", minimum: 1 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    outputSchema: GRAPH_FIND_OUTPUT_SCHEMA,
    invoke: async (port, input) => {
      if (port.graphFind === undefined) {
        return { output: "graph_find is not available in this session.", isError: true };
      }
      const query = requireString(input, "query", "graph_find");
      if ("error" in query) {
        return query.error;
      }
      const fileLimit =
        typeof input.fileLimit === "number" && input.fileLimit > 0 ? input.fileLimit : undefined;
      const symbolLimit =
        typeof input.symbolLimit === "number" && input.symbolLimit > 0
          ? input.symbolLimit
          : undefined;
      return formatFind(
        await port.graphFind({
          query: query.value,
          ...(fileLimit !== undefined ? { fileLimit } : {}),
          ...(symbolLimit !== undefined ? { symbolLimit } : {}),
        }),
      );
    },
  },
  {
    name: "wiki_evidence",
    risk: "read",
    module: "wiki",
    description:
      "Ask the wiki for an EVIDENCE ENVELOPE rather than prose (`createGdWikiService().evidence`). " +
      "Input: { question: string, k?: integer, budgetTokens?: integer, maxItems?: integer }. " +
      "Use this instead of wiki_ask when you are about to ACT on what the wiki says: each item " +
      "carries its section identity and version, the excerpt whole (never shortened), its " +
      "lifecycle, its freshness with the reason it is not `fresh`, its provenance, and — the " +
      "load-bearing parts — its mandatory `caveats` and its `conflictRefs`. A rule and its caveat " +
      "are one indivisible unit: if a declared caveat cannot be resolved the item is REFUSED " +
      "(listed under `refused`) rather than returned unqualified. Two disagreeing sections come " +
      "back as two items pointing at each other, so a contested claim can never read as settled. " +
      "READ `code` first: `budget-exceeded` means a REQUIRED item did not fit and NOTHING was " +
      "returned — raise `budgetTokens` or narrow the question; it is never a shorter answer.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string" },
        k: { type: "integer", minimum: 1 },
        budgetTokens: { type: "integer", minimum: 1 },
        maxItems: { type: "integer", minimum: 1 },
      },
      required: ["question"],
      additionalProperties: false,
    },
    outputSchema: WIKI_EVIDENCE_OUTPUT_SCHEMA,
    invoke: async (port, input) => {
      if (port.wikiEvidence === undefined) {
        return { output: "wiki_evidence is not available in this session.", isError: true };
      }
      const question = requireString(input, "question", "wiki_evidence");
      if ("error" in question) {
        return question.error;
      }
      const k = typeof input.k === "number" && input.k > 0 ? input.k : undefined;
      const budgetTokens =
        typeof input.budgetTokens === "number" && input.budgetTokens > 0
          ? input.budgetTokens
          : undefined;
      const maxItems =
        typeof input.maxItems === "number" && input.maxItems > 0 ? input.maxItems : undefined;
      return formatWikiEvidence(
        await port.wikiEvidence({
          question: question.value,
          ...(k !== undefined ? { k } : {}),
          ...(budgetTokens !== undefined ? { budgetTokens } : {}),
          ...(maxItems !== undefined ? { maxItems } : {}),
        }),
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
  // --- flow 242 (forgetting) lane C: additive OPTIONAL read operation --------
  // Same OPTIONAL contract as every batch above: an absent method reports
  // "not available", never a throw and never an invented clean result. Before
  // this, `keryx wiki sections resolve` — the CLI's ONLY correct answer to
  // "was this deleted or did it never exist" — had no agent or MCP
  // equivalent at all: AC5 of flow 242 requires the same three answers
  // (never existed / existed and was removed / cannot say) on the CLI, the
  // agent tool boundary, and MCP, and this was the missing surface.
  {
    name: "wiki_resolve",
    risk: "read",
    module: "wiki",
    description:
      "Resolve a wiki page/section identity (`keryx:page/<id>` or `keryx:page/<id>#<sectionId>`, " +
      "as printed by wiki_ask/wiki_evidence citations or `keryx wiki sections list`) to what it " +
      "actually is right now — NOT what merely occupies its address. Input: { ref: string }. " +
      "Answers, distinctly: found/page-found (live), tombstoned (removed, with when and why), " +
      "pending-tombstone (removed but `keryx wiki sections sync` has not run yet), reoccupied " +
      "(a DIFFERENT document now sits at this address — never returned as an ordinary found), " +
      "stale-locator (a version-bound locator whose page body has since changed), " +
      "registry-unreadable / store-unreadable (the removal history or the wiki store itself could " +
      "not be read — \"live\", \"removed\" and \"never existed\" cannot be told apart), or unknown " +
      "(nothing records this identity at all). Use this before treating read_wiki returning empty " +
      "as proof a page never existed — it may instead be gone and tombstoned.",
    inputSchema: {
      type: "object",
      properties: { ref: { type: "string" } },
      required: ["ref"],
      additionalProperties: false,
    },
    outputSchema: WIKI_RESOLVE_OUTPUT_SCHEMA,
    invoke: async (port, input) => {
      if (port.wikiResolve === undefined) {
        return { output: "wiki_resolve is not available in this session.", isError: true };
      }
      const ref = requireString(input, "ref", "wiki_resolve");
      if ("error" in ref) {
        return ref.error;
      }
      return formatWikiResolve(await port.wikiResolve({ ref: ref.value }));
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
