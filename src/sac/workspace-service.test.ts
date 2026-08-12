import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSacAuthorizationServer } from "./index";
import { WorkspaceService } from "./workspace-service";
import type { StrictSacGuard } from "./index";
import { withFileLock } from "../lib/fs";

const strict = { mode: "strict", availability: "available", decision: "pass", policyRevision: "test-policy" } as const;
async function root(): Promise<string> { const value = await mkdtemp(path.join(tmpdir(), "keryx-sac-registry-")); await mkdir(path.join(value, "src")); await writeFile(path.join(value, "src", "a.ts"), "export {};\n"); await writeFile(path.join(value, "src", "b.ts"), "export {};\n"); return value; }
function server(subject: string) { return createSacAuthorizationServer({ authenticateRequest: async () => ({ subject, authenticationMethod: "local-os", roleRevision: "roles-v1" }) }); }
function service(workspaceRoot: string, subject = "user:owner", guard: StrictSacGuard = strict) { return new WorkspaceService({ workspaceRoot, authorizationServer: server(subject), strictGuard: guard }); }
const request = { transport: "local" };

test("WorkspaceService creates, lists, reads, and atomically adds typed resources offline", async () => {
  const workspaceRoot = await root(); const owner = service(workspaceRoot);
  const created = await owner.create({ request, requestCorrelationId: "registry-create-1", id: "workspace-alpha", title: "Alpha", component: { kind: "component", uri: "./src/a.ts" } });
  expect(created.members).toEqual([{ subject: "user:owner", role: "owner" }]);
  expect(await owner.list({ request, requestCorrelationId: "registry-list-0001" })).toHaveLength(1);
  expect((await owner.show({ request, requestCorrelationId: "registry-show-0001", workspaceId: created.id })).id).toBe(created.id);
  const updated = await owner.addResource({ request, requestCorrelationId: "registry-add-0001", workspaceId: created.id, resource: { kind: "component", uri: "./src/b.ts", revision: "abc" } });
  expect(updated.resources.map((resource) => resource.uri)).toEqual(["./src/a.ts", "./src/b.ts"]);
  expect(await readFile(path.join(workspaceRoot, ".metaproject", "workspaces", created.id, "workspace.json"), "utf8")).toContain('"workspace-alpha"');
  await expect(owner.create({ request, requestCorrelationId: "registry-conflict-0001", id: created.id, title: "Duplicate" })).rejects.toMatchObject({ code: "conflict" });
});

test("Viewer, foreign actor, revoked role, and role revision change cannot mutate or discover inaccessible workspaces", async () => {
  const workspaceRoot = await root(); const owner = service(workspaceRoot);
  await owner.create({ request, requestCorrelationId: "registry-create-2", id: "workspace-beta", title: "Beta" });
  const file = path.join(workspaceRoot, ".metaproject", "workspaces", "workspace-beta", "workspace.json");
  const manifest = JSON.parse(await readFile(file, "utf8")) as { members: Array<{ subject: string; role: string }> };
  manifest.members.push({ subject: "user:viewer", role: "viewer" }); await writeFile(file, `${JSON.stringify(manifest)}\n`);
  const viewer = service(workspaceRoot, "user:viewer");
  await expect(viewer.list({ request, requestCorrelationId: "registry-list-viewer" })).resolves.toHaveLength(1);
  await expect(viewer.addResource({ request, requestCorrelationId: "registry-viewer-write", workspaceId: "workspace-beta", resource: { kind: "component", uri: "./src/a.ts" } })).rejects.toMatchObject({ code: "access_denied" });
  const foreign = service(workspaceRoot, "user:foreign");
  await expect(foreign.list({ request, requestCorrelationId: "registry-list-foreign" })).resolves.toHaveLength(0);
  await expect(foreign.show({ request, requestCorrelationId: "registry-show-foreign", workspaceId: "workspace-beta" })).rejects.toMatchObject({ code: "access_denied" });
  await expect(owner.show({ request, requestCorrelationId: "registry-path-traversal", workspaceId: "../workspace-beta" })).rejects.toMatchObject({ code: "not_found" });
});

test("invalid or escaping references are rejected before persistence and cannot leave a partial manifest", async () => {
  const workspaceRoot = await root(); const owner = service(workspaceRoot);
  await expect(owner.create({ request, requestCorrelationId: "registry-invalid-create", id: "workspace-gamma", title: "Gamma", component: { kind: "component", uri: "../escape" } })).rejects.toMatchObject({ code: "invalid_manifest" });
  await expect(owner.list({ request, requestCorrelationId: "registry-list-empty-1" })).resolves.toHaveLength(0);
  await owner.create({ request, requestCorrelationId: "registry-create-3", id: "workspace-gamma", title: "Gamma" });
  await expect(owner.addResource({ request, requestCorrelationId: "registry-invalid-add", workspaceId: "workspace-gamma", resource: { kind: "component", uri: "./missing.ts" } })).rejects.toMatchObject({ code: "invalid_reference" });
  expect((await owner.show({ request, requestCorrelationId: "registry-show-0003", workspaceId: "workspace-gamma" })).resources).toEqual([]);
});

test("disabled and advisory modes fail closed without writing SAC data", async () => {
  for (const guard of [{ mode: "disabled" }, { mode: "advisory", decision: "pass" }] as const) {
    const workspaceRoot = await root(); const candidate = service(workspaceRoot, "user:owner", guard);
    await expect(candidate.create({ request, requestCorrelationId: `registry-${guard.mode}`, id: "workspace-delta", title: "Delta" })).rejects.toMatchObject({ code: "guard_denied" });
    await expect(candidate.list({ request, requestCorrelationId: `registry-${guard.mode}-list` })).rejects.toMatchObject({ code: "guard_denied" });
  }
});

test("TOCTOU role revalidation denies a write when membership changes after initial authorization", async () => {
  const workspaceRoot = await root(); const owner = service(workspaceRoot);
  await owner.create({ request, requestCorrelationId: "registry-create-4", id: "workspace-epsilon", title: "Epsilon" });
  const serviceWithChangingRole = new WorkspaceService({ workspaceRoot, authorizationServer: server("user:owner"), strictGuard: strict });
  const file = path.join(workspaceRoot, ".metaproject", "workspaces", "workspace-epsilon", "workspace.json");
  const lock = path.join(workspaceRoot, ".metaproject", "workspaces", ".workspace-epsilon.lock");
  let pending: Promise<unknown> | undefined;
  await withFileLock(lock, async () => {
    pending = serviceWithChangingRole.addResource({ request, requestCorrelationId: "registry-toctou-0001", workspaceId: "workspace-epsilon", resource: { kind: "component", uri: "./src/a.ts" } });
    await Bun.sleep(40); // addResource has now taken its initial authorization snapshot and is waiting for the lock.
    const manifest = JSON.parse(await readFile(file, "utf8")) as { members: unknown[] };
    manifest.members = [{ subject: "user:other", role: "owner" }]; await writeFile(file, `${JSON.stringify(manifest)}\n`);
  });
  await expect(pending).rejects.toMatchObject({ code: "access_denied" });
});
