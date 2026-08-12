import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CollaborationService } from "./collaboration-service";
import { WorkspaceService, localWorkspaceAuthorizationServer } from "./workspace-service";

test("collaboration activity is owner-only, append-only, and rejects content-bearing fields", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sac-collab-")); await mkdir(path.join(root, "worktree"));
  const server = localWorkspaceAuthorizationServer("user:owner"); const workspaces = new WorkspaceService({ workspaceRoot: root, authorizationServer: server, strictGuard: { mode: "strict", availability: "available", decision: "pass", policyRevision: "p1" } });
  await workspaces.create({ request: undefined, requestCorrelationId: "collaboration-create-0001", id: "workspace-a", title: "A", component: { kind: "worktree", uri: "./worktree" } });
  const service = new CollaborationService({ workspaceRoot: root, workspaces, authorizationServer: server });
  await service.record({ request: undefined, requestCorrelationId: "collaboration-record-0001", workspaceId: "workspace-a", activity: { kind: "reference-added", reference: { kind: "worktree", uri: "./worktree" } } });
  expect((await service.overview({ request: undefined, requestCorrelationId: "collaboration-read-0001", workspaceId: "workspace-a" })).activity).toHaveLength(1);
  await expect(service.record({ request: undefined, requestCorrelationId: "collaboration-record-0002", workspaceId: "workspace-a", activity: { kind: "handoff-recorded", transcript: "no" } as any })).rejects.toThrow("forbidden");
  const activityPath = path.join(root, ".metaproject", "workspaces", "workspace-a", "activity.jsonl"); expect((await (await import("node:fs/promises")).readFile(activityPath, "utf8")).split("\n").filter(Boolean)).toHaveLength(1);
});
