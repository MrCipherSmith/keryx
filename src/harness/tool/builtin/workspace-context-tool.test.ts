import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { workspaceOverviewTool, workspaceReadTool } from "./workspace-context-tool";
import { localWorkspaceAuthorizationServer, newWorkspaceId, WorkspaceService } from "../../../sac/workspace-service";

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "keryx-sac-workspace-tool-"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

async function createRealWorkspace(title: string): Promise<string> {
  const service = new WorkspaceService({
    workspaceRoot: cwd,
    authorizationServer: localWorkspaceAuthorizationServer(),
    strictGuard: { mode: "strict", availability: "available", decision: "pass", policyRevision: "local-offline-v1" },
  });
  const workspace = await service.create({ request: undefined, requestCorrelationId: randomUUID(), id: newWorkspaceId(), title });
  return workspace.id;
}

describe("workspaceOverviewTool", () => {
  test("rejects a missing workspaceId without calling the FWK service", async () => {
    const result = await workspaceOverviewTool(cwd).invoke({});
    expect(result.isError).toBe(true);
    expect(result.output).toContain("workspaceId");
  });

  test("rejects a negative maxItems", async () => {
    const result = await workspaceOverviewTool(cwd).invoke({ workspaceId: "workspace-a", maxItems: -1 });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("maxItems");
  });

  test("a nonexistent workspace surfaces as a denied read, not a tool error", async () => {
    const result = await workspaceOverviewTool(cwd).invoke({ workspaceId: "workspace-does-not-exist" });
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.output) as { manifest: { freshness: string } };
    expect(parsed.manifest.freshness).toBe("denied");
  });

  test("a real, resource-less workspace returns a well-formed, non-error overview", async () => {
    const workspaceId = await createRealWorkspace("workspace-context-tool live check");
    const result = await workspaceOverviewTool(cwd).invoke({ workspaceId });
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.output) as { manifest: { workspaceId: string; facts: unknown[] }; receipt: { workspaceId: string } };
    expect(parsed.manifest.workspaceId).toBe(workspaceId);
    expect(parsed.manifest.facts).toEqual([]);
    expect(parsed.receipt.workspaceId).toBe(workspaceId);
  });
});

describe("workspaceReadTool", () => {
  test("rejects a missing itemId without calling the FWK service", async () => {
    const result = await workspaceReadTool(cwd).invoke({ workspaceId: "workspace-a" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("itemId");
  });

  test("reading an unknown item in a real workspace does not throw", async () => {
    const workspaceId = await createRealWorkspace("workspace-context-tool read check");
    const result = await workspaceReadTool(cwd).invoke({ workspaceId, itemId: "no-such-item" });
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.output) as { manifest: { facts: unknown[] } };
    expect(parsed.manifest.facts).toEqual([]);
  });
});
