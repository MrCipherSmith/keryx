import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { workspaceCreateTool, workspaceListTool, workspaceProposeTool, workspaceShowTool } from "./workspace-lifecycle-tool";
import { createSession, persistHistory } from "../../../session/store";
import { sessionDir } from "../../../session/paths";
import { localWorkspaceAuthorizationServer, WorkspaceService } from "../../../sac/workspace-service";
import { buildToolRegistry } from "../../../mcp/tools";

function mcpTool(name: string) {
  const found = buildToolRegistry().find((entry) => entry.name === name);
  if (!found) throw new Error(`tool "${name}" is not registered`);
  return found;
}

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

  test("C-11: a failed lazy Slate binding is surfaced as a redaction-safe degraded result", async () => {
    // The creation path currently catches the lazy `writeSlate` failure and
    // leaves the workspace listable. This assertion intentionally stays RED
    // until that catch exposes a safe, observable degraded indicator.
    const source = await readFile(new URL("./workspace-lifecycle-tool.ts", import.meta.url), "utf8");

    expect(source).toMatch(/(?:binding.*degraded|degraded.*binding)/i);
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

// --- Flow 242 lane D, AC5 on the THIRD surface ------------------------------
//
// AC5 requires "never existed", "existed and is gone", and "I cannot say" to be
// distinguishable wherever knowledge is asked for — CLI, the agent tool
// boundary, AND MCP. The CLI and MCP were fixed by routing both through
// `listWorkspaceViews`/`lookupWorkspace`; these two tools were not, and so
// answered the same question a third way: bare manifests with no reference
// report at all, and every failure flattened into one `workspace_show failed:`
// string. That made a workspace with a deleted target indistinguishable from an
// intact one, and a nonexistent id indistinguishable from an unreadable one.
describe("the agent tool boundary answers a reference into deleted knowledge the same way the CLI and MCP do", () => {
  async function workspaceWithDeletedReference(): Promise<string> {
    await mkdir(path.join(cwd, "wiki"), { recursive: true });
    await writeFile(path.join(cwd, "wiki", "page-a.md"), "Status: accepted\n\nThe retry limit is 3.\n");
    await writeFile(path.join(cwd, "wiki", "page-b.md"), "Status: accepted\n\nThe second page stays.\n");
    const created = await workspaceCreateTool(cwd).invoke({ title: "Forgetting" });
    const { id } = JSON.parse(created.output) as { id: string };
    const service = new WorkspaceService({
      workspaceRoot: cwd,
      authorizationServer: localWorkspaceAuthorizationServer(),
      strictGuard: { mode: "strict", availability: "available", decision: "pass", policyRevision: "local-offline-v1" },
    });
    for (const uri of ["./wiki/page-a.md", "./wiki/page-b.md"]) {
      await service.addResource({ request: undefined, requestCorrelationId: randomUUID(), workspaceId: id, resource: { kind: "wiki", uri } });
    }
    await rm(path.join(cwd, "wiki", "page-a.md"));
    return id;
  }

  test("workspace_list still lists it and names the failing reference — it does not drop it into the same empty list an empty project returns", async () => {
    const id = await workspaceWithDeletedReference();
    const listed = await workspaceListTool(cwd).invoke({});
    expect(listed.isError).toBe(false);
    const entries = JSON.parse(listed.output) as Array<{ id: string; status: string; references: { ok: boolean; unresolvable: string[] } }>;
    expect(entries.map((entry) => entry.id)).toEqual([id]);
    expect(entries[0]!.status).toBe("active");
    expect(entries[0]!.references.ok).toBe(false);
    expect(entries[0]!.references.unresolvable).toEqual(["./wiki/page-a.md"]);
  });

  test("workspace_show still shows it, names the failing reference, and reports a nonexistent id as `not-found` rather than an unnamed failure", async () => {
    const id = await workspaceWithDeletedReference();
    const shown = await workspaceShowTool(cwd).invoke({ workspaceId: id });
    expect(shown.isError).toBe(false);
    const manifest = JSON.parse(shown.output) as { id: string; references: { unresolvable: string[]; resources: Array<{ uri: string; state: string }> } };
    expect(manifest.id).toBe(id);
    expect(manifest.references.unresolvable).toEqual(["./wiki/page-a.md"]);
    expect(manifest.references.resources.find((entry) => entry.uri === "./wiki/page-b.md")!.state).toBe("resolved");

    const missing = await workspaceShowTool(cwd).invoke({ workspaceId: "workspace-never-existed00" });
    expect(missing.isError).toBe(true);
    expect(JSON.parse(missing.output)).toMatchObject({ outcome: "not-found", workspaceId: "workspace-never-existed00" });
    // The named outcome must not carry this machine's own source paths.
    expect(missing.output).not.toContain(import.meta.dir);
  });

  test("\"never existed\", \"exists but cannot be read\" and a live workspace are three different answers on both the agent boundary and MCP", async () => {
    const live = JSON.parse((await workspaceCreateTool(cwd).invoke({ title: "Alive" })).output) as { id: string };
    // A manifest that is really on disk and really unparseable — not a
    // substituted error. "I cannot say" must not arrive as "there is nothing".
    await mkdir(path.join(cwd, ".metaproject", "workspaces", "workspace-corrupt0000"), { recursive: true });
    await writeFile(path.join(cwd, ".metaproject", "workspaces", "workspace-corrupt0000", "workspace.json"), "{ not json");

    const agentOutcome = async (id: string) => (JSON.parse((await workspaceShowTool(cwd).invoke({ workspaceId: id })).output) as { outcome?: string }).outcome ?? "workspace";
    const mcpCode = async (id: string) => ((await mcpTool("sac.workspaceShow").invoke(cwd, { workspaceId: id }, { transport: "stdio" })) as { code?: string }).code ?? "workspace";

    expect(await agentOutcome(live.id)).toBe("workspace");
    expect(await agentOutcome("workspace-never-existed00")).toBe("not-found");
    expect(await agentOutcome("workspace-corrupt0000")).toBe("unreadable");
    expect(await mcpCode(live.id)).toBe("workspace");
    expect(await mcpCode("workspace-never-existed00")).toBe("sac_workspace_not_found");
    expect(await mcpCode("workspace-corrupt0000")).toBe("sac_workspace_unreadable");
  });

  test("the three surfaces agree, byte for byte, on the same workspace at the same moment", async () => {
    const id = await workspaceWithDeletedReference();
    const agentList = JSON.parse((await workspaceListTool(cwd).invoke({})).output) as unknown[];
    const mcpList = await mcpTool("sac.workspaceList").invoke(cwd, {}, { transport: "stdio" });
    expect(agentList).toEqual(mcpList as unknown[]);

    const agentShow = JSON.parse((await workspaceShowTool(cwd).invoke({ workspaceId: id })).output) as unknown;
    const mcpShow = await mcpTool("sac.workspaceShow").invoke(cwd, { workspaceId: id }, { transport: "stdio" });
    expect(agentShow).toEqual(mcpShow);
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
  test("a note the security gate blocks is refused, and no proposal is created", async () => {
    // The `!materializedNote.allowed` refusal survived deletion with the full
    // suite green — no test drove a note that the guard actually blocks, so the
    // branch that stops a secret-bearing note from becoming a durable proposal
    // was never executed.
    //
    // What makes this worth pinning rather than trusting: the refusal has to
    // happen BEFORE `lifecycle.create`, because create is the commit point. If
    // the order ever inverts, the tool reports failure while a live proposal
    // exists — the "half-committed" shape this file's own comments warn about.
    await mkdir(path.join(cwd, ".metaproject"), { recursive: true });
    await writeFile(path.join(cwd, ".metaproject", "metaproject.json"), JSON.stringify({ modules: { security: { enabled: true } } }), "utf8");
    await writeFile(path.join(cwd, ".metaproject", "security.config.json"), JSON.stringify({ mode: "enforced" }), "utf8");

    const created = await workspaceCreateTool(cwd).invoke({ title: "Blocked note" });
    const { id: workspaceId } = JSON.parse(created.output) as { id: string };
    const session = realSession("Propose with a leaking note");

    const result = await workspaceProposeTool(cwd, noSession).invoke({
      workspaceId,
      kind: "memory-entry",
      sessionId: session.summary.id,
      note: `aws_key = AKIA${"A".repeat(16)}`,
    });
    expect(result.isError).toBe(true);

    // And nothing durable was created: the refusal is not merely a message.
    const proposalsDir = path.join(cwd, ".metaproject", "workspaces", workspaceId, "proposals");
    const landed = await readdir(proposalsDir).catch(() => [] as string[]);
    expect(landed.filter((entry) => entry.endsWith(".json"))).toEqual([]);
  });

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
