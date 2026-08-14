// Read-only agent-facing tools for the Shared Agent Context (SAC) FWK
// (Facts/Work/Know-how) read path — the first wiring of a live keryx shell
// agent turn to SAC workspace context. Previously this was reachable only
// from a separate CLI process (`keryx workspace overview`/`keryx workspace
// read`, src/commands/workspace.ts) via `createLocalFwkReadService`
// (src/sac/fwk-service.ts); this exposes the same service to a running turn.
//
// There is no session <-> workspace linkage anywhere in keryx today (no
// `--workspace` flag on `keryx shell`, no workspace field on SessionSummary),
// so the agent must be told which workspace to read via an explicit
// `workspaceId` argument on every call, exactly like the CLI does.
//
// `FwkReadService.overview`/`.read` never throw for a missing/invalid
// workspace, a revoked role, or a denied actor — they return a `denied`-shaped
// result instead (fwk-service.ts's `resolve`/`denied`). So a nonexistent
// workspaceId surfaces as ordinary JSON output (`manifest.freshness:
// "denied"`), not a tool failure; `isError` here is reserved for malformed
// tool input.
import { randomUUID } from "node:crypto";
import { createLocalFwkReadService, normalizeFwkResult } from "../../../sac/fwk-service";
import type { InteractiveTool } from "./interactive-tools";

function parseBudget(input: Record<string, unknown>, defaultMaxItems: number): { maxItems: number; maxTokens: number } | { error: string } {
  const maxItems = input.maxItems === undefined ? defaultMaxItems : input.maxItems;
  const maxTokens = input.maxTokens === undefined ? 4096 : input.maxTokens;
  if (typeof maxItems !== "number" || !Number.isInteger(maxItems) || maxItems < 0) return { error: "maxItems must be a non-negative integer" };
  if (typeof maxTokens !== "number" || !Number.isInteger(maxTokens) || maxTokens < 0) return { error: "maxTokens must be a non-negative integer" };
  return { maxItems, maxTokens };
}

export function workspaceOverviewTool(cwd: string): InteractiveTool {
  return {
    definition: {
      name: "workspace_overview",
      description:
        "Read a Shared Agent Context (SAC) workspace's Facts/Work/Know-how overview - accepted, evidence-backed project context a reviewer curated into that workspace. Input: { workspaceId: string, maxItems?: number, maxTokens?: number }. Discover workspace ids with `keryx workspace list` via shell_exec first.",
      inputSchema: {
        type: "object",
        properties: { workspaceId: { type: "string" }, maxItems: { type: "number" }, maxTokens: { type: "number" } },
        required: ["workspaceId"],
        additionalProperties: false,
      },
      risk: "read",
    },
    invoke: async (input) => {
      const workspaceId = typeof input.workspaceId === "string" ? input.workspaceId : "";
      if (workspaceId.length === 0) return { output: "workspace_overview requires a non-empty 'workspaceId'", isError: true };
      const budget = parseBudget(input, 32);
      if ("error" in budget) return { output: budget.error, isError: true };
      const result = await createLocalFwkReadService(cwd).overview({ workspaceId, request: undefined, requestCorrelationId: randomUUID(), budget });
      return { output: JSON.stringify(normalizeFwkResult(result), null, 2), isError: false };
    },
  };
}

export function workspaceReadTool(cwd: string): InteractiveTool {
  return {
    definition: {
      name: "workspace_read",
      description:
        "Read one specific item (by id) from a Shared Agent Context (SAC) workspace - a fact, a know-how entry, or 'work' - discovered via workspace_overview first. Input: { workspaceId: string, itemId: string, maxItems?: number, maxTokens?: number }.",
      inputSchema: {
        type: "object",
        properties: { workspaceId: { type: "string" }, itemId: { type: "string" }, maxItems: { type: "number" }, maxTokens: { type: "number" } },
        required: ["workspaceId", "itemId"],
        additionalProperties: false,
      },
      risk: "read",
    },
    invoke: async (input) => {
      const workspaceId = typeof input.workspaceId === "string" ? input.workspaceId : "";
      const itemId = typeof input.itemId === "string" ? input.itemId : "";
      if (workspaceId.length === 0) return { output: "workspace_read requires a non-empty 'workspaceId'", isError: true };
      if (itemId.length === 0) return { output: "workspace_read requires a non-empty 'itemId'", isError: true };
      const budget = parseBudget(input, 1);
      if ("error" in budget) return { output: budget.error, isError: true };
      const result = await createLocalFwkReadService(cwd).read({ workspaceId, itemId, request: undefined, requestCorrelationId: randomUUID(), budget });
      return { output: JSON.stringify(normalizeFwkResult(result), null, 2), isError: false };
    },
  };
}
