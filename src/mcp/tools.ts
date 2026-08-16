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
import { createMetaprojectAdapter } from "../harness/tool/metaproject-adapter";
import { createCodeHealthService } from "../health/service";
import { createGdWikiService } from "../wiki/service";
import { createFlowService } from "../flow/service";
import { runValidate } from "../standard/service";
import { readFile, writeFile } from "node:fs/promises";
import type { SecuritySource } from "../security/types";
import { toMcpTools } from "./metaproject-tools";
import { createLocalFwkReadService, normalizeFwkResult, createHarnessProposalLifecycleService, normalizeProposalLifecycleResult, createLocalCollaborationService, normalizeCollaborationResult, sessionEvidenceRef, proposalNotePath, findSession } from "../sac/service";
import { randomUUID } from "node:crypto";
import type { JsonSchema, ToolEntry } from "./types";

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
    { name: "sac.collaboration", module: "sac", description: "Read safe SAC collaboration references and activity.", inputSchema: OBJECT_SCHEMA({ workspaceId: { type: "string" } }, ["workspaceId"]), mutating: false, async invoke(cwd, params, context) { if (context?.transport === "http") return { code: "sac_transport_denied" as const }; return normalizeCollaborationResult(await createLocalCollaborationService(cwd).overview({ workspaceId: stringParam(params, "workspaceId") ?? "", request: undefined, requestCorrelationId: randomUUID() })); } },
    {
      name: "sac.overview", module: "sac", description: "Read a bounded Shared Agent Context overview.",
      inputSchema: OBJECT_SCHEMA({ workspaceId: { type: "string" }, maxItems: { type: "number" }, maxTokens: { type: "number" } }, ["workspaceId"]),
      mutating: false,
      async invoke(cwd, params, context) {
        // v1 SAC is local-stdio only. HTTP has no verified principal policy and
        // must never inherit a local OS actor.
        if (context?.transport === "http") return { code: "sac_transport_denied" as const };
        const workspaceId = stringParam(params, "workspaceId") ?? "";
        const maxItems = typeof params.maxItems === "number" ? params.maxItems : 32;
        const maxTokens = typeof params.maxTokens === "number" ? params.maxTokens : 4096;
        return normalizeFwkResult(await createLocalFwkReadService(cwd).overview({ workspaceId, request: undefined, requestCorrelationId: randomUUID(), budget: { maxItems, maxTokens } }));
      },
    },
    {
      name: "sac.read", module: "sac", description: "Read one bounded Shared Agent Context item after overview.",
      inputSchema: OBJECT_SCHEMA({ workspaceId: { type: "string" }, itemId: { type: "string" }, maxItems: { type: "number" }, maxTokens: { type: "number" } }, ["workspaceId", "itemId"]),
      mutating: false,
      async invoke(cwd, params, context) {
        if (context?.transport === "http") return { code: "sac_transport_denied" as const };
        const workspaceId = stringParam(params, "workspaceId") ?? "";
        const itemId = stringParam(params, "itemId") ?? "";
        const maxItems = typeof params.maxItems === "number" ? params.maxItems : 1;
        const maxTokens = typeof params.maxTokens === "number" ? params.maxTokens : 4096;
        return normalizeFwkResult(await createLocalFwkReadService(cwd).read({ workspaceId, itemId, request: undefined, requestCorrelationId: randomUUID(), budget: { maxItems, maxTokens } }));
      },
    },
    {
      name: "sac.propose", module: "sac", description: "Create a real SAC proposal from a completed keryx session, for a reviewer to accept via sac.review.",
      inputSchema: OBJECT_SCHEMA({ workspaceId: { type: "string" }, kind: { type: "string", description: "decision | wiki-update | memory-entry | follow-up | contract-change | risk" }, sessionId: { type: "string" }, note: { type: "string" }, proposalRevision: { type: "string" } }, ["workspaceId", "kind", "sessionId"]),
      mutating: true,
      async invoke(cwd, params, context) {
        if (context?.transport === "http") return { code: "sac_transport_denied" as const };
        const workspaceId = stringParam(params, "workspaceId") ?? "";
        const kind = stringParam(params, "kind") ?? "";
        const sessionRef = stringParam(params, "sessionId") ?? "";
        const note = stringParam(params, "note");
        const proposalRevision = stringParam(params, "proposalRevision") ?? "1";
        // Resolve the human-friendly id/prefix to a canonical session id ONLY to
        // build a schema-valid `sourceRef` path — resolveSessionWrapUp (inside
        // wrapUpAuthority.issue below) independently re-looks this session up
        // itself and never trusts this resolution as evidence. Mirrors
        // src/commands/workspace.ts's `propose` handler exactly.
        const session = findSession(cwd, sessionRef);
        if (!session) throw new Error(`no session matching "${sessionRef}" in this project`);
        const { service, wrapUpAuthority, authorizationServer } = createHarnessProposalLifecycleService(cwd, { workspaceId, ...(note ? { note } : {}) });
        const requestCorrelationId = randomUUID();
        const actor = await authorizationServer.actorContextFor(undefined, requestCorrelationId);
        if (!actor) throw new Error("trusted ActorContext is required");
        const wrapUp = await wrapUpAuthority.issue({ actor, source: "session", sourceRef: sessionEvidenceRef(workspaceId, session.id) });
        const proposal = await service.create({ request: undefined, requestCorrelationId, workspaceId, id: `proposal-${randomUUID().replace(/-/g, "").slice(0, 16)}`, proposalRevision, kind: kind as never, wrapUp });
        // The note is not part of the frozen proposal schema — it lives in a
        // sidecar the memory/wiki/skill owner-writers read back at accept time,
        // since accept may happen in a different process/reviewer session.
        if (note) await writeFile(proposalNotePath(cwd, workspaceId, proposal.id), note, "utf8");
        return normalizeProposalLifecycleResult(proposal);
      },
    },
    {
      name: "sac.review", module: "sac", description: "Record a terminal SAC review decision through the guarded owner-writer seam.",
      inputSchema: OBJECT_SCHEMA({ workspaceId: { type: "string" }, proposalId: { type: "string" }, decision: { type: "string" }, reason: { type: "string" }, idempotencyKey: { type: "string" } }, ["workspaceId", "proposalId", "decision"]),
      mutating: true,
      async invoke(cwd, params, context) {
        if (context?.transport === "http") return { code: "sac_transport_denied" as const };
        const workspaceId = stringParam(params, "workspaceId") ?? ""; const proposalId = stringParam(params, "proposalId") ?? ""; const decision = stringParam(params, "decision") as "accepted" | "rejected" | "dismissed"; const reason = stringParam(params, "reason"); const idempotencyKey = stringParam(params, "idempotencyKey") ?? randomUUID();
        // Same composition as sac.propose: an accept must see the real owner
        // writer (memory/wiki/skill), or it lands in "stale" for no real reason.
        // `interactive: true` — matches current MCP trust posture (a human is
        // driving this tool call; SLATE-8's spec explicitly scopes the
        // stdio-transport trust gap as a separate, not-fixed-here concern, so
        // this does not invent a stricter MCP-specific policy).
        const result = await createHarnessProposalLifecycleService(cwd, { workspaceId }).service.review({ request: undefined, requestCorrelationId: randomUUID(), workspaceId, proposalId, decision, idempotencyKey, interactive: true, ...(reason ? { reason } : {}) });
        return normalizeProposalLifecycleResult(result);
      },
    },
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
        return createMetaprojectAdapter(cwd).memorySearch({ query });
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
