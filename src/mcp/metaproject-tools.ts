// Unified metaproject → MCP tool projection (flow 040 / MP-3).
//
// The metaproject operations are defined ONCE in
// `src/harness/tool/metaproject-operations.ts` (flow 038). Flow 038 projected
// that single source into the interactive agent (`toInteractiveTools`) and the
// harness ToolRegistry (`toToolDefinitions`). This module adds the THIRD
// projection — into the MCP `ToolEntry[]` shape that `src/mcp/tools.ts` consumes
// — closing the "one definition → three consumers" goal for MCP.
//
// Key differences from the agent projection:
//   - The agent's `op.invoke(port, input)` FORMATS the port result into readable
//     text (an InteractiveToolResult). MCP callers want the STRUCTURED result, so
//     `toMcpTools` bypasses `op.invoke` and calls the bound MetaprojectPort method
//     directly, returning the raw structured object as the MCP tool result.
//   - Every projected tool is read-only (`mutating: false`); no mutating/write
//     MCP tool is ever produced here (M-10).
//
// `src/mcp` may import the harness metaproject modules because they are pure: the
// port is a types-only interface, the operations file is pure descriptors +
// projections, and the reference adapter composes service facades that `src/mcp`
// is already allowed to import (import-boundary test extended accordingly).

import type { MetaprojectOperation } from "../harness/tool/metaproject-operations";
import type { MetaprojectPort } from "../harness/tool/metaproject-port";
import { createMetaprojectAdapter } from "../harness/tool/metaproject-adapter";
import { METAPROJECT_OPERATIONS } from "../harness/tool/metaproject-operations";
import { memoryHarnessVisibilityByPath } from "../memory/service";
import type { JsonSchema, McpInvocationContext, ToolEntry } from "./types";

function stringParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" ? value : undefined;
}

// Flow 313 (W4) review R1-F4: filters a `memorySearch`-shaped structured
// result's `hits` by the SAME `memoryHarnessVisibilityByPath` primitive
// `src/mcp/tools.ts`'s `memory.search` uses — this MCP projection
// (`memory_search`, via `METAPROJECT_OPERATIONS`) is a SECOND surface onto
// the identical underlying search, and had no filter of its own before this.
async function filterMemorySearchHitsByHarness(
  cwd: string,
  result: unknown,
  harnessIdentity: string | null,
): Promise<unknown> {
  if (result === null || typeof result !== "object" || !Array.isArray((result as { hits?: unknown }).hits)) {
    return result;
  }
  const hits = (result as { hits: Array<Record<string, unknown>> }).hits;
  if (hits.length === 0) {
    return result;
  }
  const visibility = await memoryHarnessVisibilityByPath(cwd, harnessIdentity);
  const filteredHits = hits.filter((hit) => {
    const path = typeof hit.path === "string" ? hit.path : null;
    // R2-I1 (evaluated, not applied): see the identical note on
    // `../mcp/tools.ts`'s copy of this filter — flipping this to fail-closed
    // breaks `memory-p0.test.ts`'s decoupled-fixture purity test with no
    // production security gain.
    return path === null || (visibility.get(path) ?? true);
  });
  return { ...(result as Record<string, unknown>), hits: filteredHits };
}

// Call the bound port method that backs a metaproject operation and return its
// STRUCTURED result (not the agent's formatted text). Dispatch is by the stable
// operation name from the single source of truth. An unknown operation surfaces a
// structured error rather than throwing across the transport.
async function invokeStructured(
  op: MetaprojectOperation,
  port: MetaprojectPort,
  params: Record<string, unknown>,
  cwd: string,
  harnessIdentity: string | null,
): Promise<unknown> {
  switch (op.name) {
    case "search_code": {
      const pattern = stringParam(params, "pattern") ?? "";
      const path = stringParam(params, "path");
      return port.searchCode({ pattern, ...(path !== undefined ? { path } : {}) });
    }
    case "graph_affected": {
      // The operation's input schema names the field `file`; accept `target` too.
      const target = stringParam(params, "file") ?? stringParam(params, "target") ?? "";
      return port.graphAffected({ target });
    }
    case "graph_query": {
      const query = params.query === "orphans" ? "orphans" : "cycles";
      return port.graphQuery({ query });
    }
    case "memory_search": {
      const query = stringParam(params, "query") ?? "";
      const result = await port.memorySearch({ query });
      // Flow 313 (W4) review R1-F4: the ONLY memory_search filter — this
      // projection never went through `src/mcp/tools.ts`'s `memory.search`
      // handler, so without this it leaked every `target_harnesses`
      // restricted entry regardless of the bound harness identity.
      return filterMemorySearchHitsByHarness(cwd, result, harnessIdentity);
    }
    case "read_wiki": {
      const path = stringParam(params, "path") ?? "";
      return port.readWiki({ path });
    }
    case "wiki_ask": {
      // Bespoke case (rather than the default `op.invoke` passthrough) so
      // the bound harness identity (R1-F4) can reach `port.wikiAsk` — the
      // shared operation descriptor's own `invoke` never threads MCP-only
      // server state through, by design (it is also called by the
      // interactive agent and the ToolRegistry projection, neither of which
      // has this concept). `port.wikiAsk` is optional on `MetaprojectPort`;
      // an adapter that omits it falls through to `op.invoke`, which itself
      // reports "wiki_ask is not available in this session."
      if (port.wikiAsk === undefined) {
        return op.invoke(port, params);
      }
      const question = stringParam(params, "question") ?? "";
      const k = typeof params.k === "number" ? params.k : undefined;
      return port.wikiAsk({ question, ...(k !== undefined ? { k } : {}), harnessIdentity });
    }
    default:
      // Any operation without a bespoke structured case (flows 043/044: graph_path,
      // test_related, health_status, graph_symbol, repomap) is invoked via
      // the descriptor's own content `invoke`, so every registered unified tool is
      // callable via MCP — never "unknown operation".
      return op.invoke(port, params);
  }
}

/**
 * Project the single-source metaproject operations into MCP `ToolEntry[]`. Each
 * entry carries the operation's name, description, and input schema verbatim, is
 * read-only (`mutating: false`), and whose `invoke(cwd, params)` builds a
 * `MetaprojectPort` for `cwd` (via `createMetaprojectAdapter`, or the injected
 * `adapterFor` for tests) and returns the port method's STRUCTURED result.
 *
 * Pure and deterministic: no side effects, and the port is constructed lazily per
 * invocation so listing tools never touches the filesystem.
 */
export function toMcpTools(
  ops: MetaprojectOperation[] = METAPROJECT_OPERATIONS,
  adapterFor: (cwd: string) => MetaprojectPort = (cwd) => createMetaprojectAdapter(cwd),
): ToolEntry[] {
  return ops.map((op) => ({
    name: op.name,
    module: op.module,
    description: op.description,
    inputSchema: op.inputSchema as JsonSchema,
    mutating: false, // M-10: metaproject reads are always read-only.
    async invoke(
      cwd: string,
      params: Record<string, unknown>,
      context?: McpInvocationContext,
    ): Promise<unknown> {
      const port = adapterFor(cwd);
      return invokeStructured(op, port, params ?? {}, cwd, context?.harnessIdentity ?? null);
    },
  }));
}
