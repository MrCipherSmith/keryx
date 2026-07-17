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
import type { JsonSchema, ToolEntry } from "./tools";

function stringParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" ? value : undefined;
}

// Call the bound port method that backs a metaproject operation and return its
// STRUCTURED result (not the agent's formatted text). Dispatch is by the stable
// operation name from the single source of truth. An unknown operation surfaces a
// structured error rather than throwing across the transport.
async function invokeStructured(
  op: MetaprojectOperation,
  port: MetaprojectPort,
  params: Record<string, unknown>,
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
      return port.memorySearch({ query });
    }
    case "read_wiki": {
      const path = stringParam(params, "path") ?? "";
      return port.readWiki({ path });
    }
    default:
      return { error: `unknown metaproject operation: ${op.name}` };
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
    async invoke(cwd: string, params: Record<string, unknown>): Promise<unknown> {
      const port = adapterFor(cwd);
      return invokeStructured(op, port, params ?? {});
    },
  }));
}
