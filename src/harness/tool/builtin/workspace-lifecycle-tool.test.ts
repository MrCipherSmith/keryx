import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { workspaceCreateTool, workspaceListTool, workspaceProposeTool, workspaceShowTool } from "./workspace-lifecycle-tool";
import { createSession, persistHistory } from "../../../session/store";
import { sessionDir } from "../../../session/paths";

const noSession = () => undefined;

let cwd: string;
let dataDir: string;
let originalDataDir: string | undefined;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "keryx-workspace-lifecycle-tool-"));
  dataDir = await mkdtemp(path.join(tmpdir(), "keryx-workspace-lifecycle-tool-data-"));
  originalDataDir = process.env.KERYX_DATA_DIR;
  process.env.KERYX_DATA_DIR = dataDir;
});

afterEach(async () => {
  if (originalDataDir !== undefined) process.env.KERYX_DATA_DIR = originalDataDir;
  else delete process.env.KERYX_DATA_DIR;
  await rm(cwd, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

function realSession(title: string) {
  const handle = createSession({ cwd, title, provider: "deepseek", model: "deepseek-v4-flash" });
  return persistHistory(handle, [
    { role: "user", content: "What does the WorktreePort interface do?", provenance: "project" },
    { role: "assistant", content: "It's the create/remove/merge git-worktree lifecycle seam.", provenance: "model" },
  ]);
}

describe("workspaceCreateTool", () => {
  test("rejects an empty title without calling the service", async () => {
    const result = await workspaceCreateTool(cwd).invoke({});
    expect(result.isError).toBe(true);
    expect(result.output).toContain("title");
  });

  test("creates a real, listable workspace", async () => {
    const result = await workspaceCreateTool(cwd).invoke({ title: "My new topic" });
    expect(result.isError).toBe(false);
    const created = JSON.parse(result.output) as { id: string; title: string; status: string };
    expect(created.title).toBe("My new topic");
    expect(created.status).toBe("active");

    const listed = await workspaceListTool(cwd).invoke({});
    const workspaces = JSON.parse(listed.output) as Array<{ id: string }>;
    expect(workspaces.map((w) => w.id)).toContain(created.id);
  });
});

describe("workspaceListTool", () => {
  test("an empty project returns an empty list, not an error", async () => {
    const result = await workspaceListTool(cwd).invoke({});
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.output)).toEqual([]);
  });
});

describe("workspaceShowTool", () => {
  test("rejects a missing workspaceId without calling the service", async () => {
    const result = await workspaceShowTool(cwd).invoke({});
    expect(result.isError).toBe(true);
    expect(result.output).toContain("workspaceId");
  });

  test("a nonexistent workspace is a tool error, not a thrown exception", async () => {
    const result = await workspaceShowTool(cwd).invoke({ workspaceId: "no-such-workspace" });
    expect(result.isError).toBe(true);
  });

  test("shows a real workspace's manifest", async () => {
    const created = await workspaceCreateTool(cwd).invoke({ title: "Show me" });
    const { id } = JSON.parse(created.output) as { id: string };
    const shown = await workspaceShowTool(cwd).invoke({ workspaceId: id });
    expect(shown.isError).toBe(false);
    expect((JSON.parse(shown.output) as { id: string }).id).toBe(id);
  });
});

describe("workspaceProposeTool", () => {
  test("rejects an unrecognized kind without calling the service", async () => {
    const result = await workspaceProposeTool(cwd, noSession).invoke({ workspaceId: "workspace-a", kind: "not-a-real-kind", sessionId: "s1" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("kind");
  });

  test("rejects a session id that does not exist in this project", async () => {
    const created = await workspaceCreateTool(cwd).invoke({ title: "Propose target" });
    const { id: workspaceId } = JSON.parse(created.output) as { id: string };
    const result = await workspaceProposeTool(cwd, noSession).invoke({ workspaceId, kind: "memory-entry", sessionId: "no-such-session" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("no session matching");
  });

  test("with no sessionId given and no active session, fails without calling the service", async () => {
    const created = await workspaceCreateTool(cwd).invoke({ title: "Propose target" });
    const { id: workspaceId } = JSON.parse(created.output) as { id: string };
    const result = await workspaceProposeTool(cwd, noSession).invoke({ workspaceId, kind: "memory-entry" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("no active session");
  });

  // The model calling this tool can never accept its own proposal — SLATE-20's
  // confirm-token is mintable only by a real, approval-gated shell command
  // (`keryx workspace confirm-review`), which this tool has no path to. This
  // test only proves the proposal record itself lands, matching
  // src/mcp/sac-tools.test.ts's "propose ... lands ... end-to-end" shape.
  test("proposes from a real session and lands a real, schema-valid proposed record", async () => {
    const created = await workspaceCreateTool(cwd).invoke({ title: "Propose target" });
    const { id: workspaceId } = JSON.parse(created.output) as { id: string };
    const session = realSession("Explain WorktreePort");

    const result = await workspaceProposeTool(cwd, noSession).invoke({ workspaceId, kind: "memory-entry", sessionId: session.summary.id, note: "found via workspace_propose" });
    expect(result.isError).toBe(false);
    const proposal = JSON.parse(result.output) as { status: string; kind: string; workspaceId: string };
    expect(proposal.status).toBe("proposed");
    expect(proposal.kind).toBe("memory-entry");
    expect(proposal.workspaceId).toBe(workspaceId);
  });

  // SLATE-19: sessionId defaults to the CURRENT session (derived from
  // getSessionDir) when the model omits it — the overwhelmingly common case
  // (proposing from the session it is already running in).
  test("with no explicit sessionId, defaults to the current session via getSessionDir", async () => {
    const created = await workspaceCreateTool(cwd).invoke({ title: "Propose target" });
    const { id: workspaceId } = JSON.parse(created.output) as { id: string };
    const session = realSession("Explain WorktreePort, default session");
    const getSessionDir = () => sessionDir(cwd, session.summary.id);

    const result = await workspaceProposeTool(cwd, getSessionDir).invoke({ workspaceId, kind: "memory-entry" });
    expect(result.isError).toBe(false);
    const proposal = JSON.parse(result.output) as { status: string };
    expect(proposal.status).toBe("proposed");
  });
});
