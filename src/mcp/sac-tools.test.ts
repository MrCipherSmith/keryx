import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { buildToolRegistry } from "./tools";
import { createSession, persistHistory } from "../session/store";
import { localWorkspaceAuthorizationServer, newWorkspaceId, WorkspaceService } from "../sac/workspace-service";
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

    const reviewed = (await tool("sac.review").invoke(
      cwd,
      { workspaceId, proposalId: proposed.id, decision: "accepted" },
      { transport: "stdio" },
    )) as { event: { toStatus: string; acceptance?: { targetWrite?: { targetRef: string } } } };
    expect(reviewed.event.toStatus).toBe("accepted");
    expect(reviewed.event.acceptance?.targetWrite?.targetRef).toBe(`./memory/task-notes/sac-${proposed.id}.md`);

    const written = await readFile(path.join(cwd, ".metaproject", "memory", "task-notes", `sac-${proposed.id}.md`), "utf8");
    expect(written).toContain("MCP propose worked end-to-end.");
  });
});
