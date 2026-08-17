import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { buildToolRegistry } from "./tools";
import { createSession, persistHistory } from "../session/store";
import { localWorkspaceAuthorizationServer, newWorkspaceId, WorkspaceService } from "../sac/workspace-service";
import { mintConfirmToken } from "../sac/review-confirm-token";
import type { ToolEntry } from "./types";

let cwd: string;
let dataDir: string;
let originalDataDir: string | undefined;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "keryx-mcp-sac-tools-"));
  dataDir = await mkdtemp(path.join(tmpdir(), "keryx-mcp-sac-tools-data-"));
  originalDataDir = process.env.KERYX_DATA_DIR;
  process.env.KERYX_DATA_DIR = dataDir;
});

afterEach(async () => {
  if (originalDataDir !== undefined) process.env.KERYX_DATA_DIR = originalDataDir;
  else delete process.env.KERYX_DATA_DIR;
  await rm(cwd, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

function tool(name: string): ToolEntry {
  const found = buildToolRegistry().find((entry) => entry.name === name);
  if (!found) throw new Error(`tool "${name}" is not registered`);
  return found;
}

async function createWorkspace(title: string): Promise<string> {
  const service = new WorkspaceService({
    workspaceRoot: cwd,
    authorizationServer: localWorkspaceAuthorizationServer(),
    strictGuard: { mode: "strict", availability: "available", decision: "pass", policyRevision: "local-offline-v1" },
  });
  const id = newWorkspaceId();
  await service.create({ request: undefined, requestCorrelationId: randomUUID(), id, title });
  return id;
}

function realSession(title: string) {
  const handle = createSession({ cwd, title, provider: "deepseek", model: "deepseek-v4-flash" });
  return persistHistory(handle, [
    { role: "user", content: "What does the WorktreePort interface do?", provenance: "project" },
    { role: "assistant", content: "It's the create/remove/merge git-worktree lifecycle seam.", provenance: "model" },
  ]);
}

describe("sac.propose / sac.review over MCP", () => {
  test("http transport is denied for both propose and review", async () => {
    expect(await tool("sac.propose").invoke(cwd, {}, { transport: "http" })).toEqual({ code: "sac_transport_denied" });
    expect(await tool("sac.review").invoke(cwd, {}, { transport: "http" })).toEqual({ code: "sac_transport_denied" });
  });

  test("propose rejects a session id that does not exist in this project", async () => {
    const workspaceId = await createWorkspace("mcp sac test");
    await expect(
      tool("sac.propose").invoke(cwd, { workspaceId, kind: "memory-entry", sessionId: "no-such-session" }, { transport: "stdio" }),
    ).rejects.toThrow(/no session matching/);
  });

  test("propose then review lands a real memory-entry file end-to-end, note included", async () => {
    const workspaceId = await createWorkspace("mcp sac test");
    const session = realSession("Explain WorktreePort");

    const proposed = (await tool("sac.propose").invoke(
      cwd,
      { workspaceId, kind: "memory-entry", sessionId: session.summary.id, note: "MCP propose worked end-to-end." },
      { transport: "stdio" },
    )) as { id: string; status: string; kind: string };
    expect(proposed.status).toBe("proposed");
    expect(proposed.kind).toBe("memory-entry");

    // SLATE-20: accept requires a confirm token minted by `keryx workspace
    // confirm-review` — never mintable through the sac.review tool itself.
    const { token } = await mintConfirmToken(cwd, workspaceId, proposed.id);
    const reviewed = (await tool("sac.review").invoke(
      cwd,
      { workspaceId, proposalId: proposed.id, decision: "accepted", confirmToken: token },
      { transport: "stdio" },
    )) as { event: { toStatus: string; acceptance?: { targetWrite?: { targetRef: string } } } };
    expect(reviewed.event.toStatus).toBe("accepted");
    expect(reviewed.event.acceptance?.targetWrite?.targetRef).toBe(`./memory/task-notes/sac-${proposed.id}.md`);

    const written = await readFile(path.join(cwd, ".metaproject", "memory", "task-notes", `sac-${proposed.id}.md`), "utf8");
    expect(written).toContain("MCP propose worked end-to-end.");
  });
});

describe("sac.workspaceList / sac.workspaceShow / sac.workspaceCreate over MCP (SLATE-19b)", () => {
  test("http transport is denied for all three", async () => {
    expect(await tool("sac.workspaceList").invoke(cwd, {}, { transport: "http" })).toEqual({ code: "sac_transport_denied" });
    expect(await tool("sac.workspaceShow").invoke(cwd, {}, { transport: "http" })).toEqual({ code: "sac_transport_denied" });
    expect(await tool("sac.workspaceCreate").invoke(cwd, {}, { transport: "http" })).toEqual({ code: "sac_transport_denied" });
  });

  test("workspaceCreate rejects an empty title without writing anything", async () => {
    await expect(tool("sac.workspaceCreate").invoke(cwd, {}, { transport: "stdio" })).rejects.toThrow(/title/);
    expect(await tool("sac.workspaceList").invoke(cwd, {}, { transport: "stdio" })).toEqual([]);
  });

  test("workspaceCreate then workspaceList/workspaceShow see the SAME record the CLI/keryx-shell tools produce — no shadow state", async () => {
    const created = (await tool("sac.workspaceCreate").invoke(cwd, { title: "MCP-created workspace" }, { transport: "stdio" })) as { id: string; title: string; status: string };
    expect(created.title).toBe("MCP-created workspace");
    expect(created.status).toBe("active");

    const listed = (await tool("sac.workspaceList").invoke(cwd, {}, { transport: "stdio" })) as Array<{ id: string }>;
    expect(listed.map((w) => w.id)).toContain(created.id);

    const shown = (await tool("sac.workspaceShow").invoke(cwd, { workspaceId: created.id }, { transport: "stdio" })) as { id: string; title: string };
    expect(shown.id).toBe(created.id);
    expect(shown.title).toBe("MCP-created workspace");

    // Real, on-disk WorkspaceService record — the same manifest the CLI
    // (`keryx workspace show`) and the keryx-shell workspace_show tool read.
    const manifest = new WorkspaceService({ workspaceRoot: cwd, authorizationServer: localWorkspaceAuthorizationServer(), strictGuard: { mode: "strict", availability: "available", decision: "pass", policyRevision: "local-offline-v1" } });
    const fromService = await manifest.show({ request: undefined, requestCorrelationId: randomUUID(), workspaceId: created.id });
    expect(fromService.title).toBe("MCP-created workspace");
  });

  test("workspaceList reflects a workspace created by the CLI/WorkspaceService directly, not just ones created through this tool", async () => {
    const workspaceId = await createWorkspace("created outside MCP");
    const listed = (await tool("sac.workspaceList").invoke(cwd, {}, { transport: "stdio" })) as Array<{ id: string }>;
    expect(listed.map((w) => w.id)).toEqual([workspaceId]);
  });
});
