import { describe, expect, test } from "bun:test";
import type { CodeRevision, GitDeliveryAdapter, HubConfig, Principal, Project } from "./contracts";
import { hubMutate, hubRead } from "./domain";
import type { HubState } from "./store";

const human: Principal = { id: "human:operator", kind: "human", role: "operator" };
const agent: Principal = { id: "agent:connector", kind: "agent", role: "agent" };
const config: HubConfig = { dataDir: "/unused", operatorToken: "operator", agentToken: "agent" };
function fixture() {
  const project: Project = { id: "project", name: "Keryx", version: 1, lineRevisionId: null, lineVersion: 0, contextRevision: 0 };
  const state: HubState = { projects: [project], documents: [], proposals: [], flows: [], evidence: [], revisions: [], deliveries: [], events: [], documentChanges: [], sessions: {}, replays: {} };
  let adapterCalls = 0;
  const adapter: GitDeliveryAdapter = async () => { adapterCalls++; return { status: "published", branch: "managed", commitSha: "b".repeat(40), treeSha: "c".repeat(40) }; };
  const mutate = (route: string, body: unknown, actor = human) => hubMutate(state, actor, ["projects", project.id, route], body, config, adapter, "operation");
  const create = async (purpose?: unknown, baseRevisionId: string | null = null) => await mutate("revisions", { baseRevisionId, gitBaseSha: "a".repeat(40), message: "review candidate", ...(purpose === undefined ? {} : { purpose }), changes: [{ path: "changes.patch", contentBase64: Buffer.from("review only").toString("base64") }] }, agent) as CodeRevision;
  return { project, state, mutate, create, adapterCalls: () => adapterCalls };
}

describe("review bundles are evidence subjects, never integration snapshots", () => {
  test("stores and reads an explicitly marked immutable review bundle", async () => {
    const f = fixture();
    const revision = await f.create("review-bundle");
    expect(revision).toHaveProperty("purpose", "review-bundle");
    expect(hubRead(f.state, ["projects", f.project.id, "revisions", revision.id], new URL("http://hub.test"))).toEqual(revision);
    expect(revision.files[0]?.path).toBe("changes.patch");
  });

  test("agents cannot select lines and humans cannot select a review bundle", async () => {
    const f = fixture(); const revision = await f.create("review-bundle");
    const payload = { revisionId: revision.id, expectedVersion: 0 };
    await expect(f.mutate("line", payload, agent)).rejects.toMatchObject({ status: 403, code: "human-required" });
    const before = structuredClone(f.state);
    await expect(f.mutate("line", payload)).rejects.toMatchObject({ status: 409, code: "review-bundle-not-deliverable" });
    expect(f.state).toEqual(before);
  });

  test("rejects bundle delivery before adapter side effects, even for an already selected malformed line", async () => {
    const f = fixture(); const revision = await f.create("review-bundle");
    f.project.lineRevisionId = revision.id;
    const before = structuredClone(f.state);
    await expect(f.mutate("deliveries", { revisionId: revision.id, expectedLineVersion: 0, remoteUrl: "https://example.test/repo.git", baseBranch: "main" })).rejects.toMatchObject({ status: 409, code: "review-bundle-not-deliverable" });
    expect(f.adapterCalls()).toBe(0);
    expect(f.state).toEqual(before);
  });

  test("legacy revisions remain selectable and deliverable snapshots", async () => {
    const f = fixture(); const revision = await f.create();
    expect(revision).not.toHaveProperty("purpose");
    await f.mutate("line", { revisionId: revision.id, expectedVersion: 0 });
    expect(f.project.lineRevisionId).toBe(revision.id);
    await f.mutate("deliveries", { revisionId: revision.id, expectedLineVersion: 1, remoteUrl: "https://example.test/repo.git", baseBranch: "main" });
    expect(f.adapterCalls()).toBe(1);
    expect(f.state.deliveries[0]?.status).toBe("published");
  });

  test("rejects unknown purpose values rather than treating them as snapshots", async () => {
    const f = fixture();
    for (const purpose of ["attempt", "", null, 1, {}]) await expect(f.create(purpose)).rejects.toMatchObject({ status: 400, code: "invalid-purpose" });
    expect(f.state.revisions).toHaveLength(0);
  });

  test("incremental revisions cannot convert bundles into selectable snapshots", async () => {
    const f = fixture();
    const bundle = await f.create("review-bundle");
    const snapshot = await f.create();
    await expect(f.create("snapshot", bundle.id)).rejects.toMatchObject({ status: 409, code: "revision-purpose-conflict" });
    await expect(f.create(undefined, bundle.id)).rejects.toMatchObject({ status: 409, code: "revision-purpose-conflict" });
    await expect(f.create("review-bundle", snapshot.id)).rejects.toMatchObject({ status: 409, code: "revision-purpose-conflict" });
    const next = await f.create("review-bundle", bundle.id);
    expect(next).toHaveProperty("purpose", "review-bundle");
    const explicitSnapshot = await f.create("snapshot", snapshot.id);
    expect(explicitSnapshot).toHaveProperty("purpose", "snapshot");
  });
});
