import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { WorkspaceService, localWorkspaceAuthorizationServer } from "../../sac/workspace-service";
import { loadInspectorWorkspace } from "../../tui/inspector-sources";
import { renderSetupSlash } from "../../commands/setup-guide";
import { executeProjectInspection, projectInspectionCommands, type ProjectInspectionContext } from "./project-inspection";

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

test("domain errors stay sanitized and bounded; direct contribution execution validates arguments", async () => {
  const c = await context(); c.inspectionMode = "hub-remote";
  c.projectContext = { source: "hub-canonical", listFlows: async () => { throw new Error("Authorization: Bearer private-token"); }, readFlow: async () => ({}) };
  const result = await executeProjectInspection(c, "flows", {});
  expect(result).toMatchObject({ ok: false, error: { code: "read-failed" } });
  expect(JSON.stringify(result)).not.toContain("private-token");
  const entries = projectInspectionCommands(); expect(entries).toHaveLength(13);
  expect(entries.map((entry) => entry.entry.commandName)).toContain("doctor");
});
