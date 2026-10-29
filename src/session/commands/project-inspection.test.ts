import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { WorkspaceService, localWorkspaceAuthorizationServer } from "../../sac/workspace-service";
import { loadInspectorWorkspace } from "../../tui/inspector-sources";
import { renderSetupSlash } from "../../commands/setup-guide";
import { readOpenIntents } from "../../commands/product";
import { executeProjectInspection, projectInspectionCommands, type ProjectInspectionContext } from "./project-inspection";
import { registerOpenIntentReader } from "./open-intents";

// As the CLI registry does in every keryx process: the product command hands its reader to the session command port.
registerOpenIntentReader(readOpenIntents);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function context(): Promise<ProjectInspectionContext> {
  const cwd = await mkdtemp(path.join(tmpdir(), "keryx-native-project-")); roots.push(cwd);
  return { cwd, nativeSessionDir: path.join(cwd, "session-native"), inspectionMode: "local-native" };
}

test("project command workspace reads the actual same local domain service as the TUI", async () => {
  const c = await context();
  const service = new WorkspaceService({ workspaceRoot: c.cwd, authorizationServer: localWorkspaceAuthorizationServer(),
    strictGuard: { mode: "strict", availability: "available", decision: "pass", policyRevision: "local-offline-v1" } });
  await service.create({ request: undefined, requestCorrelationId: randomUUID(), id: "workspace-native", title: "Native project" });
  const result = await executeProjectInspection(c, "workspace", { workspaceId: "workspace-native" });
  expect(result.ok).toBe(true);
  if (result.ok) { expect(result.source).toBe("local-native"); expect(result.data).toMatchObject({ workspace: await loadInspectorWorkspace(c.cwd, "workspace-native"), slates: [] }); }
});

test("remote Flow inspection is canonical and never reads a legacy local counterpart", async () => {
  const c = await context(); c.inspectionMode = "hub-remote";
  c.projectContext = { source: "hub-canonical", listFlows: async () => [{ id: "canonical-flow", status: "in-progress" }], readFlow: async (id) => ({ id, version: 7, criteria: ["Exact current criteria"] }) };
  const list = await executeProjectInspection(c, "flows", {});
  expect(list).toMatchObject({ ok: true, source: "hub-canonical", data: [{ id: "canonical-flow" }] });
  const one = await executeProjectInspection(c, "flow", { flowId: "canonical-flow" });
  expect(one).toMatchObject({ ok: true, source: "hub-canonical", data: { id: "canonical-flow", version: 7 } });
});

test("missing remote Flow port refuses without silently falling back to local Metaproject", async () => {
  const c = await context(); c.inspectionMode = "hub-remote";
  expect(await executeProjectInspection(c, "flows", {})).toMatchObject({ ok: false, error: { code: "setup-required" } });
  expect(await executeProjectInspection(c, "ac", {})).toMatchObject({ ok: false, error: { code: "setup-required" } });
});

test("arms inspection exposes the actual report's per-arm and channel counters", async () => {
  const result = await executeProjectInspection(await context(), "decisions", { section: "arms" });
  expect(result).toMatchObject({ ok: true, data: { byArm: { A: { answered: 0 }, B: { answered: 0 } }, byChannel: [] } });
});

test("closed command arguments reject unknown actions and fields before any domain read", async () => {
  const c = await context(); let calls = 0; c.inspectionMode = "hub-remote";
  c.projectContext = { source: "hub-canonical", listFlows: async () => { calls++; return []; }, readFlow: async () => { calls++; return {}; } };
  expect(await executeProjectInspection(c, "flows", { arbitraryPath: "/private" })).toMatchObject({ ok: false, error: { code: "invalid-arguments" } });
  expect(await executeProjectInspection(c, "flow", { action: "freeze" })).toMatchObject({ ok: false, error: { code: "invalid-arguments" } });
  expect(calls).toBe(0);
});

test("setup guide shares the actual scenario renderer and never executes the listed steps", async () => {
  const c = await context();
  expect(await executeProjectInspection(c, "setup", { scenario: "repair" })).toMatchObject({ ok: true, source: "local-native", data: renderSetupSlash("repair") });
  expect(await executeProjectInspection(c, "setup", { scenario: "repair", run: true })).toMatchObject({ ok: false, error: { code: "invalid-arguments" } });
});

test("read-only empty reports are genuine domain outcomes with explicit source", async () => {
  const c = await context();
  for (const command of ["decisions", "product", "governance", "triggers", "reviews", "review"]) {
    const result = await executeProjectInspection(c, command, {});
    expect(result.ok).toBe(true); if (result.ok) expect(result.source).toBe("local-native");
  }
  expect(await executeProjectInspection(c, "integrate", {})).toMatchObject({ ok: false, error: { code: "local-required" } });
});

test("/product reads the open report only through the reader the product command registers, and refuses setup-required where none is", async () => {
  const c = await context();
  registerOpenIntentReader(undefined);
  try {
    expect(await executeProjectInspection(c, "product", {})).toMatchObject({ ok: false, source: "local-native", error: { code: "setup-required" } });
    registerOpenIntentReader(readOpenIntents);
    expect(await executeProjectInspection(c, "product", {})).toEqual({ ok: true, source: "local-native", data: await readOpenIntents(c.cwd) });
  } finally { registerOpenIntentReader(readOpenIntents); }
});

test("domain errors stay sanitized and bounded; direct contribution execution validates arguments", async () => {
  const c = await context(); c.inspectionMode = "hub-remote";
  c.projectContext = { source: "hub-canonical", listFlows: async () => { throw new Error("Authorization: Bearer private-token"); }, readFlow: async () => ({}) };
  const result = await executeProjectInspection(c, "flows", {});
  expect(result).toMatchObject({ ok: false, error: { code: "read-failed" } });
  expect(JSON.stringify(result)).not.toContain("private-token");
  const entries = projectInspectionCommands(); expect(entries).toHaveLength(14);
  expect(entries.map((entry) => entry.entry.commandName)).toContain("doctor");
});

test("workspace.slate opens the one slate the workspace inspector's Slate tab shows, selected by its session", async () => {
  const c = await context(); const previous = process.env.KERYX_DATA_DIR; process.env.KERYX_DATA_DIR = path.join(c.cwd, "data");
  try {
    const { createSession } = await import("../store"); const { writeSlate } = await import("../slate"); const { loadInspectorSlates } = await import("../../tui/inspector-sources");
    await new WorkspaceService({ workspaceRoot: c.cwd, authorizationServer: localWorkspaceAuthorizationServer(), strictGuard: { mode: "strict", availability: "available", decision: "pass", policyRevision: "local-offline-v1" } })
      .create({ request: undefined, requestCorrelationId: randomUUID(), id: "workspace-slate", title: "Slates" });
    const session = createSession({ cwd: c.cwd, title: "Bound session" });
    await writeSlate(session.dir, () => ({ workspaceId: "workspace-slate", anchors: { root: c.cwd, touched: ["src/a.ts"] }, course: { flowRef: "042" }, seeds: [] }));
    const [expected] = await loadInspectorSlates(c.cwd, "workspace-slate");
    expect(expected).toMatchObject({ sessionId: session.summary.id, flowRef: "042" });
    expect(await executeProjectInspection(c, "workspace.slate", { workspaceId: "workspace-slate", sessionId: session.summary.id })).toEqual({ ok: true, source: "local-native", data: JSON.parse(JSON.stringify(expected).replaceAll(c.cwd, ".")) });
    expect(await executeProjectInspection(c, "workspace.slate", { workspaceId: "workspace-slate", sessionId: "another" })).toMatchObject({ ok: false, error: { code: "not-found" } });
    expect(await executeProjectInspection(c, "workspace.slate", { workspaceId: "absent", sessionId: session.summary.id })).toMatchObject({ ok: false, error: { code: "not-found" } });
    expect(await executeProjectInspection(c, "workspace.slate", { workspaceId: "workspace-slate" })).toMatchObject({ ok: false, error: { code: "invalid-arguments" } });
  } finally { if (previous === undefined) delete process.env.KERYX_DATA_DIR; else process.env.KERYX_DATA_DIR = previous; }
});

test("/reviews depth reads the same per-review depth the reviews panel shows, without the bot metrics", async () => {
  const c = await context();
  const { loadReviewDepth } = await import("../../tui/review-panel");
  const depth = await executeProjectInspection(c, "reviews", { section: "depth" });
  expect(depth).toEqual({ ok: true, source: "local-native", data: { section: "depth", depth: JSON.parse(JSON.stringify(await loadReviewDepth(c.cwd))) } });
  expect(await executeProjectInspection(c, "reviews", { section: "everything" })).toMatchObject({ ok: false, error: { code: "invalid-arguments" } });
});
