// Tool registry: MCP Tool name -> exactly ONE createXService() method
// (specification.md §6; M-2, M-3, M-10, NG-A4).
//
// Each entry is a THIN adapter: it (de)serializes JSON-RPC params into the typed
// service input, calls a single facade method, and returns the typed result. No
// business logic lives here. `src/mcp/` imports ONLY service facades + shared
// libs + the redact seam — never a module's internals (import-boundary test
// enforces this). Read-only unless `mutating` says otherwise; no mutating tool
// bypasses a deterministic gate.

import { getAffected, getCycles, getOrphans, loadGraph } from "../gdgraph/query";
import type { GraphData } from "../gdgraph/types";
import { createSecurityService, runScan } from "../security/service";
import { scanMcpManifest } from "../security/detect/mcp";
import { createMemoryService } from "../memory/service";
import { createCodeHealthService } from "../health/service";
import { createGdWikiService } from "../wiki/service";
import { createFlowService } from "../flow/service";
import { runValidate } from "../standard/service";
import { readFile } from "node:fs/promises";
import type { SecuritySource } from "../security/types";
import { toMcpTools } from "./metaproject-tools";

// A minimal JSON-Schema fragment advertised in `tools/list`.
export type JsonSchema = Record<string, unknown>;

export interface ToolEntry {
  name: string; // e.g. "gdgraph.affected"
  module: string; // "gdgraph" — filtered by the manifest (M-11)
  description: string;
  inputSchema: JsonSchema;
  // When true, the tool calls a gate-preserving service method (M-10). Block A
  // exposes only read-only or report-writing tools; no mutating flow transition.
  mutating: boolean;
  invoke(cwd: string, params: Record<string, unknown>): Promise<unknown>;
}

function stringParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" ? value : undefined;
}

// Load the code graph, degrading to an empty graph when storage is absent (the
// graph tools then return empty results rather than throwing).
async function loadGraphSafe(cwd: string): Promise<GraphData> {
  try {
    return await loadGraph(cwd);
  } catch {
    return { nodes: [], edges: [] };
  }
}

const OBJECT_SCHEMA = (
  properties: Record<string, JsonSchema> = {},
  required: string[] = [],
): JsonSchema => ({
  type: "object",
  properties,
  ...(required.length > 0 ? { required } : {}),
  additionalProperties: false,
});

// A read-only FlowService: no tracker, no health gate. `list`/`get` never touch
// those deps, so a stub keeps `flow.status` deterministic and side-effect free.
function readOnlyFlowService(): ReturnType<typeof createFlowService> {
  return createFlowService({
    tracker: null,
    healthGate: async () => ({ status: "skipped", reasons: [] }),
    now: () => new Date(),
  });
}

export function buildToolRegistry(): ToolEntry[] {
  // Unified metaproject read tools, projected from the single METAPROJECT_OPERATIONS
  // source (flow 038) via `toMcpTools` (flow 040). These are additive and read-only
  // (M-10): the historical hardcoded adapters below expose the same underlying
  // reads under their own legacy names/shapes and are preserved for test + shape
  // stability (see the flow 040 journal). No name collides with a legacy adapter.
  return [
    ...toMcpTools(),
    {
      name: "gdgraph.affected",
      module: "gdgraph",
      description:
        "List the dependencies and dependents of a file from the code graph (blast radius).",
      inputSchema: OBJECT_SCHEMA(
        {
          file: { type: "string", description: "Project-relative file path." },
          depth: { type: "number", description: "Reserved; traversal depth." },
        },
        ["file"],
      ),
      mutating: false,
      async invoke(cwd, params) {
        const file = stringParam(params, "file") ?? "";
        const graph = await loadGraphSafe(cwd);
        return getAffected(graph, file);
      },
    },
    {
      name: "gdgraph.cycles",
      module: "gdgraph",
      description: "Return every import cycle in the code graph.",
      inputSchema: OBJECT_SCHEMA(),
      mutating: false,
      async invoke(cwd) {
        return getCycles(await loadGraphSafe(cwd));
      },
    },
    {
      name: "gdgraph.orphans",
      module: "gdgraph",
      description: "Return files with no inbound or outbound import edges.",
      inputSchema: OBJECT_SCHEMA(),
      mutating: false,
      async invoke(cwd) {
        return getOrphans(await loadGraphSafe(cwd));
      },
    },
    {
      name: "security.check",
      module: "security",
      description:
        "Run the security engine over supplied content and return a leak-safe decision.",
      inputSchema: OBJECT_SCHEMA(
        {
          content: { type: "string" },
          source: { type: "string", description: "Trust level of the content." },
        },
        ["content"],
      ),
      mutating: false,
      async invoke(cwd, params) {
        const content = stringParam(params, "content") ?? "";
        const source = (stringParam(params, "source") ?? "untrusted-external") as SecuritySource;
        return createSecurityService(cwd).check({ content, source });
      },
    },
    {
      name: "security.scan",
      module: "security",
      description:
        "Scan a file for secrets/PII/injection and write a committable security report.",
      inputSchema: OBJECT_SCHEMA({
        path: { type: "string", description: "File to scan." },
        content: { type: "string", description: "Inline content to scan instead of a path." },
      }),
      mutating: true, // writes a committable report; not a flow-gate bypass
      async invoke(cwd, params) {
        const filePath = stringParam(params, "path");
        const inline = stringParam(params, "content");
        const content = inline ?? (filePath ? await readFile(filePath, "utf8") : "");
        const result = await runScan(cwd, {
          content,
          source: "trusted-project",
          ...(filePath ? { path: filePath } : {}),
        });
        return { decision: result.decision, report: result.report };
      },
    },
    {
      name: "security.scan-mcp",
      module: "security",
      description:
        "Scan an MCP tool manifest for tool-poisoning, line-jumping, and rug-pull threats (E3).",
      inputSchema: OBJECT_SCHEMA({
        manifest: { type: "object", description: "Parsed MCP manifest object." },
      }),
      mutating: false,
      async invoke(_cwd, params) {
        return scanMcpManifest(params.manifest);
      },
    },
    {
      name: "flow.status",
      module: "flow",
      description:
        "Read-only flow status: list all flows, or fetch one flow by id. Never mutates a flow.",
      inputSchema: OBJECT_SCHEMA({
        id: { type: "string", description: "Flow id to fetch; omit to list all." },
      }),
      mutating: false,
      async invoke(cwd, params) {
        const id = stringParam(params, "id");
        const service = readOnlyFlowService();
        return id ? service.get({ cwd, id }) : service.list({ cwd });
      },
    },
    {
      name: "memory.search",
      module: "memory",
      description: "Deterministic search over long-term project memory.",
      inputSchema: OBJECT_SCHEMA(
        {
          query: { type: "string" },
        },
        ["query"],
      ),
      mutating: false,
      async invoke(cwd, params) {
        const query = stringParam(params, "query") ?? "";
        return createMemoryService().search({ cwd, query });
      },
    },
    {
      name: "health.gate",
      module: "health",
      description: "Read the latest Code Health artifact and return the quality-gate outcome.",
      inputSchema: OBJECT_SCHEMA({
        strictWarn: { type: "boolean" },
      }),
      mutating: false,
      async invoke(cwd, params) {
        const strictWarn = params.strictWarn === true;
        return createCodeHealthService().gate({ cwd, strictWarn });
      },
    },
    {
      name: "health.status",
      module: "health",
      description: "Read the latest Code Health status summary.",
      inputSchema: OBJECT_SCHEMA(),
      mutating: false,
      async invoke(cwd) {
        return createCodeHealthService().status({ cwd });
      },
    },
    {
      name: "wiki.query",
      module: "wiki",
      description:
        "Query the local wiki. mode=status (default, read-only) | validate | check-links.",
      inputSchema: OBJECT_SCHEMA({
        mode: { type: "string", enum: ["status", "validate", "check-links"] },
      }),
      mutating: false,
      async invoke(cwd, params) {
        const service = createGdWikiService();
        const mode = stringParam(params, "mode") ?? "status";
        if (mode === "validate") {
          return service.validate({ cwd });
        }
        if (mode === "check-links") {
          return service.checkLinks({ cwd });
        }
        return service.status({ cwd });
      },
    },
    {
      name: "wiki.ask",
      module: "wiki",
      description:
        "Ask a question answered deterministically from the project's own wiki + memory, with citations.",
      inputSchema: OBJECT_SCHEMA(
        {
          question: { type: "string", description: "The natural-language question." },
          k: { type: "number", description: "Max citations to return." },
        },
        ["question"],
      ),
      mutating: false,
      async invoke(cwd, params) {
        const question = stringParam(params, "question") ?? "";
        const k = typeof params.k === "number" ? params.k : undefined;
        return createGdWikiService().ask({ cwd, question, ...(k ? { k } : {}) });
      },
    },
    {
      name: "standard.validate",
      module: "standard",
      description: "Validate the workspace against the Metaproject Standard.",
      inputSchema: OBJECT_SCHEMA(),
      mutating: false,
      async invoke(cwd) {
        return runValidate(cwd);
      },
    },
  ];
}
