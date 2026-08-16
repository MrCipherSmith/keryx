import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSacAuthorizationServer } from "./index";
import { WorkspaceService, localWorkspaceAuthorizationServer, resolveWorkspaceForActor } from "./workspace-service";
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
  const manifest = JSON.parse(await readFile(file, "utf8")) as { members: Array<{ subject: string; role: "owner" | "editor" | "viewer" }> };
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

// --- WSL-1..4 lifecycle completion (archive / removeResource / rename / list --include-archived) ---
// See docs/requirements/sac-workspace-lifecycle/specification.md.

test("archive is owner-only (editor/viewer denied access_denied); sets status archived, bumps updatedAt, and leaves title/id/resources/members otherwise unchanged", async () => {
  const workspaceRoot = await root(); const owner = service(workspaceRoot);
  const created = await owner.create({ request, requestCorrelationId: "registry-archive-create-0001", id: "workspace-archive-alpha", title: "Archive Alpha", component: { kind: "component", uri: "./src/a.ts" } });
  const file = path.join(workspaceRoot, ".metaproject", "workspaces", created.id, "workspace.json");
  const manifest = JSON.parse(await readFile(file, "utf8")) as { members: Array<{ subject: string; role: "owner" | "editor" | "viewer" }> };
  manifest.members.push({ subject: "user:editor", role: "editor" }, { subject: "user:viewer", role: "viewer" });
  await writeFile(file, `${JSON.stringify(manifest)}\n`);
  const editor = service(workspaceRoot, "user:editor"); const viewer = service(workspaceRoot, "user:viewer");
  await expect(editor.archive({ request, requestCorrelationId: "registry-archive-editor-0001", workspaceId: created.id })).rejects.toMatchObject({ code: "access_denied" });
  await expect(viewer.archive({ request, requestCorrelationId: "registry-archive-viewer-0001", workspaceId: created.id })).rejects.toMatchObject({ code: "access_denied" });
  const archived = await owner.archive({ request, requestCorrelationId: "registry-archive-owner-0001", workspaceId: created.id });
  expect(archived.status).toBe("archived");
  expect(archived.updatedAt).not.toBe(created.updatedAt);
  expect(archived.id).toBe(created.id);
  expect(archived.title).toBe(created.title);
  expect(archived.resources).toEqual(created.resources);
  expect(archived.members).toEqual(manifest.members);
});

test("archive is intentionally idempotent: archiving an already-archived workspace succeeds again (not a conflict), keeps status archived, and only bumps updatedAt", async () => {
  const workspaceRoot = await root(); const owner = service(workspaceRoot);
  const created = await owner.create({ request, requestCorrelationId: "registry-archive-repeat-create-0001", id: "workspace-archive-repeat", title: "Archive Repeat" });
  const first = await owner.archive({ request, requestCorrelationId: "registry-archive-repeat-0001", workspaceId: created.id });
  expect(first.status).toBe("archived");
  await Bun.sleep(5);
  const second = await owner.archive({ request, requestCorrelationId: "registry-archive-repeat-0002", workspaceId: created.id });
  expect(second.status).toBe("archived");
  expect(second.id).toBe(first.id);
  expect(second.title).toBe(first.title);
  expect(second.resources).toEqual(first.resources);
  expect(second.members).toEqual(first.members);
  expect(second.updatedAt).not.toBe(first.updatedAt);
});

test("removeResource is owner-only (editor denied access_denied), not_found when uri is absent, and removes exactly the targeted resource while bumping updatedAt", async () => {
  const workspaceRoot = await root(); const owner = service(workspaceRoot);
  const created = await owner.create({ request, requestCorrelationId: "registry-remove-create-0001", id: "workspace-remove-alpha", title: "Remove Alpha", component: { kind: "component", uri: "./src/a.ts" } });
  const withB = await owner.addResource({ request, requestCorrelationId: "registry-remove-add-0001", workspaceId: created.id, resource: { kind: "component", uri: "./src/b.ts" } });
  expect(withB.resources.map((resource) => resource.uri)).toEqual(["./src/a.ts", "./src/b.ts"]);
  const file = path.join(workspaceRoot, ".metaproject", "workspaces", created.id, "workspace.json");
  const manifest = JSON.parse(await readFile(file, "utf8")) as { members: Array<{ subject: string; role: "owner" | "editor" | "viewer" }> };
  manifest.members.push({ subject: "user:editor", role: "editor" });
  await writeFile(file, `${JSON.stringify(manifest)}\n`);
  const editor = service(workspaceRoot, "user:editor");
  await expect(editor.removeResource({ request, requestCorrelationId: "registry-remove-editor-0001", workspaceId: created.id, uri: "./src/b.ts" })).rejects.toMatchObject({ code: "access_denied" });
  await expect(owner.removeResource({ request, requestCorrelationId: "registry-remove-missing-0001", workspaceId: created.id, uri: "./src/missing.ts" })).rejects.toMatchObject({ code: "not_found" });
  const removed = await owner.removeResource({ request, requestCorrelationId: "registry-remove-owner-0001", workspaceId: created.id, uri: "./src/a.ts" });
  expect(removed.resources.map((resource: { uri: string }) => resource.uri)).toEqual(["./src/b.ts"]);
  expect(removed.updatedAt).not.toBe(withB.updatedAt);
  expect(removed.id).toBe(created.id);
  expect(removed.title).toBe(created.title);
  expect(removed.members).toEqual(manifest.members);
});

test("rename is owner-only (editor denied access_denied) and updates only title and updatedAt, visible immediately via show", async () => {
  const workspaceRoot = await root(); const owner = service(workspaceRoot);
  const created = await owner.create({ request, requestCorrelationId: "registry-rename-create-0001", id: "workspace-rename-alpha", title: "Original Title", component: { kind: "component", uri: "./src/a.ts" } });
  const file = path.join(workspaceRoot, ".metaproject", "workspaces", created.id, "workspace.json");
  const manifest = JSON.parse(await readFile(file, "utf8")) as { members: Array<{ subject: string; role: "owner" | "editor" | "viewer" }> };
  manifest.members.push({ subject: "user:editor", role: "editor" });
  await writeFile(file, `${JSON.stringify(manifest)}\n`);
  const editor = service(workspaceRoot, "user:editor");
  await expect(editor.rename({ request, requestCorrelationId: "registry-rename-editor-0001", workspaceId: created.id, title: "Hijacked" })).rejects.toMatchObject({ code: "access_denied" });
  const renamed = await owner.rename({ request, requestCorrelationId: "registry-rename-owner-0001", workspaceId: created.id, title: "New Title" });
  expect(renamed.title).toBe("New Title");
  expect(renamed.updatedAt).not.toBe(created.updatedAt);
  expect(renamed.id).toBe(created.id);
  expect(renamed.resources).toEqual(created.resources);
  expect(renamed.members).toEqual(manifest.members);
  expect((await owner.show({ request, requestCorrelationId: "registry-rename-show-0001", workspaceId: created.id })).title).toBe("New Title");
});

test("list excludes archived workspaces by default, includes them with includeArchived: true, and never discloses a workspace to an actor without any role", async () => {
  const workspaceRoot = await root(); const owner = service(workspaceRoot);
  const active = await owner.create({ request, requestCorrelationId: "registry-list-active-0001", id: "workspace-list-active", title: "Active" });
  const toArchive = await owner.create({ request, requestCorrelationId: "registry-list-toarchive-0001", id: "workspace-list-toarchive", title: "ToArchive" });
  await owner.archive({ request, requestCorrelationId: "registry-list-archive-0001", workspaceId: toArchive.id });
  const defaultList = await owner.list({ request, requestCorrelationId: "registry-list-default-0001" });
  expect(defaultList.map((workspace) => workspace.id)).toEqual([active.id]);
  const explicitFalse = await owner.list({ request, requestCorrelationId: "registry-list-explicitfalse-0001", includeArchived: false });
  expect(explicitFalse.map((workspace) => workspace.id)).toEqual([active.id]);
  const withArchived = await owner.list({ request, requestCorrelationId: "registry-list-witharchived-0001", includeArchived: true });
  expect(withArchived.map((workspace) => workspace.id).sort()).toEqual([active.id, toArchive.id].sort());
  const foreign = service(workspaceRoot, "user:foreign");
  await expect(foreign.list({ request, requestCorrelationId: "registry-list-foreign-0001", includeArchived: true })).resolves.toHaveLength(0);
});

test("addResource against an already-archived workspace is rejected with guard_denied even for an otherwise-authorized owner", async () => {
  const workspaceRoot = await root(); const owner = service(workspaceRoot);
  const created = await owner.create({ request, requestCorrelationId: "registry-archived-addresource-create-0001", id: "workspace-archived-add", title: "Archived Add" });
  await owner.archive({ request, requestCorrelationId: "registry-archived-addresource-archive-0001", workspaceId: created.id });
  await expect(owner.addResource({ request, requestCorrelationId: "registry-archived-addresource-attempt-0001", workspaceId: created.id, resource: { kind: "component", uri: "./src/a.ts" } })).rejects.toMatchObject({ code: "guard_denied" });
});

test("show on an archived workspace still succeeds for a role-visible actor — archive changes discovery via list, not direct read", async () => {
  const workspaceRoot = await root(); const owner = service(workspaceRoot);
  const created = await owner.create({ request, requestCorrelationId: "registry-archived-show-create-0001", id: "workspace-archived-show", title: "Archived Show" });
  await owner.archive({ request, requestCorrelationId: "registry-archived-show-archive-0001", workspaceId: created.id });
  const shown = await owner.show({ request, requestCorrelationId: "registry-archived-show-attempt-0001", workspaceId: created.id });
  expect(shown.status).toBe("archived");
  expect(shown.id).toBe(created.id);
});

// --- SLATE-15 `resolveWorkspaceForActor` (flow 161, T10 — AC1) ------------
//
// RED: `resolveWorkspaceForActor` does not exist yet (T11 adds it). Pins the
// shared fail-closed `--workspace` validation helper `/goal` (shell.ts,
// tui-shell.ts) and `keryx harness run --workspace` (harness.ts) both reuse —
// see the tests-creator dispatch brief: "a shared helper — design it once,
// use it in both places". Chosen home: `src/sac/workspace-service.ts`
// (exported alongside `WorkspaceService`/`localWorkspaceAuthorizationServer`,
// the exact construction `commands/workspace.ts`'s `service()` already uses).
//
// PINNED API:
//   export async function resolveWorkspaceForActor(
//     cwd: string,
//     workspaceId: string,
//   ): Promise<
//     | { ok: true; manifest: WorkspaceManifest }
//     | { ok: false; error: WorkspaceServiceError }
//   >;
// NEVER throws (fail-closed callers must not need a try/catch of their own —
// `/goal`'s AC1 ordering requires checking `.ok` before doing anything else,
// including opening a slate). Constructs its OWN `WorkspaceService` per call,
// with `workspaceRoot: cwd`, `localWorkspaceAuthorizationServer()`, and the
// same `strictGuard: { mode: "strict", availability: "available", decision:
// "pass", policyRevision: "local-offline-v1" }` literal `commands/
// workspace.ts`'s `service()` uses verbatim.
test("resolveWorkspaceForActor: an existing, actor-owned workspace resolves ok:true with the real manifest", async () => {
  const workspaceRoot = await root();
  // Build the workspace with the SAME actor `resolveWorkspaceForActor` itself
  // uses internally (`localWorkspaceAuthorizationServer()`) so the created
  // workspace is genuinely visible to it — not a foreign-owner fixture.
  const localOwner = new WorkspaceService({
    workspaceRoot,
    authorizationServer: localWorkspaceAuthorizationServer(),
    strictGuard: strict,
  });
  const created = await localOwner.create({
    request: undefined,
    requestCorrelationId: "resolve-actor-ok-0001",
    id: "workspace-resolve-ok",
    title: "Resolve OK",
  });

  const result = await resolveWorkspaceForActor(workspaceRoot, created.id);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.manifest.id).toBe(created.id);
    expect(result.manifest.title).toBe("Resolve OK");
  }
});

test("resolveWorkspaceForActor: a nonexistent workspace id resolves ok:false with code not_found — never throws", async () => {
  const workspaceRoot = await root();
  const result = await resolveWorkspaceForActor(workspaceRoot, "definitely-does-not-exist-workspace");
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.code).toBe("not_found");
  }
});

test("resolveWorkspaceForActor: a malformed workspace id (fails the id regex) resolves ok:false with code not_found — never throws", async () => {
  const workspaceRoot = await root();
  const result = await resolveWorkspaceForActor(workspaceRoot, "Not A Valid Id !!");
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.code).toBe("not_found");
  }
});

test("resolveWorkspaceForActor: a workspace that exists but has no visible role for this actor resolves ok:false with code access_denied — never throws", async () => {
  const workspaceRoot = await root();
  // Created by a DIFFERENT subject than the local actor `resolveWorkspaceForActor`
  // resolves to internally — the local actor has no membership entry at all.
  const foreignOwner = service(workspaceRoot, "user:someone-else");
  const created = await foreignOwner.create({
    request,
    requestCorrelationId: "resolve-actor-denied-0001",
    id: "workspace-resolve-denied",
    title: "Resolve Denied",
  });
  const result = await resolveWorkspaceForActor(workspaceRoot, created.id);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.code).toBe("access_denied");
  }
});
